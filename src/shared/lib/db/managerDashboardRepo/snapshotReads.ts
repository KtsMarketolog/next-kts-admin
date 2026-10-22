import type { PersonalDashboardRecipient } from '../../managerDashboardRecipients';
import type { PersonalDashboardStatus, SnapshotRow } from './types';
import { checkedRecipient, ownerColumn, positiveId } from './validation';
import { ensureSiteSchema } from '../schema';
import { withTransaction } from '../client';
import { accountSnapshotBinding, authorizeBinding } from './access';
import { SNAPSHOT_SELECT, SNAPSHOT_OWNER_JOIN, mapSnapshot } from './records';
import { personalDashboardToday, PersonalDashboardError } from '../../managerDashboardDomain';
import { createHash } from 'node:crypto';

/** Own-view callers obtain the namespaced recipient from their verified session, never a request parameter. */
export async function getPersonalDashboardStatus(value: number | PersonalDashboardRecipient): Promise<PersonalDashboardStatus> {
  const recipient = checkedRecipient(value);
  const column = ownerColumn(recipient);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const binding = await accountSnapshotBinding(client, recipient);
    if (binding.status !== 'matched') return { audience: binding.audience, email: binding.email, snapshot: null, history: [], bindingStatus: binding.status };
    const result = await client.query<SnapshotRow>(`select ${SNAPSHOT_SELECT}
      from personal_dashboard_snapshots s left join personal_dashboard_snapshot_state st on ${SNAPSHOT_OWNER_JOIN}
      where s.${column}=$1 and s.email_hash=$2 order by s.issued desc, s.id desc limit 32`, [recipient.id, binding.emailHash]);
    const history = result.rows.map(mapSnapshot);
    return { audience: binding.audience, email: binding.email, snapshot: history.find((item) => item.status === 'active') ?? null, history, bindingStatus: 'matched' };
  });
}

export async function getPersonalDashboardSnapshot(value: number | PersonalDashboardRecipient, id?: number) {
  const recipient = checkedRecipient(value);
  const column = ownerColumn(recipient);
  if (id !== undefined) positiveId(id);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const { emailHash, email } = await authorizeBinding(client, recipient);
    const result = await client.query<SnapshotRow & { encrypted_payload: Buffer }>(`select ${SNAPSHOT_SELECT}, s.encrypted_payload
      from personal_dashboard_snapshots s join personal_dashboard_snapshot_state st on ${SNAPSHOT_OWNER_JOIN}
      where s.${column}=$1 and s.email_hash=$2 and s.id=coalesce($3::bigint,st.active_snapshot_id)`, [recipient.id, emailHash, id ?? null]);
    const row = result.rows[0];
    if (!row) return null;
    if (row.expires < personalDashboardToday()) throw new PersonalDashboardError('EXPIRED', 'Срок действия снимка истёк; ожидается новый файл');
    if (row.encrypted_payload.length !== Number(row.file_size)
      || createHash('sha256').update(row.encrypted_payload).digest('hex') !== row.sha256) {
      throw new PersonalDashboardError('SNAPSHOT_INTEGRITY', 'Не удалось проверить целостность снимка');
    }
    return { ...mapSnapshot(row), email, bytes: row.encrypted_payload };
  });
}
