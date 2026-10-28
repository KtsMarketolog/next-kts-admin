import type { AdminSession } from '../adminAuth';
import { assertKnowledgeBaseId, knowledgeBaseInvalid, knowledgeBaseNotFound, parseKnowledgeBaseAccess,
  type KnowledgeBaseAccessPreviewInput, type KnowledgeBaseAccessSummary } from '../knowledgeBase';
import { assertKnowledgeBaseManage, requireKnowledgeBasePath, withKnowledgeBase } from './knowledgeBaseRepo.shared';

type AccessCountsRow = {
  total_active: string; by_role: string; by_selection: string; by_inheritance: string;
  selected_inactive: string; selected_blocked_by_parent: string;
};

/** Count the editor's draft against current accounts and ancestor ACLs; never save or normalize grants. */
export async function getKnowledgeBaseAccessSummary(session: AdminSession, input: KnowledgeBaseAccessPreviewInput): Promise<KnowledgeBaseAccessSummary> {
  if (input.parentId !== null) assertKnowledgeBaseId(input.parentId);
  if (input.access === undefined) throw knowledgeBaseInvalid();
  const access = parseKnowledgeBaseAccess(input.access, input.parentId === null);
  return withKnowledgeBase(session, 'read', async context => {
    assertKnowledgeBaseManage(context);
    const path = input.parentId === null ? [] : await requireKnowledgeBasePath(context, input.parentId);
    if (path.length && path.at(-1)!.kind !== 'folder') throw knowledgeBaseNotFound();
    // Every custom ancestor must allow the account. null means no ancestor restriction;
    // an empty array means none of the ordinary accounts can reach the draft material.
    let parentKeys: string[] | null = null;
    for (const row of path) {
      if (row.acl_mode !== 'custom') continue;
      const grants = new Set(row.actor_keys);
      parentKeys = parentKeys === null ? [...grants] : parentKeys.filter(key => grants.has(key));
    }
    const result = await context.client.query<AccessCountsRow>(`with actors as (
      select 'admin:'||id::text as actor_key,role as actor_role from admin_users where is_active
      union all select 'manager:'||id::text,coalesce(nullif(role,''),'manager') from wholesale_managers where is_active
    ), classified as (
      select actor_key,actor_role in ('admin','admintop','top') as by_role,
        actor_key=any($1::text[]) as selected,
        ($2::text[] is null or actor_key=any($2::text[])) as parent_allowed
      from actors
    ) select count(*)::text as total_active,
      count(*) filter(where by_role)::text as by_role,
      count(*) filter(where not by_role and parent_allowed and selected and $3='custom')::text as by_selection,
      count(*) filter(where not by_role and parent_allowed and $3='inherit')::text as by_inheritance,
      count(*) filter(where not by_role and selected and not parent_allowed)::text as selected_blocked_by_parent,
      (select count(*)::text from unnest($1::text[]) selected(actor_key)
        where not exists(select 1 from actors where actors.actor_key=selected.actor_key)) as selected_inactive
      from classified`, [access.actorKeys, parentKeys, access.mode]);
    const row = result.rows[0];
    const totalActive = Number(row.total_active), byRole = Number(row.by_role);
    const bySelection = Number(row.by_selection), byInheritance = Number(row.by_inheritance);
    const withAccess = byRole + bySelection + byInheritance;
    return { totalActive, withAccess, byRole, bySelection, byInheritance, withoutAccess: totalActive - withAccess,
      selectedInactive: Number(row.selected_inactive), selectedBlockedByParent: Number(row.selected_blocked_by_parent) };
  });
}
