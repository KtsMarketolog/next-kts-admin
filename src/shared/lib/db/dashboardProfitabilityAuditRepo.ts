import { createHash } from 'node:crypto';
import type { AdminSession } from '../adminAuth';
import { canViewDashboard } from '../dashboardAccess';
import { canReviewDashboardUsage } from '../dashboardUsageAccess';
import {
  MAX_PROFITABILITY_AUDIT_BODY,
  parseProfitabilityAuditRequest,
  type ProfitabilityAuditRequest,
  type ProfitabilityInvoice,
} from '../dashboardProfitabilityAudit';
import { isSupportedProfitabilityHtml } from '../dashboardProfitabilityHtml';
import { query, withTransaction } from './client';
import { DASHBOARD_USAGE_RETENTION_CUTOFF_SQL, dashboardUsageActorKey } from './dashboardUsageRepo';
import { ensureSiteSchema } from './schema';

export class ProfitabilityAuditError extends Error {
  constructor(public readonly status: 403 | 409, message: string) {
    super(message);
    this.name = 'ProfitabilityAuditError';
  }
}

function denied(): never {
  throw new ProfitabilityAuditError(403, 'Нет доступа к детализации отчёта');
}

/** Recheck the persisted identity and current grants, not a stale caller-supplied role. */
async function assertCurrentSession(
  db: { query: typeof query },
  session: AdminSession,
  scope?: { dashboardKey: string; preview: boolean },
) {
  if (!session.sessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.sessionId)) denied();
  const result = await db.query<{ allowed: boolean }>(`
    select true as allowed
    from admin_sessions s
    left join admin_users u on u.id = s.admin_user_id
    left join wholesale_managers m on m.id = s.manager_id
    where s.id = $1::uuid and s.role = $2 and s.revoked_at is null and s.expires_at > now()
      and s.admin_user_id is not distinct from $3::bigint
      and s.manager_id is not distinct from $4::bigint
      and (
        (s.role = 'admin' and s.admin_user_id is null and s.manager_id is null)
        or (s.role in ('admin','admintop','top','purchaser','wholesale_admin')
          and u.is_active and u.role = s.role
          and (u.password_changed_at is null or u.password_changed_at <= s.created_at))
        or (s.role in ('manager','support_manager') and m.is_active
          and coalesce(nullif(m.role,''),'manager') = s.role
          and (m.password_changed_at is null or m.password_changed_at <= s.created_at))
      )
      and (
        ($5::text is null and s.role in ('admin','admintop','top'))
        or ($5::text is not null and (
          s.role in ('admin','admintop')
          or (s.role = 'top' and u.can_manage_top_dashboard)
          or (s.role in ('manager','support_manager') and m.can_manage_top_dashboard)
          or (not $6::boolean and exists (
            select 1 from dashboard_effective_view_grants access
            where access.key = $5 and (access.admin_user_id = s.admin_user_id or access.manager_id = s.manager_id)
          ))
        ))
      )
    limit 1`, [session.sessionId, session.role, session.adminUserId ?? null, session.managerId ?? null,
    scope?.dashboardKey ?? null, scope?.preview ?? false]);
  if (!result.rows[0]?.allowed) denied();
}

export async function recordDashboardProfitabilityAudit(
  session: AdminSession,
  request: ProfitabilityAuditRequest,
): Promise<{ id: string }> {
  const input = parseProfitabilityAuditRequest(request);
  if (!canViewDashboard(session, input.dashboardKey)) denied();
  const actorKey = dashboardUsageActorKey(session);
  const serialized = JSON.stringify(input.invoice);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PROFITABILITY_AUDIT_BODY) {
    throw new Error('Некорректная детализация');
  }
  const payloadHash = createHash('sha256').update(serialized).digest('hex');
  const blockId = Number(input.dashboardKey.slice(4));
  await ensureSiteSchema();
  await assertCurrentSession({ query }, session, input);

  // A supported report may intentionally have no shared data snapshot. Verify the
  // actual immutable HTML, outside the write transaction; never trust its filename.
  const html = await query<{ html_content: string; sha256: string }>(`
    select html_content, sha256 from top_dashboard_block_versions
    where block_id = $1 and id = $2`, [blockId, input.versionId]);
  const version = html.rows[0];
  if (!version || !isSupportedProfitabilityHtml(version.html_content)) denied();

  return withTransaction(async (client) => {
    await client.query("set local lock_timeout = '2s'");
    await client.query("set local statement_timeout = '5s'");
    await assertCurrentSession(client, session, input);
    // Match the publication path's lock order: state first, then the HTML row.
    const state = await client.query<{ active_version_id: string | null }>(`
      select active_version_id::text from top_dashboard_block_state where block_id = $1 for share`, [blockId]);
    if (!state.rows[0] || (!input.preview && Number(state.rows[0].active_version_id) !== input.versionId)) denied();
    const current = await client.query<{ sha256: string }>(`
      select sha256 from top_dashboard_block_versions where block_id = $1 and id = $2 for share`, [blockId, input.versionId]);
    if (!current.rows[0] || current.rows[0].sha256 !== version.sha256) denied();

    const inserted = await client.query<{ id: string }>(`
      insert into dashboard_usage_events(actor_key, actor_role, dashboard_key, event_id, action, is_preview, html_version_id)
      values ($1, $2, $3, $4, 'data_loaded', $5, $6)
      on conflict(actor_key, event_id) do nothing returning id::text`,
    [actorKey, session.role, input.dashboardKey, input.eventId, input.preview, input.versionId]);
    const id = inserted.rows[0]?.id;
    if (id) {
      await client.query(`insert into dashboard_profitability_audit_details(usage_event_id, invoice, payload_sha256)
        values ($1, $2::jsonb, $3)`, [id, serialized, payloadHash]);
      return { id };
    }

    // Same actor + event id is an immutable retry. A collision with an unrelated
    // generic event or altered financial data must not rewrite or append details.
    const existing = await client.query<{ id: string; matches: boolean }>(`
      select event.id::text, (
        event.dashboard_key = $3 and event.action = 'data_loaded'
        and event.is_preview = $4 and event.html_version_id = $5
        and details.payload_sha256 = $6
      ) as matches
      from dashboard_usage_events event
      left join dashboard_profitability_audit_details details on details.usage_event_id = event.id
      where event.actor_key = $1 and event.event_id = $2
      for share of event`,
    [actorKey, input.eventId, input.dashboardKey, input.preview, input.versionId, payloadHash]);
    if (existing.rows[0]?.matches !== true) {
      throw new ProfitabilityAuditError(409, 'Событие уже сохранено с другими данными');
    }
    return { id: existing.rows[0].id };
  });
}

export async function readDashboardProfitabilityAudit(
  session: AdminSession,
  id: string,
): Promise<ProfitabilityInvoice | null> {
  if (!canReviewDashboardUsage(session)) denied();
  if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > BigInt('9223372036854775807')) return null;
  await ensureSiteSchema();
  await assertCurrentSession({ query }, session);
  const result = await query<{ invoice: ProfitabilityInvoice }>(`
    select details.invoice from dashboard_profitability_audit_details details
    join dashboard_usage_events event on event.id = details.usage_event_id
    where event.id = $1::bigint and event.created_at >= (${DASHBOARD_USAGE_RETENTION_CUTOFF_SQL})`, [id]);
  return result.rows[0]?.invoice ?? null;
}
