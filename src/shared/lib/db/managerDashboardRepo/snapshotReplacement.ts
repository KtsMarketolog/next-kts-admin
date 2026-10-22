import {
  PersonalDashboardError,
  getManagerEmailHash,
  personalDashboardToday,
  PERSONAL_DASHBOARD_MANAGER_MAX_BYTES,
  inspectPersonalSnapshot,
  type PersonalSnapshotMetadata,
} from '../../managerDashboardDomain';
import type { PoolClient } from 'pg';
import type { AdminSession } from '../../adminAuth';
import { currentRecipients, resolvePersonalDashboardRecipient, bindings } from './access';
import type { RecipientRow, SnapshotRow } from './types';
import type { PersonalDashboardRecipient } from '../../managerDashboardRecipients';
import { checkedRecipient, ownerColumn } from './validation';
import { SNAPSHOT_SELECT, SNAPSHOT_OWNER_JOIN, mapSnapshot } from './records';
import {
  personalReplacementDigest,
  createPersonalReplacementToken,
  readPersonalReplacementToken,
} from '../../managerDashboardSnapshotReplacementToken';
import type {
  PersonalSnapshotReplacementFile,
  PersonalSnapshotReplacementPreview,
} from '../../managerDashboardSnapshotReplacement';
import { ensureSiteSchema } from '../schema';
import { withTransaction } from '../client';
import { getDashboardUploadUsageActor } from '../../dashboardUploadUsage';
import { existingImport, logImport } from './importJournal';
import { enqueueDashboardUploadUsage } from '../dashboardUploadUsageOutboxRepo';
import { getPersonalDashboardAudience } from '../../managerDashboardAudience';

type ReplacementFileInput = { filename: string; bytes: Buffer };

type ReplacementState = { active_snapshot_id: string; previous_snapshot_id: string | null; updated_at: string };

const replacementConflict = () => new PersonalDashboardError('REPLACEMENT_CONFLICT', 'Сотрудник или снимки уже изменились. Обновите страницу и сравните файлы заново; текущие данные сохранены.');

/** Account table locks freeze identity, then a persisted session check prevents revoked/fabricated authority. */
async function replacementAccounts(client: PoolClient, session: AdminSession) {
  if (!['admin', 'admintop'].includes(session.role) || !session.sessionId || !/^[a-f0-9-]{36}$/i.test(session.sessionId)
    || (session.role === 'admintop' && (!Number.isSafeInteger(session.adminUserId) || Number(session.adminUserId) < 1))) {
    throw new PersonalDashboardError('REPLACEMENT_FORBIDDEN', 'Нет права заменять личные снимки');
  }
  const accounts = await currentRecipients(client);
  const access = await client.query(`select s.id from admin_sessions s left join admin_users u on u.id=s.admin_user_id
    where s.id=$1::uuid and s.role=$2 and s.admin_user_id is not distinct from $3::bigint and s.manager_id is null
      and s.revoked_at is null and s.expires_at>now()
      and ((s.admin_user_id is null and s.role='admin') or (u.is_active and u.role=s.role
        and (u.password_changed_at is null or s.created_at>=u.password_changed_at))) for share of s`,
  [session.sessionId, session.role, session.adminUserId ?? null]);
  if (!access.rowCount) throw new PersonalDashboardError('REPLACEMENT_FORBIDDEN', 'Нет права заменять личные снимки; войдите заново');
  return accounts;
}

async function replacementContext(client: PoolClient, accounts: RecipientRow[], recipient: PersonalDashboardRecipient) {
  checkedRecipient(recipient);
  const account = accounts.find(row => row.source === recipient.source && Number(row.id) === recipient.id);
  if (!account?.is_active || !account.email.trim()) throw replacementConflict();
  const emailHash = getManagerEmailHash(account.email);
  const binding = resolvePersonalDashboardRecipient(bindings(accounts), emailHash);
  if (binding.status !== 'matched' || binding.recipient.id !== recipient.id || binding.recipient.source !== recipient.source) throw replacementConflict();
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [`kts-personal-${recipient.source}:${recipient.id}`]);
  const column = ownerColumn(recipient);
  const state = (await client.query<ReplacementState>(`select active_snapshot_id::text,previous_snapshot_id::text,updated_at::text
    from personal_dashboard_snapshot_state where ${column}=$1 for update`, [recipient.id])).rows[0];
  const rows = (await client.query<SnapshotRow>(`select ${SNAPSHOT_SELECT} from personal_dashboard_snapshots s
    join personal_dashboard_snapshot_state st on ${SNAPSHOT_OWNER_JOIN} where s.${column}=$1 order by s.id`, [recipient.id])).rows;
  const current = rows.find(row => row.id === state?.active_snapshot_id);
  const previous = rows.find(row => row.id === state?.previous_snapshot_id) ?? null;
  if (!state || !current || current.email_hash !== emailHash) throw replacementConflict();
  const fingerprint = personalReplacementDigest({ recipient, account, state, rows });
  return { account, emailHash, column, state, rows, current, previous, fingerprint };
}

