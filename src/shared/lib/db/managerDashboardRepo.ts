import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

import {
  getManagerEmailHash,
  inspectPersonalSnapshot,
  PERSONAL_DASHBOARD_HTML_MAX_BYTES,
  PERSONAL_DASHBOARD_MANAGER_MAX_BYTES,
  PERSONAL_DASHBOARD_MANAGER_MAX_VERSIONS,
  PERSONAL_DASHBOARD_RETENTION_DAYS,
  personalDashboardToday,
  personalDashboardSafeFilename,
  PersonalDashboardError,
  type PersonalSnapshotMetadata,
} from '../managerDashboardDomain';
import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';

export type PersonalDashboardSnapshot = PersonalSnapshotMetadata & {
  id: number;
  managerId: number;
  sourceKey: string;
  receivedAt: string;
  status: 'active' | 'previous' | 'archived';
  expired: boolean;
};
export type PersonalDashboardStatus = {
  snapshot: PersonalDashboardSnapshot | null;
  history: PersonalDashboardSnapshot[];
  bindingStatus: 'matched' | 'missing_email' | 'ambiguous_email';
};
export type PersonalDashboardHtmlVersion = {
  id: number;
  originalName: string;
  fileSize: number;
  sha256: string;
  createdAt: string;
  uploadedBy: string;
  firstPublishedAt: string | null;
  status: 'draft' | 'active' | 'archived';
};
export type PersonalDashboardImportStatus = 'imported' | 'duplicate' | 'unknown' | 'ambiguous' | 'stale' | 'expired' | 'conflict' | 'invalid' | 'quota';
export type PersonalDashboardImportResult = {
  id: number;
  originalName: string;
  status: PersonalDashboardImportStatus;
  code: string;
  message: string;
  managerId: number | null;
  snapshotId: number | null;
};
export type ImportPersonalDashboardSnapshotInput = {
  filename: string;
  bytes: Buffer;
  sourceKey: string;
  sender?: string;
  messageId?: string;
};
export type PersonalDashboardManagerBinding = { id: number; email: string; isActive: boolean; role: string | null };

type ManagerRow = { id: string; name: string; email: string; role: string | null; is_active: boolean };
type SnapshotRow = {
  id: string; manager_id: string; original_name: string; file_size: string; sha256: string;
  email_hash: string; person_name: string; person_role: string; issued: string; expires: string;
  source_key: string; received_at: string; active_snapshot_id: string | null; previous_snapshot_id: string | null;
};
type HtmlRow = {
  id: string; original_name: string; file_size: string; sha256: string; created_at: string;
  uploaded_by: string; first_published_at: string | null;
};
type HtmlStateRow = { active_version_id: string | null; previous_version_id: string | null };
type ImportRow = {
  id: string; original_name: string; status: PersonalDashboardImportStatus; code: string;
  manager_id: string | null; snapshot_id: string | null;
};

const IMPORT_MESSAGES: Record<PersonalDashboardImportStatus, string> = {
  imported: 'Личный снимок сохранён и назначен менеджеру',
  duplicate: 'Этот снимок уже обработан',
  unknown: 'Не найден активный менеджер по развитию с email этого снимка',
  ambiguous: 'Email снимка соответствует нескольким менеджерам; требуется проверка',
  stale: 'Более старый снимок не заменяет текущий',
  expired: 'Срок действия снимка истёк',
  conflict: 'За эту дату уже есть другой снимок; требуется проверка',
  invalid: 'Снимок не прошёл проверку формата или доставки',
  quota: 'Лимит хранения личных снимков достигнут; текущие данные сохранены',
};
const SNAPSHOT_SELECT = `s.id::text, s.manager_id::text, s.original_name, s.file_size::text, s.sha256,
  s.email_hash, s.person_name, s.person_role, s.issued::text, s.expires::text,
  s.source_key, s.received_at::text, st.active_snapshot_id::text, st.previous_snapshot_id::text`;
const HTML_SELECT = `v.id::text, v.original_name, v.file_size::text, v.sha256, v.created_at::text,
  v.uploaded_by, v.first_published_at::text`;
const IMPORT_SELECT = `id::text, original_name, status, code, manager_id::text, snapshot_id::text`;

