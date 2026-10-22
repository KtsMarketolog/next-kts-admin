import type { SnapshotRow, PersonalDashboardReviewer, HtmlRow } from './types';
import { ensureSiteSchema } from '../schema';
import { withTransaction } from '../client';
import { personalReviewContext, personalReviewBinding } from './access';
import { HTML_SELECT, SNAPSHOT_SELECT } from './records';
import { positiveId } from './validation';
import { personalDashboardToday, PersonalDashboardError } from '../../managerDashboardDomain';
import { createHash } from 'node:crypto';

function mapReviewSnapshot(row: SnapshotRow) {
  return { id: Number(row.id), originalName: row.original_name, issued: row.issued,
    expires: row.expires, receivedAt: row.received_at };
}

export async function getPersonalDashboardReviewOverview(viewer: PersonalDashboardReviewer, managerId?: number) {
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const { recipients, all, selected } = await personalReviewContext(client, viewer, managerId);
    const html = await client.query<HtmlRow>(`select ${HTML_SELECT} from personal_dashboard_html_versions v
      join personal_dashboard_html_state st on st.active_version_id=v.id and st.audience=v.audience
      where v.audience='development' and v.first_published_at is not null`);
    const version = html.rows[0];
    const htmlVersion = version ? { id: Number(version.id), originalName: version.original_name,
      audience: 'development' as const, firstPublishedAt: version.first_published_at } : null;
    const managers = recipients.map((manager) => ({ id: Number(manager.id), name: manager.name, email: manager.email.trim().toLowerCase() }));
    if (!selected) return { managers, selected: null, htmlVersion };
    const binding = personalReviewBinding(selected, all);
    const rows = binding.bindingStatus === 'matched' ? await client.query<SnapshotRow>(`select ${SNAPSHOT_SELECT}
      from personal_dashboard_snapshots s left join personal_dashboard_snapshot_state st on st.manager_id=s.manager_id
      where s.manager_id=$1 and s.email_hash=$2 order by s.issued desc,s.id desc limit 32`, [managerId, binding.emailHash]) : { rows: [] };
    const history = rows.rows.map(mapReviewSnapshot);
    const active = rows.rows.find((row) => row.id === row.active_snapshot_id);
    return { managers, htmlVersion, selected: { managerId: Number(selected.id), name: selected.name,
      email: binding.email, audience: 'development' as const, bindingStatus: binding.bindingStatus,
      snapshot: active ? mapReviewSnapshot(active) : null, history } };
  });
}

export async function getPersonalDashboardReviewHtml(viewer: PersonalDashboardReviewer, managerId: number, versionId: number) {
  positiveId(versionId);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await personalReviewContext(client, viewer, managerId);
    const result = await client.query<{html_content: string}>(`select v.html_content from personal_dashboard_html_versions v
      join personal_dashboard_html_state st on st.active_version_id=v.id and st.audience=v.audience
      where v.id=$1 and v.audience='development' and v.first_published_at is not null`, [versionId]);
    return result.rows[0]?.html_content ?? null;
  });
}

export async function getPersonalDashboardReviewSnapshot(viewer: PersonalDashboardReviewer, managerId: number, id?: number) {
  if (id !== undefined) positiveId(id);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const { selected, all } = await personalReviewContext(client, viewer, managerId);
    const binding = personalReviewBinding(selected!, all);
    if (binding.bindingStatus !== 'matched') return null;
    const result = await client.query<SnapshotRow & { encrypted_payload: Buffer }>(`select ${SNAPSHOT_SELECT},s.encrypted_payload
      from personal_dashboard_snapshots s join personal_dashboard_snapshot_state st on st.manager_id=s.manager_id
      where s.manager_id=$1 and s.email_hash=$2 and s.id=coalesce($3::bigint,st.active_snapshot_id)`, [managerId, binding.emailHash, id ?? null]);
    const row = result.rows[0];
    if (!row) return null;
    if (row.expires < personalDashboardToday()) throw new PersonalDashboardError('EXPIRED', 'Срок действия снимка истёк; ожидается новый файл');
    if (row.encrypted_payload.length !== Number(row.file_size)
      || createHash('sha256').update(row.encrypted_payload).digest('hex') !== row.sha256) {
      throw new PersonalDashboardError('SNAPSHOT_INTEGRITY', 'Не удалось проверить целостность снимка');
    }
    return { bytes: row.encrypted_payload, originalName: row.original_name, email: binding.email };
  });
}