function replacementMetadata(row: SnapshotRow): PersonalSnapshotReplacementFile {
  return { id: Number(row.id), originalName: row.original_name, fileSize: Number(row.file_size), sha256: row.sha256,
    issued: row.issued, expires: row.expires, receivedAt: row.received_at };
}

function checkIncomingReplacement(metadata: PersonalSnapshotMetadata, context: Awaited<ReturnType<typeof replacementContext>>) {
  if (metadata.emailHash !== context.emailHash || metadata.issued !== context.current.issued) throw replacementConflict();
  if (metadata.expires < personalDashboardToday() || metadata.issued > personalDashboardToday()) {
    throw new PersonalDashboardError('INVALID_SNAPSHOT_DATE', 'Снимок просрочен или содержит будущую дату');
  }
  if (context.rows.some(row => row.sha256 === metadata.sha256)) {
    throw new PersonalDashboardError('REPLACEMENT_CONFLICT', 'Этот файл уже сохранён. Для возврата к предыдущему используйте откат.');
  }
  if (Number(context.current.file_size) + metadata.fileSize > PERSONAL_DASHBOARD_MANAGER_MAX_BYTES) {
    throw new PersonalDashboardError('SNAPSHOT_QUOTA', 'Недостаточно места для текущего и предыдущего снимка');
  }
}

export async function preparePersonalDashboardSnapshotReplacement(session: AdminSession, input: ReplacementFileInput): Promise<PersonalSnapshotReplacementPreview> {
  const metadata = inspectPersonalSnapshot(input.bytes, input.filename);
  await ensureSiteSchema();
  return withTransaction(async client => {
    const accounts = await replacementAccounts(client, session);
    const binding = resolvePersonalDashboardRecipient(bindings(accounts), metadata.emailHash);
    if (binding.status !== 'matched') throw new PersonalDashboardError('REPLACEMENT_CONFLICT', 'Email файла не соответствует одному активному сотруднику. Проверьте привязку.');
    const context = await replacementContext(client, accounts, binding.recipient);
    checkIncomingReplacement(metadata, context);
    return { action: 'replace', recipient: { ...binding.recipient, name: context.account.name, email: context.account.email },
      current: replacementMetadata(context.current), previous: context.previous ? replacementMetadata(context.previous) : null,
      incoming: { originalName: metadata.originalName, fileSize: metadata.fileSize, sha256: metadata.sha256, issued: metadata.issued, expires: metadata.expires },
      token: createPersonalReplacementToken(session, { action: 'replace', recipient: binding.recipient,
        fingerprint: context.fingerprint, incoming: personalReplacementDigest(metadata) }) };
  });
}

