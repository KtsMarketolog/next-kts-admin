import { isTopDashboardManagementSession, type AdminSession } from '../adminAuth';
import { canViewDashboard } from '../dashboardAccess';
import { canManageCurrencyDashboard } from '../currencyDashboardAccess';
import { parseDashboardUsageBatch, type DashboardUsageAction, type DashboardUsageBatch, type DashboardUsageUpload, type DashboardUsageUploadType } from '../dashboardUsage';
import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';

export const DASHBOARD_USAGE_RETENTION_CUTOFF_SQL = "((now() at time zone 'Europe/Moscow') - interval '1 month') at time zone 'Europe/Moscow'";
export const DASHBOARD_USAGE_PURGE_BATCH_SIZE = 1000;
export const DASHBOARD_USAGE_PURGE_MAX_BATCHES = 10;

export function dashboardUsageActorKey(session: AdminSession) {
  if (session.role === 'manager' || session.role === 'support_manager') {
    if (!Number.isSafeInteger(session.managerId) || Number(session.managerId) < 1) throw new Error('Invalid actor');
    return `manager:${session.managerId}`;
  }
  if (Number.isSafeInteger(session.adminUserId) && Number(session.adminUserId) > 0) return `admin:${session.adminUserId}`;
  if (session.role === 'admin') return 'admin:primary';
  throw new Error('Invalid actor');
}

export async function recordDashboardUsage(session: AdminSession, batch: DashboardUsageBatch) {
  batch = parseDashboardUsageBatch(batch, { allowServerUpload: true });
  const managesReport = batch.dashboardKey === 'currency-rates' ? canManageCurrencyDashboard(session)
    : batch.dashboardKey.startsWith('top:') ? isTopDashboardManagementSession(session)
      : session.role === 'admin' || session.role === 'admintop';
  if (!session.sessionId || !canViewDashboard(session, batch.dashboardKey) || (batch.preview && !managesReport)) {
    throw new Error('Нет доступа к журналу отчёта');
  }
  const actorKey = dashboardUsageActorKey(session);
  await ensureSiteSchema();
  // One statement: event and optional metadata commit together. Retries never overwrite or double-count.
  await withTransaction(async (client) => {
    // A committed business upload must not wait indefinitely for its follow-up journal write.
    await client.query("set local lock_timeout='1s'");
    await client.query("set local statement_timeout='3s'");
    await client.query(`with incoming as (
      select * from jsonb_to_recordset($6::jsonb) as event(id text, action text, upload jsonb,
        "uploadType" text, "durationSeconds" integer, "viewingWindowId" text)
    ), inserted as (
      insert into dashboard_usage_events(actor_key, actor_role, dashboard_key, event_id, action, is_preview, html_version_id)
      select $1, $2, $3, event.id, event.action, $4, $5 from incoming event
      on conflict(actor_key, event_id) do nothing returning id, event_id
    )
    insert into dashboard_usage_event_details(usage_event_id, upload_name, upload_size, upload_type, duration_seconds, viewing_window_id)
    select inserted.id, incoming.upload->>'name', (incoming.upload->>'size')::bigint,
      incoming."uploadType", incoming."durationSeconds", incoming."viewingWindowId"
    from inserted join incoming on incoming.id = inserted.event_id
    where incoming.upload is not null or incoming."durationSeconds" is not null`,
    [actorKey, session.role, batch.dashboardKey, batch.preview, batch.versionId, JSON.stringify(batch.events)]);
  });
}

export type DashboardUsageRow = {
  id: string; actorKey: string; actorName: string; actorRole: string;
  dashboardKey: string; dashboardTitle: string; action: DashboardUsageAction;
  preview: boolean; versionId: number | null; createdAt: string;
  hasProfitabilityDetails: boolean;
  upload: DashboardUsageUpload | null; uploadType: DashboardUsageUploadType | null; durationSeconds: number | null;
};

