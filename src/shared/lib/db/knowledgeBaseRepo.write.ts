import { createHash } from 'crypto';
import type { AdminSession } from '../adminAuth';
import { assertKnowledgeBaseId, assertKnowledgeBaseRevision, assertKnowledgeBaseUuid, knowledgeBaseInvalid,
  knowledgeBaseNotFound, KnowledgeBaseError, parseKnowledgeBaseAccess, parseKnowledgeBaseTitle,
  KNOWLEDGE_BASE_MAX_DEPTH, KNOWLEDGE_BASE_MAX_FILE_BYTES,
  type KnowledgeBaseAccess, type KnowledgeBaseCreate, type KnowledgeBaseFileCreate, type KnowledgeBaseUpdate } from '../knowledgeBase';
import { mapKnowledgeBaseNode, readKnowledgeBaseRow, requireKnowledgeBasePath, withKnowledgeBase,
  type KnowledgeBaseContext, type KnowledgeBaseRow } from './knowledgeBaseRepo.shared';

const revisionConflict = () => new KnowledgeBaseError(409, 'REVISION_CONFLICT', 'Материал уже изменён другим пользователем. Обновите страницу.');
const operationConflict = () => new KnowledgeBaseError(409, 'OPERATION_CONFLICT', 'Этот запрос уже использован для другого материала. Обновите страницу.');

async function assertActiveGrants(context: KnowledgeBaseContext, access: KnowledgeBaseAccess) {
  if (!access.actorKeys.length) return;
  const result = await context.client.query<{ actor_key: string }>(`select 'admin:'||id::text as actor_key from admin_users
    where is_active and 'admin:'||id::text=any($1::text[])
    union all select 'manager:'||id::text from wholesale_managers where is_active and 'manager:'||id::text=any($1::text[])`, [access.actorKeys]);
  if (result.rows.length !== access.actorKeys.length) throw new KnowledgeBaseError(400, 'INVALID_GRANTS', 'Выберите действующих сотрудников. Список доступов мог измениться.');
}
async function saveGrants(context: KnowledgeBaseContext, id: number, access: KnowledgeBaseAccess) {
  await context.client.query('delete from knowledge_base_grants where node_id=$1', [id]);
  if (access.actorKeys.length) await context.client.query(`insert into knowledge_base_grants(node_id,actor_key)
    select $1,unnest($2::text[])`, [id, access.actorKeys]);
}
async function creationParent(context: KnowledgeBaseContext, parentId: number | null, kind: 'folder' | 'file') {
  if (parentId === null) {
    return;
  }
  const path = await requireKnowledgeBasePath(context, parentId);
  if (path.at(-1)!.kind !== 'folder') throw knowledgeBaseNotFound();
  if (kind === 'folder' && path.length >= KNOWLEDGE_BASE_MAX_DEPTH) throw new KnowledgeBaseError(400, 'MAX_DEPTH', 'Допускается не больше 12 уровней папок');
}

