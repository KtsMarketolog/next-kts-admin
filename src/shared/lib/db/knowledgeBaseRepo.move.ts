import { createHash, timingSafeEqual } from 'node:crypto';
import type { AdminSession } from '../adminAuth';
import { assertKnowledgeBaseId, assertKnowledgeBaseRevision, knowledgeBaseInvalid, KnowledgeBaseError,
  KNOWLEDGE_BASE_MAX_DEPTH, type KnowledgeBaseMoveCommit, type KnowledgeBaseMoveInput, type KnowledgeBaseMovePreview } from '../knowledgeBase';
import { assertKnowledgeBaseManage, mapKnowledgeBaseNode, readKnowledgeBaseRow, requireKnowledgeBasePath,
  withKnowledgeBase, type KnowledgeBaseContext, type KnowledgeBaseRow } from './knowledgeBaseRepo.shared';

// Bound application memory even for a very broad tree. ACLs are hashed per node in PostgreSQL,
// not expanded into up to 1,000 recipient strings for every descendant in the response.
const MAX_MOVE_NODES = 10_000;
const stalePreview = () => new KnowledgeBaseError(409, 'MOVE_PREVIEW_STALE',
  'Материал, папка назначения или права уже изменились. Обновите список и подтвердите перенос заново.');
const invalidMove = (code: string, message: string) => new KnowledgeBaseError(400, code, message);
type SubtreeRow = {
  id: string; parent_id: string | null; kind: 'folder' | 'file'; title: string; revision: string;
  archived_at: Date | null; acl_mode: string; acl_fingerprint: string; depth: number; cycle: boolean;
  original_name: string | null; mime_type: string | null; file_size: string | null;
  storage_path: string | null; sha256: string | null; operation_digest: string;
};

function validateInput(id: number, input: KnowledgeBaseMoveInput) {
  assertKnowledgeBaseId(id); assertKnowledgeBaseRevision(input.expectedRevision);
  if (input.targetParentId !== null) assertKnowledgeBaseId(input.targetParentId);
}

async function readSubtree(context: KnowledgeBaseContext, id: number) {
  const result = await context.client.query<SubtreeRow>(`with recursive subtree as (
    select id,1 as depth,array[id] as visited,false as cycle from knowledge_base_nodes where id=$1
    union all select child.id,tree.depth+1,tree.visited||child.id,child.id=any(tree.visited)
      from subtree tree join knowledge_base_nodes child on child.parent_id=tree.id
      where not tree.cycle and tree.depth<$2
  ), bounded as (select id,depth,cycle from subtree limit $3)
  select n.id::text,n.parent_id::text,n.kind,n.title,n.revision::text,n.archived_at,n.acl_mode,
    n.original_name,n.mime_type,n.file_size::text,n.storage_path,n.sha256,n.operation_digest,b.depth,b.cycle,
    (select encode(sha256(convert_to(coalesce(string_agg(g.actor_key,',' order by g.actor_key),''),'UTF8')),'hex')
      from knowledge_base_grants g where g.node_id=n.id) as acl_fingerprint
  from bounded b join knowledge_base_nodes n on n.id=b.id order by n.id`,
  [id, KNOWLEDGE_BASE_MAX_DEPTH + 2, MAX_MOVE_NODES + 1]);
  if (result.rows.length > MAX_MOVE_NODES) throw new KnowledgeBaseError(413, 'MOVE_TOO_LARGE',
    'В папке больше 10 000 материалов. Перенесите вложенные папки отдельными операциями.');
  const kinds = new Map(result.rows.map(row => [row.id, row.kind]));
  if (result.rows.some(row => row.cycle || (row.parent_id !== null && kinds.get(row.parent_id) === 'file')
    || row.depth > KNOWLEDGE_BASE_MAX_DEPTH + (row.kind === 'file' ? 1 : 0))) {
    throw invalidMove('INVALID_TREE', 'Структура папки повреждена или превышает допустимую глубину. Перенос отменён.');
  }
  return result.rows;
}

function effectiveRecipients(path: KnowledgeBaseRow[]) {
  let keys: string[] | undefined;
  for (const row of path) {
    if (row.acl_mode === 'custom') keys = keys === undefined ? [...row.actor_keys] : keys.filter(key => row.actor_keys.includes(key));
  }
  // Preserve raw grants, including inactive/deleted employees: moving is not an ACL cleanup.
  return (keys ?? []).sort();
}