export async function listDashboardUsage(input: { before?: string; dashboardKey?: string; actorKey?: string; action?: DashboardUsageAction; includePreview?: boolean }) {
  await ensureSiteSchema();
  const result = await query<{
    id: string; actor_key: string; actor_name: string; actor_role: string; dashboard_key: string;
    dashboard_title: string; action: DashboardUsageAction; is_preview: boolean; html_version_id: string | null; created_at: Date;
    has_profitability_details: boolean;
    upload_name: string | null; upload_size: string | null; upload_type: DashboardUsageUploadType | null; duration_seconds: number | null;
  }>(`select event.id::text, event.actor_key, event.actor_role, event.dashboard_key, event.action, event.is_preview,
      event.html_version_id::text, event.created_at, metadata.upload_name, metadata.upload_size::text, metadata.upload_type, metadata.duration_seconds,
      exists(select 1 from dashboard_profitability_audit_details details where details.usage_event_id = event.id) as has_profitability_details,
      coalesce(nullif(u.name, ''), nullif(m.name, ''), case when event.actor_key = 'admin:primary' then 'Основной администратор' else event.actor_key end) as actor_name,
      coalesce(block.title, case event.dashboard_key when 'manager:development' then 'Дашборды МР'
        when 'manager:support' then 'Дашборды МС' when 'route-planner' then 'Компоновщик рейсов'
        when 'currency-rates' then 'Курсы валют и медь' else event.dashboard_key end) as dashboard_title
    from dashboard_usage_events event
    left join admin_users u on event.actor_key = 'admin:' || u.id::text
    left join wholesale_managers m on event.actor_key = 'manager:' || m.id::text
    left join top_dashboard_blocks block on event.dashboard_key = 'top:' || block.id::text
    left join dashboard_usage_event_details metadata on metadata.usage_event_id = event.id
    where event.created_at >= (${DASHBOARD_USAGE_RETENTION_CUTOFF_SQL})
      and ($1::bigint is null or event.id < $1::bigint)
      and ($2::text is null or event.dashboard_key = $2)
      and ($3::text is null or event.actor_key = $3)
      and ($4::text is null or event.action = $4)
      and ($5::boolean or not event.is_preview)
      and ($4::text = 'viewing_time' or event.action <> 'viewing_time')
    order by event.id desc limit 51`, [input.before ?? null, input.dashboardKey ?? null, input.actorKey ?? null, input.action ?? null, input.includePreview ?? false]);
  const rows: DashboardUsageRow[] = result.rows.slice(0, 50).map((row) => ({
    id: row.id, actorKey: row.actor_key, actorName: row.actor_name, actorRole: row.actor_role,
    dashboardKey: row.dashboard_key, dashboardTitle: row.dashboard_title,
    action: row.action, preview: row.is_preview, versionId: row.html_version_id ? Number(row.html_version_id) : null,
    createdAt: new Date(row.created_at).toISOString(),
    hasProfitabilityDetails: row.has_profitability_details === true,
    upload: row.upload_name !== null && row.upload_name !== undefined ? { name: row.upload_name, size: Number(row.upload_size) } : null,
    uploadType: row.upload_type ?? null, durationSeconds: row.duration_seconds ?? null,
  }));
  return { events: rows, nextCursor: result.rows.length > 50 ? rows.at(-1)!.id : null };
}

export type DashboardUsageEmployee = {
  actorKey: string; actorName: string; actorRole: string;
  lastOpenedAt: string | null; lastUsedAt: string | null; lastInteractionAt: string | null;
  lastDashboardKey: string | null; lastDashboardTitle: string | null;
  reportCount: number; interactionCount: number; uploadCount: number; viewingSeconds: number;
};
export type DashboardUsageSummary = {
  employees: DashboardUsageEmployee[]; nextCursor: string | null;
  periodStart: string; generatedAt: string;
};