export async function confirmPersonalDashboardSnapshotReplacement(session: AdminSession, input: ReplacementFileInput & { token: string }) {
  const token = readPersonalReplacementToken(session, input.token, 'replace');
  const metadata = inspectPersonalSnapshot(input.bytes, input.filename);
  if (personalReplacementDigest(metadata) !== token.incoming) throw replacementConflict();
  const usageActor = getDashboardUploadUsageActor(session);
  const key = `replace:${usageActor.actorKey}:${personalReplacementDigest(input.token)}`;
  await ensureSiteSchema();
  return withTransaction(async client => {
    const prior = await existingImport(client, key);
    const accounts = await replacementAccounts(client, session);
    // A repeated confirmed request acknowledges the original commit, never rolls another change back.
    if (prior?.code === 'REPLACED_SAME_DAY') return prior;
    const context = await replacementContext(client, accounts, token.recipient);
    if (context.fingerprint !== token.fingerprint) throw replacementConflict();
    checkIncomingReplacement(metadata, context);
    const snapshotId = Number((await client.query<{id:string}>(`insert into personal_dashboard_snapshots
      (${context.column},original_name,encrypted_payload,file_size,sha256,email_hash,person_name,person_role,issued,expires,source_key)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id::text`, [token.recipient.id, metadata.originalName, input.bytes,
      metadata.fileSize, metadata.sha256, metadata.emailHash, metadata.name, metadata.role, metadata.issued, metadata.expires, key])).rows[0].id);
    const changed = await client.query(`update personal_dashboard_snapshot_state set previous_snapshot_id=active_snapshot_id,
      active_snapshot_id=$2,updated_at=clock_timestamp() where ${context.column}=$1 and active_snapshot_id=$3 and updated_at=$4::timestamptz`,
    [token.recipient.id, snapshotId, context.current.id, context.state.updated_at]);
    if (!changed.rowCount) throw replacementConflict();
    await client.query(`delete from personal_dashboard_snapshots where ${context.column}=$1 and id<>$2 and id<>$3`, [token.recipient.id, context.current.id, snapshotId]);
    await enqueueDashboardUploadUsage(client, usageActor, { dashboardKey: `manager:${token.recipient.source === 'admin' ? 'development' : getPersonalDashboardAudience(context.account.role)!}`,
      versionId: null, resourceKey: `personal-snapshot:${snapshotId}`, name: metadata.originalName, size: metadata.fileSize, type: 'personal' });
    return logImport(client, { filename: metadata.originalName, sourceKey: key, sender: usageActor.actorKey,
      messageId: `replaces-snapshot:${context.current.id}` }, 'imported', 'REPLACED_SAME_DAY', metadata, token.recipient, snapshotId);
  });
}

function checkedRollbackPrevious(context: Awaited<ReturnType<typeof replacementContext>>) {
  if (!context.previous || context.previous.email_hash !== context.emailHash || context.previous.expires < personalDashboardToday()) {
    throw new PersonalDashboardError('REPLACEMENT_CONFLICT', 'Предыдущий снимок отсутствует, просрочен или больше не соответствует email сотрудника');
  }
  return context.previous;
}

export async function preparePersonalDashboardSnapshotRollback(session: AdminSession, recipient: PersonalDashboardRecipient): Promise<PersonalSnapshotReplacementPreview> {
  await ensureSiteSchema();
  return withTransaction(async client => {
    const context = await replacementContext(client, await replacementAccounts(client, session), recipient);
    const previous = checkedRollbackPrevious(context);
    return { action: 'rollback', recipient: { ...recipient, name: context.account.name, email: context.account.email },
      current: replacementMetadata(context.current), incoming: replacementMetadata(previous), previous: replacementMetadata(previous),
      token: createPersonalReplacementToken(session, { action: 'rollback', recipient,
        fingerprint: context.fingerprint, incoming: personalReplacementDigest(previous) }) };
  });
}

export async function confirmPersonalDashboardSnapshotRollback(session: AdminSession, input: {token: string}) {
  const token = readPersonalReplacementToken(session, input.token, 'rollback');
  const usageActor = getDashboardUploadUsageActor(session);
  const key = `rollback:${usageActor.actorKey}:${personalReplacementDigest(input.token)}`;
  await ensureSiteSchema();
  return withTransaction(async client => {
    const prior = await existingImport(client, key);
    const accounts = await replacementAccounts(client, session);
    if (prior?.code === 'SNAPSHOT_ROLLED_BACK') return prior;
    const context = await replacementContext(client, accounts, token.recipient);
    if (context.fingerprint !== token.fingerprint) throw replacementConflict();
    const previous = checkedRollbackPrevious(context);
    if (personalReplacementDigest(previous) !== token.incoming) throw replacementConflict();
    const changed = await client.query(`update personal_dashboard_snapshot_state set active_snapshot_id=previous_snapshot_id,
      previous_snapshot_id=active_snapshot_id,updated_at=clock_timestamp() where ${context.column}=$1 and active_snapshot_id=$2
      and previous_snapshot_id=$3 and updated_at=$4::timestamptz`, [token.recipient.id, context.current.id, previous.id, context.state.updated_at]);
    if (!changed.rowCount) throw replacementConflict();
    // This is a switch to retained bytes, not another file upload. Keep a separate atomic import-journal entry.
    return logImport(client, { filename: previous.original_name, sourceKey: key, sender: usageActor.actorKey,
      messageId: `rollback-from:${context.current.id}` }, 'imported', 'SNAPSHOT_ROLLED_BACK', mapSnapshot(previous), token.recipient, Number(previous.id));
  });
}
