import type { AdminSession } from '../adminAuth';
import { assertKnowledgeBaseId, assertKnowledgeBaseUuid, isKnowledgeBaseActorKey, knowledgeBaseInvalid, KnowledgeBaseError,
  KNOWLEDGE_BASE_ACTIONS, parseKnowledgeBaseSearch, type KnowledgeBaseAction, type KnowledgeBaseStatsPage } from '../knowledgeBase';
import { assertKnowledgeBaseManage, requireKnowledgeBasePath, withKnowledgeBase } from './knowledgeBaseRepo.shared';

export async function recordKnowledgeBaseEvent(session: AdminSession, input: { eventId: string; nodeId: number | null; action: KnowledgeBaseAction }) {
  assertKnowledgeBaseUuid(input.eventId);
  if (!KNOWLEDGE_BASE_ACTIONS.includes(input.action) || (input.action === 'section_open') !== (input.nodeId === null)) throw knowledgeBaseInvalid();
  if (input.nodeId !== null) assertKnowledgeBaseId(input.nodeId);
  return withKnowledgeBase(session, 'event', async context => {
    if (input.nodeId !== null) {
      const row = (await requireKnowledgeBasePath(context, input.nodeId)).at(-1)!;
      if ((input.action === 'folder_open') !== (row.kind === 'folder')) throw knowledgeBaseInvalid();
    }
    const inserted = await context.client.query(`insert into knowledge_base_events(actor_key,actor_role,event_id,node_id,action)
      values($1,$2,$3::uuid,$4,$5) on conflict(actor_key,event_id) do nothing returning id`,
    [context.actorKey, session.role, input.eventId, input.nodeId, input.action]);
    if (inserted.rowCount) return { recorded: true };
    const existing = await context.client.query<{ node_id: string | null; action: string }>(`select node_id::text,action from knowledge_base_events where actor_key=$1 and event_id=$2::uuid`, [context.actorKey, input.eventId]);
    if (existing.rows[0]?.action !== input.action || (existing.rows[0].node_id === null ? null : Number(existing.rows[0].node_id)) !== input.nodeId) {
      throw new KnowledgeBaseError(409, 'EVENT_CONFLICT', 'Идентификатор события уже использован');
    }
    return { recorded: false };
  });
}
type StatsInput = { view: 'employees' | 'materials'; after?: string; search?: string; actorKey?: string; nodeId?: number };
type StatsDbRow = { key: string; title: string; role: string | null; section_opens: string; folder_opens: string; file_views: string;
  downloads_started: string; last_visit_at: Date; total_events: string };
export async function listKnowledgeBaseStats(session: AdminSession, input: StatsInput): Promise<KnowledgeBaseStatsPage> {
  if (!['employees', 'materials'].includes(input.view)) throw knowledgeBaseInvalid();
  if (input.actorKey !== undefined && input.actorKey !== 'admin:primary' && !isKnowledgeBaseActorKey(input.actorKey)) throw knowledgeBaseInvalid();
  if (input.nodeId !== undefined) assertKnowledgeBaseId(input.nodeId);
  if (input.after !== undefined && (input.view === 'employees'
    ? input.after !== 'admin:primary' && !isKnowledgeBaseActorKey(input.after)
    : !/^(root|[1-9][0-9]{0,14})$/.test(input.after))) throw knowledgeBaseInvalid();
  const search = parseKnowledgeBaseSearch(input.search);
  return withKnowledgeBase(session, 'read', async context => {
    assertKnowledgeBaseManage(context);
    // Select a bounded page of identities/materials, not a bounded page of events.
    // Each selected row still counts its entire filtered history in the same SQL snapshot.
    const label = input.view === 'employees'
      ? "coalesce(nullif(u.name,''),nullif(m.name,''),case when counts.key='admin:primary' then 'Основной администратор' else counts.key end)"
      : "coalesce(n.title,'База знаний')";
    const joins = input.view === 'employees'
      ? "left join admin_users u on counts.key='admin:'||u.id::text left join wholesale_managers m on counts.key='manager:'||m.id::text"
      : "left join knowledge_base_nodes n on counts.key=n.id::text";
    const role = input.view === 'employees'
      ? "coalesce(u.role,m.role,(select actor_role from knowledge_base_events recent where recent.actor_key=counts.key order by recent.created_at desc,recent.id desc limit 1))"
      : 'null::text';
    const employeeCandidates = `select distinct e.actor_key as key from knowledge_base_events e
      left join admin_users u on e.actor_key='admin:'||u.id::text
      left join wholesale_managers m on e.actor_key='manager:'||m.id::text
      where ($1::text is null or e.actor_key=$1) and ($2::bigint is null or e.node_id=$2)
        and ($3::text is null or e.actor_key>$3)
        and ($4::text='' or position(lower($4) in lower(${label.replaceAll('counts.key', 'e.actor_key')}))>0)
      order by key limit 51`;
    // The immutable node metadata is smaller than the event log; probe existence via node_id's index.
    const materialCandidates = `select n.id::text as key from knowledge_base_nodes n
      where ($2::bigint is null or n.id=$2) and ($3::text is null or n.id::text>$3)
        and ($4::text='' or position(lower($4) in lower(n.title))>0)
        and exists(select 1 from knowledge_base_events e where e.node_id=n.id and ($1::text is null or e.actor_key=$1))
      union all select 'root' where $2::bigint is null and ($3::text is null or 'root'>$3)
        and ($4::text='' or position(lower($4) in lower('База знаний'))>0)
        and exists(select 1 from knowledge_base_events e where e.node_id is null and ($1::text is null or e.actor_key=$1))
      order by key limit 51`;
    const selectedEvents = input.view === 'employees' ? 'e.actor_key=counts.key'
      : "(e.node_id=case when counts.key='root' then null else counts.key::bigint end or (counts.key='root' and e.node_id is null))";
    const result = await context.client.query<StatsDbRow>(`with selected as materialized (
      ${input.view === 'employees' ? employeeCandidates : materialCandidates}
    ) select counts.key,${label} as title,${role} as role,totals.* from selected counts ${joins}
    cross join lateral (
      select
        count(*) filter(where e.action='section_open')::text as section_opens,
        count(*) filter(where e.action='folder_open')::text as folder_opens,
        count(*) filter(where e.action='file_view')::text as file_views,
        count(*) filter(where e.action='download_started')::text as downloads_started,
        max(e.created_at) as last_visit_at,count(*)::text as total_events
      from knowledge_base_events e where ${selectedEvents}
        and ($1::text is null or e.actor_key=$1) and ($2::bigint is null or e.node_id=$2)
    ) totals order by counts.key`, [input.actorKey ?? null, input.nodeId ?? null, input.after ?? null, search]);
    const rows = result.rows.slice(0, 50).map(row => ({ key: row.key, title: row.title, ...(row.role ? { role: row.role } : {}),
      sectionOpens: Number(row.section_opens), folderOpens: Number(row.folder_opens), fileViews: Number(row.file_views),
      downloadsStarted: Number(row.downloads_started), lastVisitAt: new Date(row.last_visit_at).toISOString(), totalEvents: Number(row.total_events) }));
    return { rows, nextCursor: result.rows.length > 50 ? rows.at(-1)!.key : null };
  });
}