/** Active employee roster, including zero-event employees. No previews or expired history. */
export async function listDashboardUsageEmployees(input: { after?: string; search?: string } = {}): Promise<DashboardUsageSummary> {
  if (input.after && !/^(?:admin|manager):[1-9][0-9]{0,14}$/.test(input.after)) throw new Error('Некорректный фильтр');
  const search = input.search?.trim() ?? '';
  if (search.length > 100) throw new Error('Некорректный фильтр');
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    // Bound query time as well as the response; the actor index limits event scans to this page.
    await client.query("set local statement_timeout='5s'");
    const clock = await client.query<{ period_start: Date; generated_at: Date }>(
      `select (${DASHBOARD_USAGE_RETENTION_CUTOFF_SQL}) as period_start, now() as generated_at`);
    const { period_start: periodStart, generated_at: generatedAt } = clock.rows[0];
    const result = await client.query<{
      actor_key: string; actor_name: string; actor_role: string;
      last_opened_at: Date | null; last_used_at: Date | null; last_interaction_at: Date | null;
      last_dashboard_key: string | null; last_dashboard_title: string | null;
      report_count: number; interaction_count: string; upload_count: string; viewing_seconds: string;
    }>(`with employees as (
      select 'admin:' || id::text as actor_key, coalesce(nullif(name, ''), login) as actor_name, role as actor_role
      from admin_users where is_active = true
      union all
      select 'manager:' || id::text, coalesce(nullif(name, ''), login, email), coalesce(nullif(role, ''), 'manager')
      from wholesale_managers where is_active = true
    ), page as (
      select * from employees
      where ($1::text is null or actor_key > $1) and ($2::text = '' or position(lower($2) in lower(actor_name)) > 0)
      order by actor_key limit 51
    )
    select page.*, activity.last_opened_at, activity.last_used_at, activity.last_interaction_at,
      activity.report_count, activity.interaction_count::text, activity.upload_count::text, duration.viewing_seconds::text,
      latest.dashboard_key as last_dashboard_key,
      coalesce(block.title, case latest.dashboard_key when 'manager:development' then 'Дашборды МР'
        when 'manager:support' then 'Дашборды МС' when 'route-planner' then 'Компоновщик рейсов'
        when 'currency-rates' then 'Курсы валют и медь' else latest.dashboard_key end) as last_dashboard_title
    from page
    cross join lateral (
      select max(created_at) filter (where action = 'report_open') as last_opened_at,
        max(created_at) as last_used_at,
        max(created_at) filter (where action in ('tab_changed','filter_changed','calculation_completed','export_started','file_uploaded') or metadata.upload_name is not null) as last_interaction_at,
        count(distinct dashboard_key)::int as report_count,
        count(*) filter (where action in ('tab_changed','filter_changed','calculation_completed','export_started','file_uploaded') or metadata.upload_name is not null) as interaction_count,
        count(metadata.upload_name) as upload_count
      from dashboard_usage_events event
      left join dashboard_usage_event_details metadata on metadata.usage_event_id = event.id
      where event.actor_key = page.actor_key and not event.is_preview and event.created_at >= $3::timestamptz
    ) activity
    cross join lateral (
      select coalesce(sum(window_seconds), 0) as viewing_seconds from (
        select max(metadata.duration_seconds) as window_seconds
        from dashboard_usage_events event
        join dashboard_usage_event_details metadata on metadata.usage_event_id = event.id
        where event.actor_key = page.actor_key and not event.is_preview and event.created_at >= $3::timestamptz
          and event.action = 'viewing_time'
        group by metadata.viewing_window_id
      ) windows
    ) duration
    left join lateral (
      select dashboard_key from dashboard_usage_events event
      where event.actor_key = page.actor_key and not event.is_preview and event.created_at >= $3::timestamptz
      order by created_at desc, id desc limit 1
    ) latest on true
    left join top_dashboard_blocks block on latest.dashboard_key = 'top:' || block.id::text
    order by page.actor_key`, [input.after ?? null, search, periodStart]);
    const iso = (value: Date | null) => value === null ? null : new Date(value).toISOString();
    const employees = result.rows.slice(0, 50).map((row): DashboardUsageEmployee => ({
      actorKey: row.actor_key, actorName: row.actor_name, actorRole: row.actor_role,
      lastOpenedAt: iso(row.last_opened_at), lastUsedAt: iso(row.last_used_at), lastInteractionAt: iso(row.last_interaction_at),
      lastDashboardKey: row.last_dashboard_key, lastDashboardTitle: row.last_dashboard_title,
      reportCount: row.report_count, interactionCount: Number(row.interaction_count),
      uploadCount: Number(row.upload_count), viewingSeconds: Number(row.viewing_seconds),
    }));
    return { employees, nextCursor: result.rows.length > 50 ? employees.at(-1)!.actorKey : null,
      periodStart: new Date(periodStart).toISOString(), generatedAt: new Date(generatedAt).toISOString() };
  });
}

export type DashboardUsageEmployeeReport = {
  dashboardKey: string; dashboardTitle: string;
  lastOpenedAt: string | null; lastUsedAt: string | null;
  openCount: number; interactionCount: number; uploadCount: number; viewingSeconds: number;
};
export type DashboardUsageEmployeeReports = { reports: DashboardUsageEmployeeReport[]; nextCursor: string | null };

