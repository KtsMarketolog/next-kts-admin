import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { AdminSession } from '../adminAuth';
import { getAdminSessionSecret } from '../authSecret';
import { assertKnowledgeBaseId, assertKnowledgeBaseRevision, assertKnowledgeBaseUuid, knowledgeBaseInvalid,
  KnowledgeBaseError, KNOWLEDGE_BASE_MAX_DEPTH } from '../knowledgeBase';
import type { KnowledgeBaseDeleteCommit, KnowledgeBaseDeleteCounts, KnowledgeBaseDeleteInput,
  KnowledgeBaseDeletePreview, KnowledgeBaseDeleteResult } from '../knowledgeBaseDeletion';
import { assertKnowledgeBaseManage, mapKnowledgeBaseNode, requireKnowledgeBasePath, withKnowledgeBase,
  type KnowledgeBaseContext } from './knowledgeBaseRepo.shared';
import { processKnowledgeBaseDeletionCleanup } from './knowledgeBaseDeletionCleanup';

const MAX_DELETE_NODES = 10_000;
const stalePreview = () => new KnowledgeBaseError(409, 'DELETE_PREVIEW_STALE',
  'Материал или содержимое папки уже изменились. Обновите список и подтвердите удаление заново.');
type SubtreeRow = {
  id: string; parent_id: string | null; kind: 'file' | 'folder'; title: string; revision: string; archived_at: Date | null;
  file_size: string | null; storage_path: string | null; sha256: string | null; acl_fingerprint: string; depth: number; cycle: boolean;
};
type OperationRow = { id: string; operation_digest: string; node_id: string; affected_count: number;
  file_count: number; folder_count: number; total_bytes: string };

function validateInput(id: number, input: KnowledgeBaseDeleteInput) {
  assertKnowledgeBaseId(id); assertKnowledgeBaseRevision(input.expectedRevision);
}
const counts = (rows: SubtreeRow[]): KnowledgeBaseDeleteCounts => ({ affectedCount: rows.length,
  fileCount: rows.filter(row => row.kind === 'file').length, folderCount: rows.filter(row => row.kind === 'folder').length,
  totalBytes: rows.reduce((sum, row) => sum + Number(row.file_size ?? 0), 0) });

async function planDeletion(context: KnowledgeBaseContext, id: number, input: KnowledgeBaseDeleteInput) {
  assertKnowledgeBaseManage(context);
  const path = await requireKnowledgeBasePath(context, id, true);
  const source = path.at(-1)!;
  if (source.revision !== input.expectedRevision) throw stalePreview();
  if (!path.some(row => row.archived_at)) {
    throw new KnowledgeBaseError(400, 'ARCHIVE_REQUIRED', 'Сначала перенесите материал в архив. Удаление доступно только из архива.');
  }
  const result = await context.client.query<SubtreeRow>(`with recursive subtree as (
    select id,1 as depth,array[id] as visited,false as cycle from knowledge_base_nodes where id=$1 and deleted_at is null
    union all select child.id,tree.depth+1,tree.visited||child.id,child.id=any(tree.visited)
      from subtree tree join knowledge_base_nodes child on child.parent_id=tree.id
      where child.deleted_at is null and not tree.cycle and tree.depth<$2
  ), bounded as (select id,depth,cycle from subtree limit $3)
  select n.id::text,n.parent_id::text,n.kind,n.title,n.revision::text,n.archived_at,n.file_size::text,n.storage_path,n.sha256,
    b.depth,b.cycle,(select encode(sha256(convert_to(coalesce(string_agg(g.actor_key,',' order by g.actor_key),''),'UTF8')),'hex')
      from knowledge_base_grants g where g.node_id=n.id) as acl_fingerprint
  from bounded b join knowledge_base_nodes n on n.id=b.id order by n.id`, [id, KNOWLEDGE_BASE_MAX_DEPTH + 2, MAX_DELETE_NODES + 1]);
  const subtree = result.rows;
  if (subtree.length > MAX_DELETE_NODES) throw new KnowledgeBaseError(413, 'DELETE_TOO_LARGE',
    'В папке больше 10 000 материалов. Удалите вложенные папки отдельными операциями.');
  const kinds = new Map(subtree.map(row => [row.id, row.kind]));
  if (subtree.some(row => row.cycle || (row.parent_id !== null && kinds.get(row.parent_id) === 'file')
    || row.depth > KNOWLEDGE_BASE_MAX_DEPTH + (row.kind === 'file' ? 1 : 0))) {
    throw new KnowledgeBaseError(400, 'INVALID_TREE', 'Структура папки повреждена. Удаление отменено.');
  }
  // A server signature binds the precise subtree, current ancestors and the authenticated session.
  // Unchanged root revision alone is insufficient: descendants may have been added or moved.
  const previewToken = createHmac('sha256', getAdminSessionSecret()).update('knowledge-base-delete:v1:')
    .update(JSON.stringify({ actorKey: context.actorKey, sessionId: context.session.sessionId, id, path, subtree })).digest('hex');
  return { source, subtree, previewToken, counts: counts(subtree) };
}

