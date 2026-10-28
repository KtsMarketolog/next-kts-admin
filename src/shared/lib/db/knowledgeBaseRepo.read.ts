import type { AdminSession } from '../adminAuth';
import { assertKnowledgeBaseId, isKnowledgeBaseActorKey, knowledgeBaseInvalid, knowledgeBaseNotFound, parseKnowledgeBaseSearch,
  KNOWLEDGE_BASE_MAX_DEPTH, KNOWLEDGE_BASE_PAGE_SIZE, type KnowledgeBaseActor, type KnowledgeBaseList, type KnowledgeBaseListNode } from '../knowledgeBase';
import { assertKnowledgeBaseManage, KB_COLUMNS, mapKnowledgeBaseNode, requireKnowledgeBasePath, withKnowledgeBase, type KnowledgeBaseRow } from './knowledgeBaseRepo.shared';

type KnowledgeBaseListRow = KnowledgeBaseRow & { search_path?: NonNullable<KnowledgeBaseListNode['path']> };
// Some PostgreSQL clusters use the C locale, whose lower() leaves Russian capitals unchanged.
const SEARCHABLE_TITLE = "translate(lower(n.title),'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ','абвгдеёжзийклмнопрстуфхцчшщъыьэюя')";

export async function listKnowledgeBase(session: AdminSession, input: { parentId?: number | null; after?: number; search?: string; archived?: boolean } = {}): Promise<KnowledgeBaseList> {
  const parentId = input.parentId ?? null;
  if (parentId !== null) assertKnowledgeBaseId(parentId);
  if (input.after !== undefined) assertKnowledgeBaseId(input.after);
  const search = parseKnowledgeBaseSearch(input.search).toLowerCase();
  return withKnowledgeBase(session, 'read', async context => {
    if (input.archived) assertKnowledgeBaseManage(context);
    const path = parentId === null ? [] : await requireKnowledgeBasePath(context, parentId);
    if (path.length && path.at(-1)!.kind !== 'folder') throw knowledgeBaseNotFound();
    const recursiveSearch = search !== '' && !input.archived;
    // Prune inaccessible/archived ancestors before descending, regardless of matching descendants.
    // Title/cursor filters apply only after traversal so an older, nonmatching parent cannot hide a result.
    const result = recursiveSearch
      ? await context.client.query<KnowledgeBaseListRow>(`with recursive visible_tree as (
        select n.id,n.kind,n.title,$6::jsonb as search_path,$7::bigint[]||n.id as visited,$8::int as depth
        from knowledge_base_nodes n
        where n.parent_id is not distinct from $1::bigint and n.archived_at is null
          and ($2::boolean or n.acl_mode='inherit' or exists(select 1 from knowledge_base_grants where node_id=n.id and actor_key=$3))
          and $8::int <= $9::int + case when n.kind='file' then 1 else 0 end and not n.id=any($7::bigint[])
        union all
        select n.id,n.kind,n.title,
          visible_tree.search_path||jsonb_build_array(jsonb_build_object('id',visible_tree.id,'title',visible_tree.title)),
          visible_tree.visited||n.id,visible_tree.depth+1
        from visible_tree join knowledge_base_nodes n on n.parent_id=visible_tree.id
        where visible_tree.kind='folder' and visible_tree.depth<$9::int + case when n.kind='file' then 1 else 0 end
          and not n.id=any(visible_tree.visited)
          and n.archived_at is null
          and ($2::boolean or n.acl_mode='inherit' or exists(select 1 from knowledge_base_grants where node_id=n.id and actor_key=$3))
      ) select ${KB_COLUMNS},visible_tree.search_path from visible_tree join knowledge_base_nodes n on n.id=visible_tree.id
        where ($5::bigint is null or n.id>$5) and position($4 in ${SEARCHABLE_TITLE})>0
        order by n.id limit 51`, [parentId, context.manages, context.actorKey, search, input.after ?? null,
        JSON.stringify(path.map(row => ({ id: Number(row.id), title: row.title }))), path.map(row => row.id), path.length + 1, KNOWLEDGE_BASE_MAX_DEPTH])
      : await context.client.query<KnowledgeBaseListRow>(`select ${KB_COLUMNS} from knowledge_base_nodes n
      where n.parent_id is not distinct from $1::bigint and ($2::bigint is null or n.id>$2)
        and (n.archived_at is not null)=$3::boolean
        and ($4::boolean or n.acl_mode='inherit' or exists(select 1 from knowledge_base_grants where node_id=n.id and actor_key=$5))
        and ($6::text='' or position($6 in ${SEARCHABLE_TITLE})>0)
      order by n.id limit 51`, [parentId, input.after ?? null, input.archived ?? false, context.manages, context.actorKey, search]);
    const nodes: KnowledgeBaseListNode[] = result.rows.slice(0, KNOWLEDGE_BASE_PAGE_SIZE).map(row => ({
      ...mapKnowledgeBaseNode(row, context.manages),
      ...(row.search_path === undefined ? {} : { path: row.search_path }),
    }));
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