function normalizedCreate(input: KnowledgeBaseCreate) {
  assertKnowledgeBaseUuid(input.operationId);
  if (input.parentId !== null) assertKnowledgeBaseId(input.parentId);
  return { operationId: input.operationId.toLowerCase(), parentId: input.parentId,
    title: parseKnowledgeBaseTitle(input.title), access: parseKnowledgeBaseAccess(input.access, input.parentId === null) };
}
function normalizedFile(input: KnowledgeBaseFileCreate) {
  if (input.parentId !== null) assertKnowledgeBaseId(input.parentId);
  if (typeof input.originalName !== 'string' || !input.originalName.trim() || input.originalName.length > 255
    || /[\u0000-\u001f\u007f\\/]/.test(input.originalName)
    || typeof input.mimeType !== 'string' || !input.mimeType || input.mimeType.length > 160 || /[\u0000-\u0020\u007f]/.test(input.mimeType)
    || !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > KNOWLEDGE_BASE_MAX_FILE_BYTES
    || typeof input.storagePath !== 'string' || !/^knowledge-base\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/.test(input.storagePath)
    || typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sha256)) throw knowledgeBaseInvalid();
  return { originalName: input.originalName, mimeType: input.mimeType, size: input.size, storagePath: input.storagePath, sha256: input.sha256 };
}
async function createNode(session: AdminSession, input: KnowledgeBaseCreate, file?: ReturnType<typeof normalizedFile>) {
  const data = normalizedCreate(input);
  const kind = file ? 'file' : 'folder';
  // Random physical paths differ on a retry; immutable content and metadata identify the operation.
  const digest = createHash('sha256').update(JSON.stringify({ kind, parentId: data.parentId, title: data.title, access: data.access,
    ...(file ? { originalName: file.originalName, mimeType: file.mimeType, size: file.size, sha256: file.sha256 } : {}) })).digest('hex');
  return withKnowledgeBase(session, 'write', async context => {
    const existing = await context.client.query<{ id: string; operation_digest: string }>(`select id::text,operation_digest from knowledge_base_nodes
      where created_by=$1 and operation_id=$2::uuid`, [context.actorKey, data.operationId]);
    if (existing.rows[0]) {
      if (existing.rows[0].operation_digest !== digest) throw operationConflict();
      const existingNode = await readKnowledgeBaseRow(context.client, Number(existing.rows[0].id));
      // A deleted operation remains reserved: a delayed upload retry must not
      // recreate a deleted material or return a successful phantom save.
      if (!existingNode) throw operationConflict();
      return { node: mapKnowledgeBaseNode(existingNode, true), created: false };
    }
    await creationParent(context, data.parentId, kind);
    await assertActiveGrants(context, data.access);
    const inserted = await context.client.query<{ id: string }>(`insert into knowledge_base_nodes
      (parent_id,kind,title,acl_mode,original_name,mime_type,file_size,storage_path,sha256,created_by,operation_id,operation_digest)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid,$12) returning id::text`,
    [data.parentId, kind, data.title, data.access.mode, file?.originalName ?? null, file?.mimeType ?? null, file?.size ?? null,
      file?.storagePath ?? null, file?.sha256 ?? null, context.actorKey, data.operationId, digest]);
    const id = Number(inserted.rows[0].id);
    await saveGrants(context, id, data.access);
    return { node: mapKnowledgeBaseNode((await readKnowledgeBaseRow(context.client, id))!, true), created: true };
  });
}
export async function createKnowledgeBaseFolder(session: AdminSession, input: KnowledgeBaseCreate) {
  return createNode(session, input);
}
export async function createKnowledgeBaseFile(session: AdminSession, input: KnowledgeBaseFileCreate) {
  return createNode(session, input, normalizedFile(input));
}
function checkRevision(row: KnowledgeBaseRow, expected: string) {
  if (row.revision !== expected) throw revisionConflict();
}
export async function updateKnowledgeBaseNode(session: AdminSession, id: number, input: KnowledgeBaseUpdate) {
  assertKnowledgeBaseId(id); assertKnowledgeBaseRevision(input.expectedRevision);
  if (input.title === undefined && input.access === undefined) throw knowledgeBaseInvalid();
  const title = input.title === undefined ? undefined : parseKnowledgeBaseTitle(input.title);
  return withKnowledgeBase(session, 'write', async context => {
    const row = (await requireKnowledgeBasePath(context, id)).at(-1)!;
    checkRevision(row, input.expectedRevision);
    const access = input.access === undefined ? undefined : parseKnowledgeBaseAccess(input.access, row.parent_id === null);
    if (access) {
      // A profile-only edit must not fail because an existing recipient was disabled/deleted.
      // Preserving its old key grants no current access; only newly added recipients must be active.
      await assertActiveGrants(context, { ...access, actorKeys: access.actorKeys.filter(key => !row.actor_keys.includes(key)) });
      await saveGrants(context, id, access);
    }
    await context.client.query(`update knowledge_base_nodes set title=$2,acl_mode=$3,revision=revision+1,updated_at=clock_timestamp() where id=$1`,
      [id, title ?? row.title, access?.mode ?? row.acl_mode]);
    return mapKnowledgeBaseNode((await readKnowledgeBaseRow(context.client, id))!, true);
  });
}
export async function setKnowledgeBaseArchive(session: AdminSession, id: number, input: { expectedRevision: string; archived: boolean }) {
  assertKnowledgeBaseId(id); assertKnowledgeBaseRevision(input.expectedRevision);
  if (typeof input.archived !== 'boolean') throw knowledgeBaseInvalid();
  return withKnowledgeBase(session, 'write', async context => {
    const path = await requireKnowledgeBasePath(context, id, true);
    const row = path.at(-1)!;
    checkRevision(row, input.expectedRevision);
    if (path.slice(0, -1).some(parent => parent.archived_at)) throw new KnowledgeBaseError(409, 'PARENT_ARCHIVED', 'Сначала восстановите родительскую папку');
    if (Boolean(row.archived_at) === input.archived) return mapKnowledgeBaseNode(row, true);
    await context.client.query(`update knowledge_base_nodes set archived_at=case when $2 then clock_timestamp() else null end,
      revision=revision+1,updated_at=clock_timestamp() where id=$1`, [id, input.archived]);
    return mapKnowledgeBaseNode((await readKnowledgeBaseRow(context.client, id))!, true);
  });
}