/** Employee drilldown: report totals rather than hundreds of individual time heartbeats. */
export async function listDashboardUsageEmployeeReports(input: { actorKey: string; after?: string }): Promise<DashboardUsageEmployeeReports> {
  if (!/^(?:admin|manager):(?:[1-9][0-9]{0,14}|primary)$/.test(input.actorKey)) throw new Error('Некорректный фильтр');
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await client.query("set local statement_timeout='5s'");
    const result = await client.query<{
      dashboard_key: string; dashboard_title: string; last_opened_at: Date | null; last_used_at: Date | null;
      open_count: string; interaction_count: string; upload_count: string; viewing_seconds: string;
    }>(`with events as materialized (
      select event.dashboard_key, event.action, event.created_at,
        metadata.upload_name, metadata.duration_seconds, metadata.viewing_window_id
      from dashboard_usage_events event
      left join dashboard_usage_event_details metadata on metadata.usage_event_id = event.id
      where event.actor_key = $1 and not event.is_preview
        and event.created_at >= (${DASHBOARD_USAGE_RETENTION_CUTOFF_SQL})
        and ($2::text is null or event.dashboard_key > $2)
    ), activity as (
      select dashboard_key, max(created_at) as last_used_at,
        max(created_at) filter (where action = 'report_open') as last_opened_at,
        count(*) filter (where action = 'report_open') as open_count,
        count(*) filter (where action in ('tab_changed','filter_changed','calculation_completed','export_started','file_uploaded') or upload_name is not null) as interaction_count,
        count(upload_name) as upload_count
      from events group by dashboard_key order by dashboard_key limit 51
    ), windows as (
      select dashboard_key, viewing_window_id, max(duration_seconds) as window_seconds
      from events where action = 'viewing_time' group by dashboard_key, viewing_window_id
    ), durations as (
      select dashboard_key, sum(window_seconds) as viewing_seconds from windows group by dashboard_key
    )
    select activity.dashboard_key,
      coalesce(block.title, case activity.dashboard_key when 'manager:development' then 'Дашборды МР'
        when 'manager:support' then 'Дашборды МС' when 'route-planner' then 'Компоновщик рейсов'
        when 'currency-rates' then 'Курсы валют и медь' else activity.dashboard_key end) as dashboard_title,
      activity.last_opened_at, activity.last_used_at, activity.open_count::text, activity.interaction_count::text,
      activity.upload_count::text, coalesce(durations.viewing_seconds, 0)::text as viewing_seconds
    from activity
    left join durations on durations.dashboard_key = activity.dashboard_key
    left join top_dashboard_blocks block on activity.dashboard_key = 'top:' || block.id::text
    order by activity.dashboard_key`, [input.actorKey, input.after ?? null]);
    const reports = result.rows.slice(0, 50).map((row): DashboardUsageEmployeeReport => ({
      dashboardKey: row.dashboard_key, dashboardTitle: row.dashboard_title,
      lastOpenedAt: row.last_opened_at ? new Date(row.last_opened_at).toISOString() : null,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
      openCount: Number(row.open_count), interactionCount: Number(row.interaction_count),
      uploadCount: Number(row.upload_count), viewingSeconds: Number(row.viewing_seconds),
    }));
    return { reports, nextCursor: result.rows.length > 50 ? reports.at(-1)!.dashboardKey : null };
  });
}

/** Scheduled physical deletion; never prunes HTML, snapshots, users or security audit. */
export async function pruneExpiredDashboardUsage() {
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await client.query("set local lock_timeout='1s'");
    await client.query("set local statement_timeout='5s'");
    const lock = await client.query<{ acquired: boolean }>(
      'select pg_try_advisory_xact_lock(hashtext($1)) as acquired', ['kts:dashboard-usage-retention']);
    if (!lock.rows[0].acquired) return { ok: true, skipped: 'running' as const, deleted: 0, remaining: null, cutoff: null };
    const time = await client.query<{ cutoff: Date }>(`select (${DASHBOARD_USAGE_RETENTION_CUTOFF_SQL}) as cutoff`);
    const cutoff = new Date(time.rows[0].cutoff).toISOString();
    let deleted = 0;
    for (let batch = 0; batch < DASHBOARD_USAGE_PURGE_MAX_BATCHES; batch++) {
      const removed = await client.query(`with expired as (
        select id from dashboard_usage_events where created_at < $1::timestamptz
        order by created_at,id limit $2 for update skip locked
      ) delete from dashboard_usage_events event using expired where event.id=expired.id`,
      [cutoff, DASHBOARD_USAGE_PURGE_BATCH_SIZE]);
      deleted += removed.rowCount ?? 0;
      if ((removed.rowCount ?? 0) < DASHBOARD_USAGE_PURGE_BATCH_SIZE) break;
    }
    const remainder = await client.query<{ remaining: boolean }>(
      'select exists(select 1 from dashboard_usage_events where created_at < $1::timestamptz) as remaining', [cutoff]);
    return { ok: true, skipped: null, deleted, remaining: remainder.rows[0].remaining, cutoff };
  });
}