function positiveId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) throw new PersonalDashboardError('NOT_FOUND', 'Данные не найдены');
}
function idOrNull(id: string | null): number | null { return id === null ? null : Number(id); }
function safeLogText(value: string | undefined, max: number): string {
  return (typeof value === 'string' ? value : '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}
function sourceKey(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PersonalDashboardError('INVALID_SOURCE', 'Некорректный идентификатор импорта');
  }
  return value;
}
function actor(value: string): string {
  if (typeof value !== 'string' || value.length > 160 || !/^(?:admin|admintop|manager):[A-Za-z0-9._:-]+$/.test(value)) {
    throw new PersonalDashboardError('INVALID_ACTOR', 'Не указан автор изменения');
  }
  return value;
}
function mapSnapshot(row: SnapshotRow): PersonalDashboardSnapshot {
  return {
    id: Number(row.id), managerId: Number(row.manager_id), originalName: row.original_name,
    fileSize: Number(row.file_size), sha256: row.sha256, emailHash: row.email_hash,
    name: row.person_name, role: row.person_role, issued: row.issued, expires: row.expires,
    sourceKey: row.source_key, receivedAt: row.received_at,
    status: row.id === row.active_snapshot_id ? 'active' : row.id === row.previous_snapshot_id ? 'previous' : 'archived',
    expired: row.expires < personalDashboardToday(),
  };
}
function mapHtml(row: HtmlRow, activeId: string | null): PersonalDashboardHtmlVersion {
  return {
    id: Number(row.id), originalName: row.original_name, fileSize: Number(row.file_size), sha256: row.sha256,
    createdAt: row.created_at, uploadedBy: row.uploaded_by, firstPublishedAt: row.first_published_at,
    status: row.id === activeId ? 'active' : row.first_published_at ? 'archived' : 'draft',
  };
}
function mapImport(row: ImportRow): PersonalDashboardImportResult {
  return { id: Number(row.id), originalName: row.original_name, status: row.status, code: row.code,
    message: IMPORT_MESSAGES[row.status], managerId: idOrNull(row.manager_id), snapshotId: idOrNull(row.snapshot_id) };
}

/** Hashes are only routing metadata. These checks do not authenticate an attachment or authorize a caller. */
export function resolvePersonalDashboardManager(managers: PersonalDashboardManagerBinding[], emailHash: string) {
  const matches = managers.filter((manager) => manager.isActive && (!manager.role || manager.role === 'manager')
    && manager.email.trim() !== '' && getManagerEmailHash(manager.email) === emailHash);
  return matches.length === 1 ? { status: 'matched' as const, managerId: matches[0].id }
    : { status: matches.length ? 'ambiguous' as const : 'unknown' as const, managerId: null };
}

function bindings(rows: ManagerRow[]): PersonalDashboardManagerBinding[] {
  return rows.map((row) => ({ id: Number(row.id), email: row.email, isActive: row.is_active, role: row.role }));
}
async function currentManagers(client: PoolClient): Promise<ManagerRow[]> {
  // Also prevent a new duplicate-email manager appearing between resolving the identity and reading
  // its bytes. This short table lock conflicts with writes, not with ordinary manager reads.
  await client.query(`lock table wholesale_managers in share mode`);
  // SHARE freezes existing identity bindings while an import/read is in progress. Never use SQL btrim
  // for email normalization: the browser's ECMAScript trim includes Unicode whitespace.
  const result = await client.query<ManagerRow>(`select id::text, name, email, role, is_active
    from wholesale_managers order by id for share`);
  return result.rows;
}
async function authorizeManagerAccount(client: PoolClient, managerId: number) {
  positiveId(managerId);
  const managers = await currentManagers(client);
  const manager = managers.find((row) => Number(row.id) === managerId);
  if (!manager?.is_active || (manager.role && manager.role !== 'manager')) {
    throw new PersonalDashboardError('NOT_FOUND', 'Личный дашборд недоступен');
  }
  return { manager, managers };
}
async function accountSnapshotBinding(client: PoolClient, managerId: number) {
  const { manager, managers } = await authorizeManagerAccount(client, managerId);
  // Access to the shared published HTML requires a valid development-manager account,
  // not a working snapshot email. Snapshot identity is a separate, stricter condition.
  if (!manager.email.trim()) return { status: 'missing_email' as const, emailHash: null };
  const emailHash = getManagerEmailHash(manager.email);
  const binding = resolvePersonalDashboardManager(bindings(managers), emailHash);
  if (binding.managerId !== managerId) return { status: 'ambiguous_email' as const, emailHash: null };
  return { status: 'matched' as const, emailHash };
}
async function authorizeBinding(client: PoolClient, managerId: number) {
  const binding = await accountSnapshotBinding(client, managerId);
  if (binding.status === 'missing_email') throw new PersonalDashboardError('NOT_FOUND', 'Личный снимок недоступен без email менеджера');
  if (binding.status === 'ambiguous_email') throw new PersonalDashboardError('AMBIGUOUS_EMAIL', 'Email менеджера не уникален; обратитесь к администратору');
  return binding.emailHash;
}

/** Callers must obtain managerId from their verified session, never from a request parameter. */
export async function getPersonalDashboardStatus(managerId: number): Promise<PersonalDashboardStatus> {
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const binding = await accountSnapshotBinding(client, managerId);
    if (binding.status !== 'matched') return { snapshot: null, history: [], bindingStatus: binding.status };
    const result = await client.query<SnapshotRow>(`select ${SNAPSHOT_SELECT}
      from personal_dashboard_snapshots s left join personal_dashboard_snapshot_state st on st.manager_id=s.manager_id
      where s.manager_id=$1 and s.email_hash=$2 order by s.issued desc, s.id desc limit 32`, [managerId, binding.emailHash]);
    const history = result.rows.map(mapSnapshot);
    return { snapshot: history.find((item) => item.status === 'active') ?? null, history, bindingStatus: 'matched' };
  });
}

