import type { AdminSession } from '../adminAuth';
import { getReportEntries } from '../dashboardAccess';
import { query } from './client';
import { ensureSiteSchema } from './schema';
import { getPersonalDashboardStatus } from './managerDashboardRepo';

export type DashboardReportDates = {
  key: string; dataUploadedAt: string | null; dataAsOf: string | null; htmlPublishedAt: string | null;
  automaticCheckedAt?: string | null;
};
type DatesRow = { data_uploaded_at: string | null; data_as_of: string | null; html_published_at: string | null };

/** Only date metadata, scoped exactly like the reports; never exposes another manager's file. */
export async function getDashboardReportDates(session: AdminSession): Promise<DashboardReportDates[]> {
  await ensureSiteSchema();
  const entries = getReportEntries(session);
  return Promise.all(entries.map(async ({ key }) => {
    const empty: DashboardReportDates = { key, dataUploadedAt: null, dataAsOf: null, htmlPublishedAt: null };
    if (key === 'currency-rates') {
      const result = await query<{ checked_at: string | null; saved_at: string | null }>(`
        select (select max(fetched_at)::text from currency_dashboard_cache
          where key in ('currency:cbr-daily','currency:moex-currency','currency:moex-futures','currency:copper','currency:world')) as checked_at,
          current_snapshot->>'savedAt' as saved_at from currency_dashboard_state where id=1`);
      return { ...empty, dataUploadedAt: result.rows[0]?.saved_at ?? null, automaticCheckedAt: result.rows[0]?.checked_at ?? null };
    }
    if (key === 'route-planner') {
      const result = await query<DatesRow>(`select html.first_published_at::text as html_published_at,
        case when html.format='route-planner-v1' then json.received_at else snapshot.received_at end::text as data_uploaded_at,
        case when html.format='route-planner-v1' then json.saved_at::text else snapshot.issued::text end as data_as_of
        from support_shared_dashboard_state state
        left join support_shared_dashboard_html_versions html on html.id=state.active_html_version_id
        left join support_shared_dashboard_snapshots snapshot on snapshot.id=state.active_snapshot_id
        left join support_shared_dashboard_json_state json_state on json_state.html_version_id=html.id
        left join support_shared_dashboard_json_snapshots json on json.id=json_state.active_snapshot_id
        where state.id=1`);
      const row = result.rows[0];
      return { ...empty, dataUploadedAt: row?.data_uploaded_at ?? null, dataAsOf: row?.data_as_of ?? null, htmlPublishedAt: row?.html_published_at ?? null };
    }
    const audience = key === 'manager:development' ? 'development' : 'support';
    const canSeeGroup = session.role === 'admin' || session.role === 'admintop';
    // An extra group checkbox does not give a manager another group's private snapshot dates.
    const ownAudience = session.role === 'manager' ? 'development' : session.role === 'support_manager' ? 'support' : null;
    const managerId = ownAudience === audience ? session.managerId ?? null : null;
    const result = await query<DatesRow>(`select html.first_published_at::text as html_published_at,
      latest.received_at::text as data_uploaded_at, latest.issued::text as data_as_of
      from personal_dashboard_html_state state
      left join personal_dashboard_html_versions html on html.id=state.active_version_id
      left join lateral (
        select snapshot.received_at, snapshot.issued from personal_dashboard_snapshot_state snapshots
        join personal_dashboard_snapshots snapshot on snapshot.id=snapshots.active_snapshot_id and snapshot.manager_id=snapshots.manager_id
        join wholesale_managers manager on manager.id=snapshots.manager_id
        where ($2::boolean and coalesce(nullif(manager.role,''),'manager')=$3)
        order by snapshot.received_at desc limit 1
      ) latest on true where state.audience=$1`, [audience, canSeeGroup, audience === 'development' ? 'manager' : 'support_manager']);
    const row = result.rows[0];
    if (!canSeeGroup && managerId) {
      const personal = await getPersonalDashboardStatus(managerId);
      const snapshot = personal.bindingStatus === 'matched' ? personal.snapshot : null;
      return { ...empty, dataUploadedAt: snapshot?.receivedAt ?? null, dataAsOf: snapshot?.issued ?? null, htmlPublishedAt: row?.html_published_at ?? null };
    }
    return { ...empty, dataUploadedAt: row?.data_uploaded_at ?? null, dataAsOf: row?.data_as_of ?? null, htmlPublishedAt: row?.html_published_at ?? null };
  }));
}
