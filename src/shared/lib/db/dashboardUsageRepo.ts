import { isTopDashboardManagementSession, type AdminSession } from '../adminAuth';
import { canViewDashboard } from '../dashboardAccess';
import { canManageCurrencyDashboard } from '../currencyDashboardAccess';
import type { DashboardUsageAction, DashboardUsageBatch } from '../dashboardUsage';
import { query } from './client';
import { ensureSiteSchema } from './schema';

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
  const managesReport = batch.dashboardKey === 'currency-rates' ? canManageCurrencyDashboard(session)
    : batch.dashboardKey.startsWith('top:') ? isTopDashboardManagementSession(session)
      : session.role === 'admin' || session.role === 'admintop';
  if (!session.sessionId || !canViewDashboard(session, batch.dashboardKey) || (batch.preview && !managesReport)) {
    throw new Error('Нет доступа к журналу отчёта');
  }
  const actorKey = dashboardUsageActorKey(session);
  await ensureSiteSchema();
  await query(`insert into dashboard_usage_events(actor_key, actor_role, dashboard_key, event_id, action, is_preview, html_version_id)
    select $1, $2, $3, event.id, event.action, $4, $5
    from jsonb_to_recordset($6::jsonb) as event(id text, action text)
    on conflict(actor_key, event_id) do nothing`,
  [actorKey, session.role, batch.dashboardKey, batch.preview, batch.versionId, JSON.stringify(batch.events)]);
}

export type DashboardUsageRow = {
  id: string; actorKey: string; actorName: string; actorRole: string;
  dashboardKey: string; dashboardTitle: string; action: DashboardUsageAction;
  preview: boolean; versionId: number | null; createdAt: string;
};

export async function listDashboardUsage(input: { before?: string; dashboardKey?: string; actorKey?: string; action?: DashboardUsageAction }) {
  await ensureSiteSchema();
  const result = await query<{
    id: string; actor_key: string; actor_name: string; actor_role: string; dashboard_key: string;
    dashboard_title: string; action: DashboardUsageAction; is_preview: boolean; html_version_id: string | null; created_at: Date;
  }>(`select event.id::text, event.actor_key, event.actor_role, event.dashboard_key, event.action, event.is_preview,
      event.html_version_id::text, event.created_at,
      coalesce(nullif(u.name, ''), nullif(m.name, ''), case when event.actor_key = 'admin:primary' then 'Основной администратор' else event.actor_key end) as actor_name,
      coalesce(block.title, case event.dashboard_key when 'manager:development' then 'Дашборды МР'
        when 'manager:support' then 'Дашборды МС' when 'route-planner' then 'Компоновщик рейсов'
        when 'currency-rates' then 'Курсы валют и медь' else event.dashboard_key end) as dashboard_title
    from dashboard_usage_events event
    left join admin_users u on event.actor_key = 'admin:' || u.id::text
    left join wholesale_managers m on event.actor_key = 'manager:' || m.id::text
    left join top_dashboard_blocks block on event.dashboard_key = 'top:' || block.id::text
    where ($1::bigint is null or event.id < $1::bigint)
      and ($2::text is null or event.dashboard_key = $2)
      and ($3::text is null or event.actor_key = $3)
      and ($4::text is null or event.action = $4)
    order by event.id desc limit 51`, [input.before ?? null, input.dashboardKey ?? null, input.actorKey ?? null, input.action ?? null]);
  const rows: DashboardUsageRow[] = result.rows.slice(0, 50).map((row) => ({
    id: row.id, actorKey: row.actor_key, actorName: row.actor_name, actorRole: row.actor_role,
    dashboardKey: row.dashboard_key, dashboardTitle: row.dashboard_title,
    action: row.action, preview: row.is_preview, versionId: row.html_version_id ? Number(row.html_version_id) : null,
    createdAt: new Date(row.created_at).toISOString(),
  }));
  return { events: rows, nextCursor: result.rows.length > 50 ? rows.at(-1)!.id : null };
}