async function planMove(context: KnowledgeBaseContext, id: number, input: KnowledgeBaseMoveInput) {
  assertKnowledgeBaseManage(context);
  const sourcePath = await requireKnowledgeBasePath(context, id);
  const source = sourcePath.at(-1)!;
  if (source.revision !== input.expectedRevision) throw stalePreview();
  if (input.targetParentId === id) throw invalidMove('MOVE_CYCLE', 'Нельзя переместить папку в саму себя.');
  if ((source.parent_id === null ? null : Number(source.parent_id)) === input.targetParentId) {
    throw invalidMove('SAME_PARENT', 'Материал уже находится в этой папке.');
  }
  if (input.targetParentId === null && source.kind === 'file') throw invalidMove('PARENT_REQUIRED', 'Для файла нужно выбрать папку назначения.');
  const destinationPath = input.targetParentId === null ? [] : await requireKnowledgeBasePath(context, input.targetParentId);
  const destination = destinationPath.at(-1) ?? null;
  if (destination && destination.kind !== 'folder') throw invalidMove('NOT_A_FOLDER', 'Выберите папку назначения, а не файл.');
  if (destinationPath.some(row => row.id === source.id)) throw invalidMove('MOVE_CYCLE', 'Нельзя переместить папку внутрь её вложенной папки.');
  const subtree = await readSubtree(context, id);
  if (subtree.some(row => destinationPath.length + row.depth > KNOWLEDGE_BASE_MAX_DEPTH + (row.kind === 'file' ? 1 : 0))) {
    throw invalidMove('MAX_DEPTH', 'После переноса будет больше 12 уровней папок, включая архивные вложенные папки.');
  }
  const rootRecipients = input.targetParentId === null && source.acl_mode === 'inherit' ? effectiveRecipients(sourcePath) : null;
  const accessWarning = rootRecipients !== null
    ? 'Папка будет перемещена в корень. Текущий доступ по всей цепочке родительских папок будет сохранён отдельным списком сотрудников; собственные ограничения вложенных материалов сохранятся. Изменения прав прежней родительской папки больше не будут влиять на эту папку.'
    : input.targetParentId === null
      ? 'Папка будет перемещена в корень с её собственным списком доступа. Ограничения прежних родительских папок перестанут действовать: часть сотрудников может получить доступ к папке и вложенным материалам. Собственные ограничения вложенных материалов сохранятся.'
      : 'После переноса доступ к материалу и всем вложенным материалам будет зависеть от прав папки назначения. Часть сотрудников может получить или потерять доступ. Собственные списки доступа и ограничения вложенных материалов сохранятся.';
  const previewToken = createHash('sha256').update(JSON.stringify({ version: 1, actorKey: context.actorKey,
    id, targetParentId: input.targetParentId, sourcePath, destinationPath, subtree })).digest('hex');
  return { source, destination, destinationPath, subtree, rootRecipients, accessWarning, previewToken };
}

export async function previewKnowledgeBaseMove(session: AdminSession, id: number, input: KnowledgeBaseMoveInput): Promise<KnowledgeBaseMovePreview> {
  validateInput(id, input);
  return withKnowledgeBase(session, 'read', async context => {
    const plan = await planMove(context, id, input);
    return { source: mapKnowledgeBaseNode(plan.source, true),
      destination: plan.destination ? mapKnowledgeBaseNode(plan.destination, true) : null,
      destinationBreadcrumbs: plan.destinationPath.map(row => mapKnowledgeBaseNode(row, true)),
      previewToken: plan.previewToken, affectedCount: plan.subtree.length, accessWarning: plan.accessWarning };
  });
}

export async function moveKnowledgeBaseNode(session: AdminSession, id: number, input: KnowledgeBaseMoveCommit) {
  validateInput(id, input);
  if (typeof input.previewToken !== 'string' || !/^[0-9a-f]{64}$/.test(input.previewToken)) throw knowledgeBaseInvalid();
  return withKnowledgeBase(session, 'write', async context => {
    const plan = await planMove(context, id, input).catch(error => {
      // An archived/moved destination or a newly added deep descendant also invalidates a preview.
      // Input shape and session checks happen outside this conversion; never hide access failures.
      if (error instanceof KnowledgeBaseError && [400, 404, 413].includes(error.status)) throw stalePreview();
      throw error;
    });
    if (!timingSafeEqual(Buffer.from(plan.previewToken, 'hex'), Buffer.from(input.previewToken, 'hex'))) throw stalePreview();
    const changed = await context.client.query(`update knowledge_base_nodes set parent_id=$2,
      acl_mode=case when $3::boolean then 'custom' else acl_mode end,
      revision=revision+1,updated_at=clock_timestamp() where id=$1 and revision=$4::bigint returning id`,
    [id, input.targetParentId, plan.rootRecipients !== null, input.expectedRevision]);
    if (changed.rowCount !== 1) throw stalePreview();
    if (plan.rootRecipients !== null) {
      await context.client.query('delete from knowledge_base_grants where node_id=$1', [id]);
      if (plan.rootRecipients.length) await context.client.query(`insert into knowledge_base_grants(node_id,actor_key)
        select $1,unnest($2::text[])`, [id, plan.rootRecipients]);
    }
    return mapKnowledgeBaseNode((await readKnowledgeBaseRow(context.client, id))!, true);
  });
}
