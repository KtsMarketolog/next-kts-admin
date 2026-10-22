import { ensureSiteSchema } from '../schema';
import { withTransaction } from '../client';
import { DASHBOARD_ACCESS_LOCK } from '../dashboardAccessRepo';
import type { HtmlStateRow, HtmlRow, SnapshotRow } from './types';
import type { PersonalDashboardAudience } from '../../managerDashboardAudience';
import { HTML_SELECT, SNAPSHOT_SELECT, SNAPSHOT_OWNER_JOIN, mapHtml, idOrNull, mapSnapshot } from './records';
import {
  currentRecipientViewContext,
  bindings,
  visiblePersonalRecipients,
  resolvePersonalDashboardRecipient,
} from './access';
import { readPersonalDashboardImportPage } from './importJournal';
import { getManagerEmailHash } from '../../managerDashboardDomain';

export async function listPersonalDashboardAdmin() {
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock_shared(hashtext($1))', [DASHBOARD_ACCESS_LOCK]);
    const state = await client.query<HtmlStateRow & { audience: PersonalDashboardAudience }>(`select audience,active_version_id::text,previous_version_id::text from personal_dashboard_html_state order by id`);
    const versions = await client.query<HtmlRow>(`select ${HTML_SELECT} from personal_dashboard_html_versions v order by v.id desc`);
    const { all: recipients, managerGrants } = await currentRecipientViewContext(client);
    const snapshots = await client.query<SnapshotRow>(`select ${SNAPSHOT_SELECT} from personal_dashboard_snapshot_state st
      join personal_dashboard_snapshots s on ${SNAPSHOT_OWNER_JOIN} and (s.id=st.active_snapshot_id or s.id=st.previous_snapshot_id)`);
    const importPage = await readPersonalDashboardImportPage(client);
    // Resolve email collisions against the whole group, including hidden accounts.
    // View grants only filter the administrator table, never snapshot import/ownership.
    const recipientBindings = bindings(recipients);
    return {
      groups: (['development', 'support'] as const).map((audience) => {
        const groupState = state.rows.find((row) => row.audience === audience);
        const activeId = groupState?.active_version_id ?? null;
        return {
          audience,
          htmlVersions: versions.rows.filter((row) => row.audience === audience).map((row) => mapHtml(row, activeId)),
          activeHtmlVersionId: idOrNull(activeId),
          previousHtmlVersionId: idOrNull(groupState?.previous_version_id ?? null),
          managers: visiblePersonalRecipients(recipients, managerGrants, audience, true)
            .sort((left, right) => left.name.localeCompare(right.name, 'ru') || left.source.localeCompare(right.source) || Number(left.id) - Number(right.id))
            .map((recipient) => {
            const binding = recipient.email.trim() ? resolvePersonalDashboardRecipient(recipientBindings, getManagerEmailHash(recipient.email)) : null;
            const owned = snapshots.rows.filter((row) => recipient.source === 'manager' ? row.manager_id === recipient.id : row.admin_user_id === recipient.id);
            const snapshot = owned.find(row => row.id === row.active_snapshot_id);
            const previous = owned.find(row => row.id === row.previous_snapshot_id && row.email_hash === getManagerEmailHash(recipient.email));
            const matches = snapshot && binding?.recipient?.source === recipient.source && binding.recipient.id === Number(recipient.id)
              && snapshot.email_hash === getManagerEmailHash(recipient.email);
            return { id: Number(recipient.id), source: recipient.source, key: `${recipient.source}:${recipient.id}`,
              name: recipient.name, email: recipient.email, role: recipient.role, isActive: recipient.is_active,
              bindingStatus: binding?.status ?? 'unknown', snapshot: matches ? mapSnapshot(snapshot) : null,
              previousSnapshot: matches && previous ? mapSnapshot(previous) : null };
          }),
        };
      }),
      imports: importPage.imports,
      importsNextCursor: importPage.nextCursor,
    };
  });
}
