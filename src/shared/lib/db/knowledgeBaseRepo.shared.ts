import type { PoolClient } from 'pg';
import type { AdminSession } from '../adminAuth';
import { canManageKnowledgeBase, canAccessKnowledgeBase, knowledgeBaseActorKey, KnowledgeBaseError, knowledgeBaseNotFound,
  assertKnowledgeBaseUuid, KNOWLEDGE_BASE_MAX_DEPTH, type KnowledgeBaseNode } from '../knowledgeBase';
import { ensureSiteSchema } from './schema';
import { withTransaction } from './client';

export const KNOWLEDGE_BASE_LOCK = 'kts:knowledge-base-tree-v1';
export type KnowledgeBaseContext = { client: PoolClient; session: AdminSession; actorKey: string; manages: boolean };
export type KnowledgeBaseRow = {
  id: string; parent_id: string | null; kind: 'folder' | 'file'; title: string; revision: string;
  archived_at: Date | null; created_at: Date; updated_at: Date; acl_mode: 'inherit' | 'custom';
  original_name: string | null; mime_type: string | null; file_size: string | null; storage_path: string | null; sha256: string | null;
  actor_keys: string[]; operation_digest: string;
};
export const KB_COLUMNS = `n.id::text,n.parent_id::text,n.kind,n.title,n.revision::text,n.archived_at,n.created_at,n.updated_at,n.acl_mode,
  n.original_name,n.mime_type,n.file_size::text,n.storage_path,n.sha256,n.operation_digest,
  array(select actor_key from knowledge_base_grants where node_id=n.id order by actor_key) as actor_keys`;

/** Recheck the persisted session and current principal, not caller-supplied role alone. */
async function assertActiveSession(client: PoolClient, session: AdminSession) {
  assertKnowledgeBaseUuid(session.sessionId);
  const valid = await client.query(`select s.id from admin_sessions s
    left join admin_users u on u.id=s.admin_user_id
    left join wholesale_managers m on m.id=s.manager_id
    where s.id=$1::uuid and s.role=$2 and s.admin_user_id is not distinct from $3::bigint
      and s.manager_id is not distinct from $4::bigint and s.revoked_at is null and s.expires_at>clock_timestamp()
      and ((s.role='admin' and s.admin_user_id is null and s.manager_id is null)
        or (s.role in ('admin','admintop','top','wholesale_admin','purchaser') and u.is_active and u.role=s.role
          and coalesce(u.password_changed_at<=s.created_at,true))
        or (s.role in ('manager','support_manager') and m.is_active and coalesce(nullif(m.role,''),'manager')=s.role
          and coalesce(m.password_changed_at<=s.created_at,true)))`,
  [session.sessionId, session.role, session.adminUserId ?? null, session.managerId ?? null]);
  if (!valid.rowCount) throw new KnowledgeBaseError(401, 'UNAUTHORIZED', 'Сеанс завершён или доступ изменён. Войдите снова.');
}
export async function withKnowledgeBase<T>(session: AdminSession, mode: 'read' | 'write' | 'event', work: (context: KnowledgeBaseContext) => Promise<T>) {
  if (!canAccessKnowledgeBase(session)) throw new KnowledgeBaseError(401, 'UNAUTHORIZED', 'Необходимо войти');
  if (mode === 'write' && !canManageKnowledgeBase(session)) throw new KnowledgeBaseError(403, 'FORBIDDEN', 'Управление базой знаний доступно администратору и Админ ТОП');
  await ensureSiteSchema();
  return withTransaction(async client => {
    await client.query("set local statement_timeout='5s'; set local lock_timeout='2s'");
    await client.query(`select ${mode === 'write' ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared'}(hashtext($1))`, [KNOWLEDGE_BASE_LOCK]);
    await assertActiveSession(client, session);
    return work({ client, session, actorKey: knowledgeBaseActorKey(session), manages: canManageKnowledgeBase(session) });
  }, { profile: 'interactive', trackCommitOutcome: mode !== 'read' });
}
export function mapKnowledgeBaseNode(row: KnowledgeBaseRow, manages: boolean): KnowledgeBaseNode {
  return {
    id: Number(row.id), parentId: row.parent_id === null ? null : Number(row.parent_id), kind: row.kind,
    title: row.title, revision: row.revision, archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    originalName: row.original_name, mimeType: row.mime_type, size: row.file_size === null ? null : Number(row.file_size),
    ...(manages ? { access: { mode: row.acl_mode, actorKeys: row.actor_keys } } : {}),
  };
}
export async function readKnowledgeBaseRow(client: PoolClient, id: number) {
  return (await client.query<KnowledgeBaseRow>(`select ${KB_COLUMNS} from knowledge_base_nodes n where n.id=$1`, [id])).rows[0] ?? null;
}
/** Root-to-leaf chain; each custom ACL intersects every custom ancestor ACL. */
export async function requireKnowledgeBasePath(context: KnowledgeBaseContext, id: number, allowArchived = false) {
  const { client, manages, actorKey } = context;
  const result = await client.query<KnowledgeBaseRow & { depth: number }>(`with recursive path as (
    select id,parent_id,1 as depth,array[id] as visited from knowledge_base_nodes where id=$1
    union all select parent.id,parent.parent_id,path.depth+1,path.visited||parent.id
    from path join knowledge_base_nodes parent on parent.id=path.parent_id
    where path.depth < $2 and not parent.id=any(path.visited)
  ) select ${KB_COLUMNS},path.depth from path join knowledge_base_nodes n on n.id=path.id order by path.depth desc`, [id, KNOWLEDGE_BASE_MAX_DEPTH + 1]);
  const rows = result.rows;
  if (!rows.length || rows[0].parent_id !== null
    || rows.some((row, index) => (index < rows.length - 1 && row.kind !== 'folder')
      || (row.archived_at && !(manages && allowArchived))
      || (!manages && row.acl_mode === 'custom' && !row.actor_keys.includes(actorKey)))) throw knowledgeBaseNotFound();
  return rows;
}
export function assertKnowledgeBaseManage(context: KnowledgeBaseContext) {
  if (!context.manages) throw new KnowledgeBaseError(403, 'FORBIDDEN', 'Недостаточно прав');
}