export async function getPersonalDashboardSnapshot(managerId: number, id?: number) {
  if (id !== undefined) positiveId(id);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const emailHash = await authorizeBinding(client, managerId);
    const result = await client.query<SnapshotRow & { encrypted_payload: Buffer }>(`select ${SNAPSHOT_SELECT}, s.encrypted_payload
      from personal_dashboard_snapshots s join personal_dashboard_snapshot_state st on st.manager_id=s.manager_id
      where s.manager_id=$1 and s.email_hash=$2 and s.id=coalesce($3::bigint,st.active_snapshot_id)`, [managerId, emailHash, id ?? null]);
    const row = result.rows[0];
    if (!row) return null;
    if (row.expires < personalDashboardToday()) throw new PersonalDashboardError('EXPIRED', 'Срок действия снимка истёк; ожидается новый файл');
    if (row.encrypted_payload.length !== Number(row.file_size)
      || createHash('sha256').update(row.encrypted_payload).digest('hex') !== row.sha256) {
      throw new PersonalDashboardError('SNAPSHOT_INTEGRITY', 'Не удалось проверить целостность снимка');
    }
    return { ...mapSnapshot(row), bytes: row.encrypted_payload };
  });
}

export async function getPersonalDashboardHtml(id?: number, preview = false) {
  if (id !== undefined) positiveId(id);
  await ensureSiteSchema();
  const result = await query<HtmlRow & { html_content: string; active_version_id: string | null }>(`select ${HTML_SELECT}, v.html_content, st.active_version_id::text
    from personal_dashboard_html_versions v cross join personal_dashboard_html_state st
    where st.id=1 and v.id=coalesce($1::bigint,st.active_version_id)
      and ($2::boolean or (v.id=st.active_version_id and v.first_published_at is not null))`, [id ?? null, preview]);
  const row = result.rows[0];
  return row ? { ...mapHtml(row, row.active_version_id), htmlContent: row.html_content } : null;
}

