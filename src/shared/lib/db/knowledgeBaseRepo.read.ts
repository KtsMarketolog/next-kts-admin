import type { AdminSession } from '../adminAuth';
import { assertKnowledgeBaseId, isKnowledgeBaseActorKey, knowledgeBaseInvalid, knowledgeBaseNotFound, parseKnowledgeBaseSearch,
  KNOWLEDGE_BASE_PAGE_SIZE, type KnowledgeBaseActor, type KnowledgeBaseList } from '../knowledgeBase';
import { assertKnowledgeBaseManage, KB_COLUMNS, mapKnowledgeBaseNode, requireKnowledgeBasePath, withKnowledgeBase, type KnowledgeBaseRow } from './knowledgeBaseRepo.shared';

export async function listKnowledgeBase(session: AdminSession, input: { parentId?: number | null; after?: number; search?: string; archived?: boolean } = {}): Promise<KnowledgeBaseList> {
  const parentId = input.parentId ?? null;
  if (parentId !== null) assertKnowledgeBaseId(parentId);
  if (input.after !== undefined) assertKnowledgeBaseId(input.after);
  const search = parseKnowledgeBaseSearch(input.search);
  return withKnowledgeBase(session, 'read', async context => {
    if (input.archived) assertKnowledgeBaseManage(context);
    const path = parentId === null ? [] : await requireKnowledgeBasePath(context, parentId);
    if (path.length && path.at(-1)!.kind !== 'folder') throw knowledgeBaseNotFound();
    const result = await context.client.query<KnowledgeBaseRow>(`select ${KB_COLUMNS} from knowledge_base_nodes n
      where n.parent_id is not distinct from $1::bigint and ($2::bigint is null or n.id>$2)
        and (n.archived_at is not null)=$3::boolean
        and ($4::boolean or n.acl_mode='inherit' or exists(select 1 from knowledge_base_grants where node_id=n.id and actor_key=$5))
        and ($6::text='' or position(lower($6) in lower(n.title))>0)
      order by n.id limit 51`, [parentId, input.after ?? null, input.archived ?? false, context.manages, context.actorKey, search]);
    const nodes = result.rows.slice(0, KNOWLEDGE_BASE_PAGE_SIZE).map(row => mapKnowledgeBaseNode(row, context.manages));
    return { nodes, nextCursor: result.rows.length > KNOWLEDGE_BASE_PAGE_SIZE ? nodes.at(-1)!.id : null,
      breadcrumbs: path.map(row => mapKnowledgeBaseNode(row, context.manages)), canManage: context.manages };
  });
}
export async function getKnowledgeBaseNode(session: AdminSession, id: number, input: { archived?: boolean } = {}) {
  assertKnowledgeBaseId(id);
  return withKnowledgeBase(session, 'read', async context => {
    try { return mapKnowledgeBaseNode((await requireKnowledgeBasePath(context, id, input.archived)).at(-1)!, context.manages); }
    catch (error) { if (error instanceof Error && 'status' in error && error.status === 404) return null; throw error; }
  });
}
export async function getKnowledgeBaseFileForRead(session: AdminSession, id: number) {
  assertKnowledgeBaseId(id);
  return withKnowledgeBase(session, 'read', async context => {
    try {
      const row = (await requireKnowledgeBasePath(context, id)).at(-1)!;
      if (row.kind !== 'file') return null;
      return { node: mapKnowledgeBaseNode(row, context.manages), storagePath: row.storage_path!, sha256: row.sha256! };
    } catch (error) { if (error instanceof Error && 'status' in error && error.status === 404) return null; throw error; }
  });
}
export async function listKnowledgeBaseActors(session: AdminSession, input: { search?: string; after?: string } = {}) {
  const search = parseKnowledgeBaseSearch(input.search);
  if (input.after && !isKnowledgeBaseActorKey(input.after)) throw knowledgeBaseInvalid();
  return withKnowledgeBase(session, 'read', async context => {
    assertKnowledgeBaseManage(context);
    const result = await context.client.query<{ actor_key: string; actor_name: string; actor_role: string }>(`with actors as (
      select 'admin:'||id::text as actor_key,coalesce(nullif(name,''),'admin:'||id::text) as actor_name,role as actor_role from admin_users where is_active
      union all select 'manager:'||id::text,coalesce(nullif(name,''),'manager:'||id::text),coalesce(nullif(role,''),'manager') from wholesale_managers where is_active
    ) select * from actors where ($1::text is null or actor_key>$1) and ($2::text='' or position(lower($2) in lower(actor_name))>0)
      order by actor_key limit 51`, [input.after ?? null, search]);
    const actors: KnowledgeBaseActor[] = result.rows.slice(0, 50).map(row => ({ actorKey: row.actor_key, actorName: row.actor_name, actorRole: row.actor_role }));
    return { actors, nextCursor: result.rows.length > 50 ? actors.at(-1)!.actorKey : null };
  });
}
