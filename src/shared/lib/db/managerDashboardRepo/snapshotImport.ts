import type { ImportPersonalDashboardSnapshotInput, PersonalDashboardImportResult, SnapshotRow } from './types';
import { sourceKey, ownerColumn } from './validation';
import {
  type PersonalSnapshotMetadata,
  inspectPersonalSnapshot,
  PersonalDashboardError,
  personalDashboardToday,
  PERSONAL_DASHBOARD_MANAGER_MAX_VERSIONS,
  PERSONAL_DASHBOARD_MANAGER_MAX_BYTES,
} from '../../managerDashboardDomain';
import { ensureSiteSchema } from '../schema';
import { withTransaction } from '../client';
import { existingImport, logImport } from './importJournal';
import { IMPORT_MESSAGES, SNAPSHOT_SELECT, SNAPSHOT_OWNER_JOIN } from './records';
import { currentRecipients, resolvePersonalDashboardRecipient, bindings } from './access';
import { enqueueDashboardUploadUsage } from '../dashboardUploadUsageOutboxRepo';
import { getPersonalDashboardAudience } from '../../managerDashboardAudience';

export async function importPersonalDashboardSnapshot(input: ImportPersonalDashboardSnapshotInput): Promise<PersonalDashboardImportResult> {
  const key = sourceKey(input.sourceKey);
  let metadata: PersonalSnapshotMetadata | null = null;
  let invalidCode = '';
  try { metadata = inspectPersonalSnapshot(input.bytes, input.filename); }
  catch (error) {
    if (!(error instanceof PersonalDashboardError)) throw error;
    invalidCode = error.code;
  }
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const prior = await existingImport(client, key);
    const retryable = prior && ['unknown', 'ambiguous', 'quota'].includes(prior.status);
    if (prior && !retryable) return { ...prior, status: prior.status === 'imported' ? 'duplicate' : prior.status, message: prior.status === 'imported' ? IMPORT_MESSAGES.duplicate : prior.message };
    if (!metadata) return logImport(client, input, 'invalid', invalidCode || 'INVALID_SNAPSHOT', null);
    const recipients = await currentRecipients(client);
    const binding = resolvePersonalDashboardRecipient(bindings(recipients), metadata.emailHash);
    if (binding.status !== 'matched') {
      if (prior?.status === binding.status) return prior;
      return logImport(client, input, binding.status, binding.status === 'unknown' ? 'UNKNOWN_RECIPIENT' : 'AMBIGUOUS_RECIPIENT', metadata);
    }
    const recipient = binding.recipient;
    const column = ownerColumn(recipient);
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`kts-personal-${recipient.source}:${recipient.id}`]);
    const today = personalDashboardToday();
    if (metadata.expires < today) return logImport(client, input, 'expired', 'EXPIRED_SNAPSHOT', metadata, recipient);
    if (metadata.issued > today) return logImport(client, input, 'invalid', 'FUTURE_SNAPSHOT', metadata, recipient);
    const current = await client.query<SnapshotRow>(`select ${SNAPSHOT_SELECT}
      from personal_dashboard_snapshots s left join personal_dashboard_snapshot_state st on ${SNAPSHOT_OWNER_JOIN}
      where s.${column}=$1 order by s.issued desc,s.id desc`, [recipient.id]);
    const same = current.rows.find((row) => row.sha256 === metadata!.sha256);
    if (same) return logImport(client, input, 'duplicate', 'DUPLICATE_CONTENT', metadata, recipient, Number(same.id));
    const latestBound = current.rows.find((row) => row.email_hash === metadata!.emailHash && row.id === row.active_snapshot_id);
    if (latestBound && latestBound.issued > metadata.issued) return logImport(client, input, 'stale', 'STALE_SNAPSHOT', metadata, recipient);
    if (latestBound && latestBound.issued === metadata.issued) return logImport(client, input, 'conflict', 'SAME_DAY_CONFLICT', metadata, recipient);
    // The actual active snapshot becomes previous, even if its date/order/email binding changed.
    // Compute quota before any mutation, then prune only after the new active pointer is stored.
    const retained = current.rows.filter((row) => row.id === row.active_snapshot_id);
    if (retained.length + 1 > PERSONAL_DASHBOARD_MANAGER_MAX_VERSIONS
      || retained.reduce((sum, row) => sum + Number(row.file_size), 0) + metadata.fileSize > PERSONAL_DASHBOARD_MANAGER_MAX_BYTES) {
      return logImport(client, input, 'quota', 'SNAPSHOT_QUOTA', metadata, recipient);
    }
    const created = await client.query<{ id: string }>(`insert into personal_dashboard_snapshots
      (${column},original_name,encrypted_payload,file_size,sha256,email_hash,person_name,person_role,issued,expires,source_key)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id::text`,
    [recipient.id, metadata.originalName, input.bytes, metadata.fileSize, metadata.sha256, metadata.emailHash,
      metadata.name, metadata.role, metadata.issued, metadata.expires, key]);
    const snapshotId = Number(created.rows[0].id);
    await client.query(`insert into personal_dashboard_snapshot_state (${column},active_snapshot_id) values ($1,$2)
      on conflict (${column}) do update set previous_snapshot_id=personal_dashboard_snapshot_state.active_snapshot_id,
      active_snapshot_id=excluded.active_snapshot_id,updated_at=now()`, [recipient.id, snapshotId]);
    const retainedIds = new Set(retained.map((row) => row.id));
    const removeIds = current.rows.filter((row) => !retainedIds.has(row.id)).map((row) => row.id);
    if (removeIds.length) await client.query(`delete from personal_dashboard_snapshots where ${column}=$1 and id=any($2::bigint[])`, [recipient.id, removeIds]);
    if (input.usageActor) await enqueueDashboardUploadUsage(client, input.usageActor, {
      dashboardKey: `manager:${recipient.source === 'admin' ? 'development' : getPersonalDashboardAudience(recipients.find(row => row.source === recipient.source && Number(row.id) === recipient.id)!.role)!}`,
      versionId: null, resourceKey: `personal-snapshot:${snapshotId}`, name: metadata.originalName, size: metadata.fileSize, type: 'personal',
    });
    return logImport(client, input, 'imported', 'IMPORTED', metadata, recipient, snapshotId);
  });
}