export async function createPersonalDashboardHtml(input: {
  originalName: string; htmlContent: string; fileSize: number; sha256: string; actorId: string;
}) {
  const size = Buffer.byteLength(input.htmlContent, 'utf8');
  if (size < 1 || size > PERSONAL_DASHBOARD_HTML_MAX_BYTES || size !== input.fileSize
    || createHash('sha256').update(input.htmlContent).digest('hex') !== input.sha256) {
    throw new PersonalDashboardError('HTML_SIZE', 'HTML должен быть непустым файлом размером до 5 МиБ');
  }
  const uploadedBy = actor(input.actorId);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('kts-personal-dashboard-html'))`);
    const quota = await client.query<{ count: string; bytes: string }>(`select count(*)::text as count, coalesce(sum(file_size),0)::text as bytes from personal_dashboard_html_versions`);
    if (Number(quota.rows[0].count) >= 50 || Number(quota.rows[0].bytes) + size > 100 * 1024 * 1024) {
      throw new PersonalDashboardError('HTML_QUOTA', 'Достигнут лимит HTML: 50 версий или 100 МиБ; история не удалена');
    }
    const result = await client.query<HtmlRow>(`insert into personal_dashboard_html_versions
      (original_name,html_content,file_size,sha256,uploaded_by) values ($1,$2,$3,$4,$5)
      returning id::text, original_name, file_size::text, sha256, created_at::text, uploaded_by, first_published_at::text`,
    [personalDashboardSafeFilename(input.originalName), input.htmlContent, size, input.sha256, uploadedBy]);
    return mapHtml(result.rows[0], null);
  });
}

export async function activatePersonalDashboardHtml(input: { versionId: number; expectedActiveVersionId: number | null; actorId: string }) {
  positiveId(input.versionId);
  if (input.expectedActiveVersionId !== null) positiveId(input.expectedActiveVersionId);
  const publishedBy = actor(input.actorId);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('kts-personal-dashboard-html'))`);
    const stateResult = await client.query<HtmlStateRow>(`select active_version_id::text, previous_version_id::text from personal_dashboard_html_state where id=1 for update`);
    const state = stateResult.rows[0];
    if (!state || idOrNull(state.active_version_id) !== input.expectedActiveVersionId) {
      throw new PersonalDashboardError('STATE_CONFLICT', 'Публикация уже изменилась; обновите страницу');
    }
    const found = await client.query(`select id from personal_dashboard_html_versions where id=$1`, [input.versionId]);
    if (!found.rowCount) throw new PersonalDashboardError('NOT_FOUND', 'HTML-версия не найдена');
    if (Number(state.active_version_id) !== input.versionId) {
      await client.query(`update personal_dashboard_html_versions set first_published_at=coalesce(first_published_at,now()),
        first_published_by=coalesce(first_published_by,$2) where id=$1`, [input.versionId, publishedBy]);
      await client.query(`update personal_dashboard_html_state set previous_version_id=active_version_id,
        active_version_id=$1,updated_by=$2,updated_at=now() where id=1`, [input.versionId, publishedBy]);
    }
    // Deliberately no snapshot mutations: HTML publication/rollback never clears personal data.
    return { activeHtmlVersionId: input.versionId,
      previousHtmlVersionId: Number(state.active_version_id) === input.versionId ? idOrNull(state.previous_version_id) : idOrNull(state.active_version_id) };
  });
}

async function existingImport(client: PoolClient, key: string) {
  await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`kts-personal-import:${key}`]);
  const prior = await client.query<ImportRow>(`select ${IMPORT_SELECT} from personal_dashboard_imports where source_key=$1`, [key]);
  return prior.rows[0] ? mapImport(prior.rows[0]) : null;
}
async function logImport(client: PoolClient, input: Omit<ImportPersonalDashboardSnapshotInput, 'bytes'>,
  status: PersonalDashboardImportStatus, code: string, metadata: PersonalSnapshotMetadata | null, managerId: number | null = null, snapshotId: number | null = null) {
  const result = await client.query<ImportRow>(`insert into personal_dashboard_imports
    (source_key,original_name,sender,message_id,status,code,manager_id,snapshot_id,email_hash,sha256,issued)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    on conflict (source_key) do update set status=excluded.status,code=excluded.code,
      manager_id=excluded.manager_id,snapshot_id=excluded.snapshot_id,email_hash=excluded.email_hash,
      sha256=excluded.sha256,issued=excluded.issued,received_at=now()
    returning ${IMPORT_SELECT}`,
  [input.sourceKey, personalDashboardSafeFilename(input.filename), safeLogText(input.sender, 320), safeLogText(input.messageId, 512),
    status, code, managerId, snapshotId, metadata?.emailHash ?? null, metadata?.sha256 ?? null, metadata?.issued ?? null]);
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
    const managers = await currentManagers(client);
    const binding = resolvePersonalDashboardManager(bindings(managers), metadata.emailHash);
    if (binding.status !== 'matched') {
      if (prior?.status === binding.status) return prior;
      return logImport(client, input, binding.status, binding.status === 'unknown' ? 'UNKNOWN_RECIPIENT' : 'AMBIGUOUS_RECIPIENT', metadata);
    }
    const managerId = binding.managerId;
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`kts-personal-manager:${managerId}`]);
    const today = personalDashboardToday();
    if (metadata.expires < today) return logImport(client, input, 'expired', 'EXPIRED_SNAPSHOT', metadata, managerId);
    if (metadata.issued > today) return logImport(client, input, 'invalid', 'FUTURE_SNAPSHOT', metadata, managerId);
    const current = await client.query<SnapshotRow>(`select ${SNAPSHOT_SELECT}
      from personal_dashboard_snapshots s left join personal_dashboard_snapshot_state st on st.manager_id=s.manager_id
      where s.manager_id=$1 order by s.issued desc,s.id desc`, [managerId]);
    const same = current.rows.find((row) => row.sha256 === metadata!.sha256);
    if (same) return logImport(client, input, 'duplicate', 'DUPLICATE_CONTENT', metadata, managerId, Number(same.id));
    const latestBound = current.rows.find((row) => row.email_hash === metadata!.emailHash && row.id === row.active_snapshot_id);
    if (latestBound && latestBound.issued > metadata.issued) return logImport(client, input, 'stale', 'STALE_SNAPSHOT', metadata, managerId);
    if (latestBound && latestBound.issued === metadata.issued) return logImport(client, input, 'conflict', 'SAME_DAY_CONFLICT', metadata, managerId);
    const retentionBefore = Date.now() - PERSONAL_DASHBOARD_RETENTION_DAYS * 86_400_000;
    // Keep the current good copy as well as the incoming one, even when more than 14 days old.
    const retained = current.rows.filter((row, index) => index === 0 || row.id === row.active_snapshot_id || new Date(row.received_at).getTime() >= retentionBefore);
    if (retained.length + 1 > PERSONAL_DASHBOARD_MANAGER_MAX_VERSIONS
      || retained.reduce((sum, row) => sum + Number(row.file_size), 0) + metadata.fileSize > PERSONAL_DASHBOARD_MANAGER_MAX_BYTES) {
      return logImport(client, input, 'quota', 'SNAPSHOT_QUOTA', metadata, managerId);
    }
    const created = await client.query<{ id: string }>(`insert into personal_dashboard_snapshots
      (manager_id,original_name,encrypted_payload,file_size,sha256,email_hash,person_name,person_role,issued,expires,source_key)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id::text`,
    [managerId, metadata.originalName, input.bytes, metadata.fileSize, metadata.sha256, metadata.emailHash,
      metadata.name, metadata.role, metadata.issued, metadata.expires, key]);
    const snapshotId = Number(created.rows[0].id);
    await client.query(`insert into personal_dashboard_snapshot_state (manager_id,active_snapshot_id) values ($1,$2)
      on conflict (manager_id) do update set previous_snapshot_id=personal_dashboard_snapshot_state.active_snapshot_id,
      active_snapshot_id=excluded.active_snapshot_id,updated_at=now()`, [managerId, snapshotId]);
    const retainedIds = new Set(retained.map((row) => row.id));
    const removeIds = current.rows.filter((row) => !retainedIds.has(row.id)).map((row) => row.id);
    if (removeIds.length) await client.query(`delete from personal_dashboard_snapshots where manager_id=$1 and id=any($2::bigint[])`, [managerId, removeIds]);
    return logImport(client, input, 'imported', 'IMPORTED', metadata, managerId, snapshotId);
  });
}