export async function previewKnowledgeBaseDeletion(session: AdminSession, id: number, input: KnowledgeBaseDeleteInput): Promise<KnowledgeBaseDeletePreview> {
  validateInput(id, input);
  return withKnowledgeBase(session, 'read', async context => {
    const plan = await planDeletion(context, id, input);
    return { source: mapKnowledgeBaseNode(plan.source, true), previewToken: plan.previewToken, ...plan.counts };
  });
}

function fromOperation(row: OperationRow): KnowledgeBaseDeleteResult {
  return { deleted: true, nodeId: Number(row.node_id), affectedCount: row.affected_count, fileCount: row.file_count,
    folderCount: row.folder_count, totalBytes: Number(row.total_bytes), cleanupPending: row.file_count > 0 };
}

export async function deleteKnowledgeBaseNode(session: AdminSession, id: number, input: KnowledgeBaseDeleteCommit): Promise<KnowledgeBaseDeleteResult> {
  validateInput(id, input); assertKnowledgeBaseUuid(input.operationId);
  if (typeof input.previewToken !== 'string' || !/^[0-9a-f]{64}$/.test(input.previewToken)
    || typeof input.confirmationTitle !== 'string' || input.confirmationTitle.length > 200) throw knowledgeBaseInvalid();
  const digest = createHash('sha256').update(JSON.stringify({ id, expectedRevision: input.expectedRevision,
    previewToken: input.previewToken, confirmationTitle: input.confirmationTitle })).digest('hex');
  const operation = await withKnowledgeBase(session, 'write', async context => {
    const existing = await context.client.query<OperationRow>(`select id::text,operation_digest,node_id::text,affected_count,
      file_count,folder_count,total_bytes::text from knowledge_base_deletions where actor_key=$1 and operation_id=$2::uuid`,
    [context.actorKey, input.operationId]);
    if (existing.rows[0]) {
      if (existing.rows[0].operation_digest !== digest) throw new KnowledgeBaseError(409, 'OPERATION_CONFLICT', 'Этот запрос удаления уже использован. Обновите список.');
      return existing.rows[0];
    }
    const plan = await planDeletion(context, id, input).catch(error => {
      if (error instanceof KnowledgeBaseError && [400, 404, 413].includes(error.status)) throw stalePreview();
      throw error;
    });
    if (!timingSafeEqual(Buffer.from(plan.previewToken, 'hex'), Buffer.from(input.previewToken, 'hex'))) throw stalePreview();
    if (input.confirmationTitle !== plan.source.title) {
      throw new KnowledgeBaseError(400, 'DELETE_CONFIRMATION_REQUIRED', 'Для подтверждения введите точное название материала.');
    }
    const inserted = await context.client.query<OperationRow>(`insert into knowledge_base_deletions
      (actor_key,actor_role,operation_id,operation_digest,node_id,title,affected_count,file_count,folder_count,total_bytes)
      values($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10)
      returning id::text,operation_digest,node_id::text,affected_count,file_count,folder_count,total_bytes::text`,
    [context.actorKey, session.role, input.operationId, digest, id, plan.source.title, plan.counts.affectedCount,
      plan.counts.fileCount, plan.counts.folderCount, plan.counts.totalBytes]);
    // Own archive markers also keep legacy readers closed if an older application release is restored.
    const changed = await context.client.query(`update knowledge_base_nodes set deleted_at=clock_timestamp(),deleted_by=$2,archived_at=coalesce(archived_at,clock_timestamp()),
      revision=revision+1,updated_at=clock_timestamp() where id=any($1::bigint[]) and deleted_at is null`,
    [plan.subtree.map(row => row.id), context.actorKey]);
    if (changed.rowCount !== plan.subtree.length) throw stalePreview();
    await context.client.query(`insert into knowledge_base_file_deletions(node_id,deletion_id,storage_path,file_size,sha256)
      select id,$2::bigint,storage_path,file_size,sha256 from knowledge_base_nodes
      where id=any($1::bigint[]) and kind='file'`, [plan.subtree.map(row => row.id), inserted.rows[0].id]);
    return inserted.rows[0];
  });
  // Confirmation is already durable. Failure here only leaves a retriable cleanup job, never a failed user operation.
  const cleanup = await processKnowledgeBaseDeletionCleanup({ deletionId: operation.id, limit: 5, budgetMs: 1_000 });
  return { ...fromOperation(operation), cleanupPending: cleanup.pending };
}
