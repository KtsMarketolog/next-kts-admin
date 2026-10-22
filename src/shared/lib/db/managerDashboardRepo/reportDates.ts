import type { AdminSession } from '../../adminAuth';
import type { PersonalDashboardAudience } from '../../managerDashboardAudience';
import type { PersonalDashboardReportDates, RecipientRow } from './types';
import { checkedAudience } from './validation';
import { canViewDashboardKey, hasDashboardManagementRight } from '../../dashboardPermissions';
import { ensureSiteSchema } from '../schema';
import { withTransaction } from '../client';
import {
  personalReviewContext,
  currentRecipientViewContext,
  visiblePersonalRecipients,
  bindings,
  resolvePersonalDashboardRecipient,
} from './access';
import { DASHBOARD_ACCESS_LOCK } from '../dashboardAccessRepo';
import { getManagerEmailHash } from '../../managerDashboardDomain';
import { SNAPSHOT_OWNER_JOIN } from './records';

/** Date-only read of the same recipients visible in the report, never snapshot contents/history. */
export async function getPersonalDashboardReportDates(session: AdminSession, requestedAudience: PersonalDashboardAudience): Promise<PersonalDashboardReportDates> {
  const audience = checkedAudience(requestedAudience);
  const empty: PersonalDashboardReportDates = { dataUploadedAt: null, dataAsOf: null, htmlPublishedAt: null };
  if (!canViewDashboardKey(session, `manager:${audience}`)) return empty;
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    let all: RecipientRow[];
    let recipients: RecipientRow[];
    if (session.role === 'top') {
      // Reuse the persisted TOP authority and team scope, not a second approximation of its rights.
      const context = await personalReviewContext(client, { adminUserId: session.adminUserId!, sessionId: session.sessionId! });
      all = context.all;
      recipients = [...context.recipients, ...all.filter((recipient) => recipient.source === 'admin'
        && Number(recipient.id) === session.adminUserId && recipient.is_active && recipient.role === 'top')];
    } else {
      await client.query('select pg_advisory_xact_lock_shared(hashtext($1))', [DASHBOARD_ACCESS_LOCK]);
      const context = await currentRecipientViewContext(client);
      all = context.all;
      const group = visiblePersonalRecipients(all, context.managerGrants, audience, true);
      recipients = hasDashboardManagementRight(session, `manager:${audience}`) ? group
        : group.filter((recipient) => recipient.source === 'manager' && Number(recipient.id) === session.managerId);
    }
    const html = await client.query<{first_published_at: string | null}>(`select v.first_published_at::text
      from personal_dashboard_html_state st join personal_dashboard_html_versions v
        on v.id=st.active_version_id and v.audience=st.audience where st.audience=$1`, [audience]);
    const dates = { ...empty, htmlPublishedAt: html.rows[0]?.first_published_at ?? null };
    // Hidden accounts still participate in collision detection. Visibility is not ownership.
    const allBindings = bindings(all);
    const hashes = new Map<string, string>();
    const managerIds: string[] = [], adminIds: string[] = [];
    for (const recipient of recipients) {
      if (!recipient.email.trim()) continue;
      const hash = getManagerEmailHash(recipient.email);
      const binding = resolvePersonalDashboardRecipient(allBindings, hash);
      if (binding.recipient?.source !== recipient.source || binding.recipient.id !== Number(recipient.id)) continue;
      hashes.set(`${recipient.source}:${recipient.id}`, hash);
      (recipient.source === 'manager' ? managerIds : adminIds).push(recipient.id);
    }
    if (!hashes.size) return dates;
    const snapshots = await client.query<{
      manager_id: string | null; admin_user_id: string | null; email_hash: string; received_at: string; issued: string;
    }>(`select s.manager_id::text,s.admin_user_id::text,s.email_hash,s.received_at::text,s.issued::text
      from personal_dashboard_snapshot_state st join personal_dashboard_snapshots s
        on ${SNAPSHOT_OWNER_JOIN} and s.id=st.active_snapshot_id
      where s.manager_id=any($1::bigint[]) or s.admin_user_id=any($2::bigint[])
      order by s.received_at desc,s.id desc`, [managerIds, adminIds]);
    const latest = snapshots.rows.find((snapshot) => hashes.get(snapshot.manager_id !== null
      ? `manager:${snapshot.manager_id}` : `admin:${snapshot.admin_user_id}`) === snapshot.email_hash);
    return { ...dates, dataUploadedAt: latest?.received_at ?? null, dataAsOf: latest?.issued ?? null };
  });
}