export async function listPersonalDashboardAdmin() {
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const state = await client.query<HtmlStateRow>(`select active_version_id::text,previous_version_id::text from personal_dashboard_html_state where id=1`);
    const versions = await client.query<HtmlRow>(`select ${HTML_SELECT} from personal_dashboard_html_versions v order by v.id desc`);
    const managers = await client.query<ManagerRow>(`select id::text,name,email,role,is_active from wholesale_managers
      where coalesce(nullif(role,''),'manager')='manager' order by is_active desc,name,id`);
    const snapshots = await client.query<SnapshotRow>(`select ${SNAPSHOT_SELECT} from personal_dashboard_snapshot_state st
      join personal_dashboard_snapshots s on s.manager_id=st.manager_id and s.id=st.active_snapshot_id`);
    const imports = await client.query<ImportRow & { sender: string; message_id: string; received_at: string; issued: string | null }>(
      `select ${IMPORT_SELECT},sender,message_id,received_at::text,issued::text from personal_dashboard_imports order by id desc limit 200`);
    const activeId = state.rows[0]?.active_version_id ?? null;
    const managerBindings = bindings(managers.rows);
    return {
      htmlVersions: versions.rows.map((row) => mapHtml(row, activeId)),
      activeHtmlVersionId: idOrNull(activeId),
      previousHtmlVersionId: idOrNull(state.rows[0]?.previous_version_id ?? null),
      managers: managers.rows.map((manager) => {
        const binding = manager.email.trim() ? resolvePersonalDashboardManager(managerBindings, getManagerEmailHash(manager.email)) : null;
        const snapshot = snapshots.rows.find((row) => row.manager_id === manager.id);
        const matches = snapshot && binding?.managerId === Number(manager.id) && snapshot.email_hash === getManagerEmailHash(manager.email);
        return { id: Number(manager.id), name: manager.name, email: manager.email, isActive: manager.is_active,
          bindingStatus: binding?.status ?? 'unknown', snapshot: matches ? mapSnapshot(snapshot) : null };
      }),
      imports: imports.rows.map((row) => ({ ...mapImport(row), sender: row.sender, messageId: row.message_id,
        receivedAt: row.received_at, issued: row.issued })),
    };
  });
}
