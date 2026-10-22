import type { PoolClient } from 'pg';
import type {
  ImportRow,
  ImportPersonalDashboardSnapshotInput,
  PersonalDashboardImportStatus,
  ImportJournalRow,
} from './types';
import { IMPORT_SELECT, mapImport } from './records';
import {
  type PersonalSnapshotMetadata,
  personalDashboardSafeFilename,
  PersonalDashboardError,
} from '../../managerDashboardDomain';
import type { PersonalDashboardRecipient } from '../../managerDashboardRecipients';
import { safeLogText, sourceKey } from './validation';
import { ensureSiteSchema } from '../schema';
import { withTransaction } from '../client';
import {
  PERSONAL_DASHBOARD_IMPORT_PAGE_SIZE,
  isPersonalDashboardImportCursor,
} from '../../managerDashboardImportPagination';

export async function existingImport(client: PoolClient, key: string) {
  await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`kts-personal-import:${key}`]);
  const prior = await client.query<ImportRow>(`select ${IMPORT_SELECT} from personal_dashboard_imports where source_key=$1`, [key]);
  return prior.rows[0] ? mapImport(prior.rows[0]) : null;
}

export async function logImport(client: PoolClient, input: Omit<ImportPersonalDashboardSnapshotInput, 'bytes'>,
  status: PersonalDashboardImportStatus, code: string, metadata: PersonalSnapshotMetadata | null, recipient: PersonalDashboardRecipient | null = null, snapshotId: number | null = null) {
  const result = await client.query<ImportRow>(`insert into personal_dashboard_imports
    (source_key,original_name,sender,message_id,status,code,manager_id,snapshot_id,email_hash,sha256,issued,admin_user_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    on conflict (source_key) do update set status=excluded.status,code=excluded.code,
      manager_id=excluded.manager_id,admin_user_id=excluded.admin_user_id,snapshot_id=excluded.snapshot_id,email_hash=excluded.email_hash,
      sha256=excluded.sha256,issued=excluded.issued,received_at=now()
    returning ${IMPORT_SELECT}`,
  [input.sourceKey, personalDashboardSafeFilename(input.filename), safeLogText(input.sender, 320), safeLogText(input.messageId, 512),
    status, code, recipient?.source === 'manager' ? recipient.id : null, snapshotId,
    metadata?.emailHash ?? null, metadata?.sha256 ?? null, metadata?.issued ?? null, recipient?.source === 'admin' ? recipient.id : null]);
  // A hard bound prevents malformed mail streams filling the DB with diagnostic metadata.
  // Snapshots retain their own source key and content digest even after old logs age out.
  await client.query(`delete from personal_dashboard_imports where id in
    (select id from personal_dashboard_imports order by id desc offset 5000)`);
  return mapImport(result.rows[0]);
}

export async function recordPersonalDashboardImportFailure(input: {
  filename: string; sourceKey: string; sender?: string; messageId?: string; code: string;
}) {
  const key = sourceKey(input.sourceKey);
  // A caller cannot inject raw IMAP/SMTP exceptions or sensitive data into the diagnostic code.
  const code = ['ATTACHMENT_TOO_LARGE', 'ATTACHMENT_DOWNLOAD_FAILED', 'ATTACHMENT_SIZE_MISMATCH', 'MESSAGE_TOO_LARGE',
    'UNTRUSTED_SENDER', 'INVALID_MESSAGE', 'INVALID_ATTACHMENT', 'SNAPSHOT_SIZE'].includes(input.code) ? input.code : 'ATTACHMENT_FAILED';
  await ensureSiteSchema();
  return withTransaction(async (client) => (await existingImport(client, key)) ?? logImport(client, input, 'invalid', code, null));
}

export async function readPersonalDashboardImportPage(client: PoolClient, before: string | null = null) {
  const result = await client.query<ImportJournalRow>(
    `select ${IMPORT_SELECT},sender,message_id,received_at::text,issued::text from personal_dashboard_imports journal
      ${before === null ? '' : 'where journal.id < $1::bigint'} order by journal.id desc limit ${PERSONAL_DASHBOARD_IMPORT_PAGE_SIZE + 1}`,
    before === null ? [] : [before]);
  const rows = result.rows.slice(0, PERSONAL_DASHBOARD_IMPORT_PAGE_SIZE);
  const performedKey = (row: ImportJournalRow) => ['REPLACED_SAME_DAY', 'SNAPSHOT_ROLLED_BACK'].includes(row.code)
    && /^admin:(?:primary|[1-9][0-9]*)$/.test(row.sender) ? row.sender : null;
  const performerIds = [...new Set(rows.map(performedKey).filter((key): key is string => Boolean(key && key !== 'admin:primary')).map(key => key.slice(6)))];
  const performers = performerIds.length ? (await client.query<{id:string;name:string}>(
    'select id::text,name from admin_users where id=any($1::bigint[])', [performerIds])).rows : [];
  return {
    imports: rows.map((row) => {
      const key = performedKey(row);
      return { ...mapImport(row), id: row.id, sender: row.sender, messageId: row.message_id,
        receivedAt: row.received_at, issued: row.issued,
        ...(key ? {performedByKey: key, performedBy: key === 'admin:primary' ? 'Основной администратор'
          : performers.find(account => account.id === key.slice(6))?.name || 'Удалённая учётная запись администратора'} : {}) };
    }),
    // Do not derive this cursor from mapImport: its legacy numeric id may lose BIGINT precision.
    nextCursor: result.rows.length > PERSONAL_DASHBOARD_IMPORT_PAGE_SIZE ? rows[rows.length - 1].id : null,
  };
}

export async function listPersonalDashboardImports(before: string | null = null) {
  if (before !== null && !isPersonalDashboardImportCursor(before)) {
    throw new PersonalDashboardError('INVALID_CURSOR', 'Некорректный курсор журнала импорта');
  }
  await ensureSiteSchema();
  return withTransaction((client) => readPersonalDashboardImportPage(client, before));
}
