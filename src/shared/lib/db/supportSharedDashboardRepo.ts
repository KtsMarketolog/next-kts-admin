import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

import {
  getManagerEmailHash, inspectPersonalSnapshot, PERSONAL_DASHBOARD_HTML_MAX_BYTES,
  PERSONAL_DASHBOARD_MANAGER_MAX_BYTES, PERSONAL_DASHBOARD_MANAGER_MAX_VERSIONS,
  PERSONAL_DASHBOARD_RETENTION_DAYS, personalDashboardSafeFilename, personalDashboardToday,
  PersonalDashboardError, type PersonalSnapshotMetadata,
} from '../managerDashboardDomain';
import type { PersonalDashboardHtmlVersion } from './managerDashboardRepo';
import { detectSupportSharedHtmlFormat } from '../supportSharedRoutePlannerHtml';
import {
  openVerifiedSupportSharedRoutePlannerFile, SUPPORT_SHARED_JSON_MAX_BYTES,
  SUPPORT_SHARED_JSON_MAX_VERSIONS, SUPPORT_SHARED_JSON_TOTAL_MAX_BYTES,
} from '../supportSharedRoutePlannerData';
import { deleteTopDashboardDataFiles } from '../topDashboardDataStorage';
import { withTransaction } from './client';
import { ensureSiteSchema } from './schema';

export type SupportSharedDashboardSnapshot = PersonalSnapshotMetadata & {
  id: number;
  email: string;
  receivedAt: string;
  uploadedBy: string;
  status: 'active' | 'previous' | 'archived';
  expired: boolean;
};
export type SupportSharedDashboardOverview = {
  htmlVersions: SupportSharedDashboardHtmlVersion[];
  activeHtmlVersionId: number | null;
  previousHtmlVersionId: number | null;
  snapshot: SupportSharedDashboardSnapshot | null;
  history: SupportSharedDashboardSnapshot[];
  jsonSnapshot: SupportSharedDashboardJsonSnapshot | null;
  jsonHistory: SupportSharedDashboardJsonSnapshot[];
};
export type SupportSharedDashboardHtmlVersion = PersonalDashboardHtmlVersion & { format: 'ktsp' | 'route-planner-v1' };
export type SupportSharedDashboardJsonSnapshot = {
  id: number; htmlVersionId: number; originalName: string; fileSize: number; sha256: string;
  savedAt: string; receivedAt: string; uploadedBy: string; status: 'active' | 'previous' | 'archived';
};

type StateRow = {
  active_html_version_id: string | null; previous_html_version_id: string | null;
  active_snapshot_id: string | null; previous_snapshot_id: string | null;
};
type HtmlRow = {
  id: string; original_name: string; file_size: string; sha256: string; created_at: string;
  uploaded_by: string; first_published_at: string | null;
  format: SupportSharedDashboardHtmlVersion['format'];
};
type JsonRow = {
  id: string; html_version_id: string; original_name: string; file_size: string; sha256: string;
  storage_path: string; saved_at: string; received_at: string; uploaded_by: string;
  active_snapshot_id: string | null; previous_snapshot_id: string | null;
};
type SnapshotRow = {
  id: string; original_name: string; file_size: string; sha256: string; recipient_email: string;
  email_hash: string; person_name: string; person_role: string; issued: string; expires: string;
  uploaded_by: string; received_at: string;
};
const HTML_SELECT = `id::text, original_name, file_size::text, sha256, created_at::text, uploaded_by, first_published_at::text, format`;
const JSON_SELECT = `s.id::text,s.html_version_id::text,s.original_name,s.file_size::text,s.sha256,s.storage_path,
  s.saved_at::text,s.received_at::text,s.uploaded_by,st.active_snapshot_id::text,st.previous_snapshot_id::text`;
const SNAPSHOT_SELECT = `id::text, original_name, file_size::text, sha256, recipient_email, email_hash,
  person_name, person_role, issued::text, expires::text, uploaded_by, received_at::text`;
const SHARED_LOCK = 'kts-support-shared-dashboard';

function positiveId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) throw new PersonalDashboardError('NOT_FOUND', 'Данные не найдены');
}
function actor(value: string): string {
  if (typeof value !== 'string' || value.length > 160 || !/^(?:admin|admintop):[A-Za-z0-9._:-]+$/.test(value)) {
    throw new PersonalDashboardError('INVALID_ACTOR', 'Не указан администратор изменения');
  }
  return value;
}
function recipientEmail(value: string): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email) || /[\u0000-\u001f\u007f]/.test(email)) {
    throw new PersonalDashboardError('INVALID_EMAIL', 'Укажите email получателя общего снимка');
  }
  return email;
}
function idOrNull(value: string | null): number | null { return value === null ? null : Number(value); }
function mapHtml(row: HtmlRow, state: StateRow): SupportSharedDashboardHtmlVersion {
  return { id: Number(row.id), audience: 'support', originalName: row.original_name, fileSize: Number(row.file_size),
    format: row.format ?? 'ktsp',
    sha256: row.sha256, createdAt: row.created_at, uploadedBy: row.uploaded_by, firstPublishedAt: row.first_published_at,
    status: row.id === state.active_html_version_id ? 'active' : row.first_published_at ? 'archived' : 'draft' };
}
function mapJson(row: JsonRow): SupportSharedDashboardJsonSnapshot {
  return { id: Number(row.id), htmlVersionId: Number(row.html_version_id), originalName: row.original_name,
    fileSize: Number(row.file_size), sha256: row.sha256, savedAt: new Date(row.saved_at).toISOString(),
    receivedAt: row.received_at, uploadedBy: row.uploaded_by,
    status: row.id === row.active_snapshot_id ? 'active' : row.id === row.previous_snapshot_id ? 'previous' : 'archived' };
}
function mapSnapshot(row: SnapshotRow, state: StateRow): SupportSharedDashboardSnapshot {
  return { id: Number(row.id), originalName: row.original_name, fileSize: Number(row.file_size), sha256: row.sha256,
    email: row.recipient_email, emailHash: row.email_hash, name: row.person_name, role: row.person_role,
    issued: row.issued, expires: row.expires, uploadedBy: row.uploaded_by, receivedAt: row.received_at,
    status: row.id === state.active_snapshot_id ? 'active' : row.id === state.previous_snapshot_id ? 'previous' : 'archived',
    expired: row.expires < personalDashboardToday() };
}

/** managerId must come from the verified persisted session. Email does not grant access to this report. */
async function authorizeSupportManager(client: PoolClient, managerId: number) {
  positiveId(managerId);
  const result = await client.query<{ role: string | null; is_active: boolean }>(
    `select role,is_active from wholesale_managers where id=$1 for share`, [managerId]);
  if (!result.rows[0]?.is_active || result.rows[0].role !== 'support_manager') {
    throw new PersonalDashboardError('NOT_FOUND', 'Общий дашборд сопровождения недоступен');
  }
}

async function sharedState(client: PoolClient, mutation = false): Promise<StateRow> {
  if (mutation) await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [SHARED_LOCK]);
  const result = await client.query<StateRow>(`select active_html_version_id::text,previous_html_version_id::text,
    active_snapshot_id::text,previous_snapshot_id::text from support_shared_dashboard_state where id=1 for ${mutation ? 'update' : 'share'}`);
  if (!result.rows[0]) throw new PersonalDashboardError('STATE_CONFLICT', 'Состояние общего отчёта изменилось; обновите страницу');
  return result.rows[0];
}

/** Omitting managerId is an administrator-only contract; the route must verify that role. */
export async function getSupportSharedDashboardOverview(managerId?: number): Promise<SupportSharedDashboardOverview> {
  if (managerId !== undefined) positiveId(managerId);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    if (managerId !== undefined) await authorizeSupportManager(client, managerId);
    const state = await sharedState(client);
    const versions = await client.query<HtmlRow>(`select ${HTML_SELECT} from support_shared_dashboard_html_versions
      ${managerId === undefined ? '' : 'where id=$1 and first_published_at is not null'} order by id desc`,
    managerId === undefined ? [] : [state.active_html_version_id]);
    const snapshots = await client.query<SnapshotRow>(`select ${SNAPSHOT_SELECT} from support_shared_dashboard_snapshots
      order by issued desc,id desc limit ${PERSONAL_DASHBOARD_MANAGER_MAX_VERSIONS}`);
    const history = snapshots.rows.map((row) => mapSnapshot(row, state));
    const activeHtml = versions.rows.find((row) => row.id === state.active_html_version_id);
    const jsonHistory = activeHtml?.format === 'route-planner-v1'
      ? (await client.query<JsonRow>(`select ${JSON_SELECT} from support_shared_dashboard_json_snapshots s
        join support_shared_dashboard_json_state st on st.html_version_id=s.html_version_id
        where s.html_version_id=$1 order by s.id desc limit ${SUPPORT_SHARED_JSON_MAX_VERSIONS}`, [activeHtml.id])).rows.map(mapJson) : [];
    return { htmlVersions: versions.rows.map((row) => mapHtml(row, state)),
      activeHtmlVersionId: idOrNull(state.active_html_version_id),
      previousHtmlVersionId: managerId === undefined ? idOrNull(state.previous_html_version_id) : null,
      snapshot: history.find((snapshot) => snapshot.status === 'active') ?? null, history,
      jsonSnapshot: jsonHistory.find((snapshot) => snapshot.status === 'active') ?? null, jsonHistory };
  });
}

/** preview=true is administrator-only. Published reads always recheck the support account inside this transaction. */
export async function getSupportSharedDashboardHtml(id: number | undefined, preview: boolean, managerId?: number) {
  if (id !== undefined) positiveId(id);
  if (!preview) positiveId(managerId as number);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    if (!preview) await authorizeSupportManager(client, managerId as number);
    const state = await sharedState(client);
    const selectedId = id ?? idOrNull(state.active_html_version_id);
    if (selectedId === null || (!preview && selectedId !== idOrNull(state.active_html_version_id))) return null;
    const result = await client.query<HtmlRow & { html_content: string }>(`select ${HTML_SELECT},html_content
      from support_shared_dashboard_html_versions where id=$1 ${preview ? '' : 'and first_published_at is not null'}`, [selectedId]);
    const row = result.rows[0];
    if (!row) return null;
    if (Buffer.byteLength(row.html_content, 'utf8') !== Number(row.file_size)
      || createHash('sha256').update(row.html_content).digest('hex') !== row.sha256) {
      throw new PersonalDashboardError('HTML_INTEGRITY', 'Не удалось проверить целостность HTML');
    }
    return { ...mapHtml(row, state), htmlContent: row.html_content };
  });
}

export async function getSupportSharedDashboardSnapshot(managerId: number, id?: number) {
  positiveId(managerId);
  if (id !== undefined) positiveId(id);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await authorizeSupportManager(client, managerId);
    const state = await sharedState(client);
    const selectedId = id ?? idOrNull(state.active_snapshot_id);
    if (selectedId === null) return null;
    const result = await client.query<SnapshotRow & { encrypted_payload: Buffer }>(`select ${SNAPSHOT_SELECT},encrypted_payload
      from support_shared_dashboard_snapshots where id=$1`, [selectedId]);
    const row = result.rows[0];
    if (!row) return null;
    if (row.expires < personalDashboardToday()) throw new PersonalDashboardError('EXPIRED', 'Срок действия общего снимка истёк; ожидается новый файл');
    if (row.encrypted_payload.length !== Number(row.file_size)
      || createHash('sha256').update(row.encrypted_payload).digest('hex') !== row.sha256
      || getManagerEmailHash(row.recipient_email) !== row.email_hash) {
      throw new PersonalDashboardError('SNAPSHOT_INTEGRITY', 'Не удалось проверить целостность общего снимка');
    }
    return { ...mapSnapshot(row, state), bytes: row.encrypted_payload };
  });
}

export async function createSupportSharedDashboardHtml(input: {
  originalName: string; htmlContent: string; fileSize: number; sha256: string; actorId: string;
}) {
  const uploadedBy = actor(input.actorId);
  const size = typeof input.htmlContent === 'string' ? Buffer.byteLength(input.htmlContent, 'utf8') : 0;
  if (size < 1 || size > PERSONAL_DASHBOARD_HTML_MAX_BYTES || size !== input.fileSize
    || createHash('sha256').update(input.htmlContent).digest('hex') !== input.sha256) {
    throw new PersonalDashboardError('HTML_SIZE', 'HTML должен быть непустым файлом размером до 5 МиБ');
  }
  const format = detectSupportSharedHtmlFormat(input.htmlContent);
  if (!format) throw new PersonalDashboardError('HTML_FORMAT', 'Нужен совместимый HTML личного отчёта или компоновщика рейсов');
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const state = await sharedState(client, true);
    const quota = await client.query<{ count: string; bytes: string }>(`select count(*)::text as count,
      coalesce(sum(file_size),0)::text as bytes from support_shared_dashboard_html_versions`);
    if (Number(quota.rows[0].count) >= 50 || Number(quota.rows[0].bytes) + size > 100 * 1024 * 1024) {
      throw new PersonalDashboardError('HTML_QUOTA', 'Достигнут лимит HTML: 50 версий или 100 МиБ; история не удалена');
    }
    const result = await client.query<HtmlRow>(`insert into support_shared_dashboard_html_versions
      (original_name,html_content,file_size,sha256,uploaded_by,format) values ($1,$2,$3,$4,$5,$6) returning ${HTML_SELECT}`,
    [personalDashboardSafeFilename(input.originalName), input.htmlContent, size, input.sha256, uploadedBy, format]);
    if (format === 'route-planner-v1') await client.query(`insert into support_shared_dashboard_json_state (html_version_id) values ($1)`, [result.rows[0].id]);
    return mapHtml(result.rows[0], state);
  });
}

export async function activateSupportSharedDashboardHtml(input: {
  versionId: number; expectedActiveVersionId: number | null; actorId: string;
}) {
  positiveId(input.versionId);
  if (input.expectedActiveVersionId !== null) positiveId(input.expectedActiveVersionId);
  const publishedBy = actor(input.actorId);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const state = await sharedState(client, true);
    if (idOrNull(state.active_html_version_id) !== input.expectedActiveVersionId) {
      throw new PersonalDashboardError('STATE_CONFLICT', 'Публикация уже изменилась; обновите страницу');
    }
    const found = await client.query(`select id from support_shared_dashboard_html_versions where id=$1`, [input.versionId]);
    if (!found.rowCount) throw new PersonalDashboardError('NOT_FOUND', 'HTML-версия не найдена');
    if (idOrNull(state.active_html_version_id) !== input.versionId) {
      await client.query(`update support_shared_dashboard_html_versions set first_published_at=coalesce(first_published_at,now()),
        first_published_by=coalesce(first_published_by,$2) where id=$1`, [input.versionId, publishedBy]);
      await client.query(`update support_shared_dashboard_state set previous_html_version_id=active_html_version_id,
        active_html_version_id=$1,updated_by=$2,updated_at=now() where id=1`, [input.versionId, publishedBy]);
    }
    return { activeHtmlVersionId: input.versionId, previousHtmlVersionId: idOrNull(state.active_html_version_id) === input.versionId
      ? idOrNull(state.previous_html_version_id) : idOrNull(state.active_html_version_id) };
  });
}

export async function deleteSupportSharedDashboardHtml(input: { versionId: number; actorId: string }) {
  positiveId(input.versionId);
  const deletedBy = actor(input.actorId);
  await ensureSiteSchema();
  const result = await withTransaction(async (client) => {
    const state = await sharedState(client, true);
    if (idOrNull(state.active_html_version_id) === input.versionId) {
      throw new PersonalDashboardError('ACTIVE_VERSION_CONFLICT', 'Нельзя удалить опубликованный HTML. Сначала опубликуйте другую версию.');
    }
    const found = await client.query<{ format: string }>(`select id,format from support_shared_dashboard_html_versions where id=$1`, [input.versionId]);
    if (!found.rowCount) throw new PersonalDashboardError('NOT_FOUND', 'HTML-версия не найдена');
    const files = found.rows[0].format === 'route-planner-v1'
      ? (await client.query<{ storage_path: string }>(`select storage_path from support_shared_dashboard_json_snapshots where html_version_id=$1`, [input.versionId])).rows : [];
    await client.query(`update support_shared_dashboard_state
      set previous_html_version_id=case when previous_html_version_id=$1 then null else previous_html_version_id end,
        updated_by=$2,updated_at=now() where id=1`, [input.versionId, deletedBy]);
    const deleted = await client.query(`delete from support_shared_dashboard_html_versions where id=$1 returning id`, [input.versionId]);
    if (deleted.rowCount !== 1) throw new PersonalDashboardError('STATE_CONFLICT', 'HTML-версия уже изменилась; обновите страницу');
    return { deletedVersionId: input.versionId, paths: files.map((file) => file.storage_path) };
  });
  // Delete files only after a confirmed database commit; an uncertain commit must retain recoverable bytes.
  await deleteTopDashboardDataFiles(result.paths).catch(() => { console.error('Shared route planner file cleanup failed'); });
  return { deletedVersionId: result.deletedVersionId };
}

async function requireActiveJsonHtml(client: PoolClient, state: StateRow, htmlVersionId: number) {
  if (idOrNull(state.active_html_version_id) !== htmlVersionId) {
    throw new PersonalDashboardError('STATE_CONFLICT', 'Общий HTML уже изменился; обновите страницу');
  }
  const html = await client.query<{ format: string }>(`select format from support_shared_dashboard_html_versions
    where id=$1 and first_published_at is not null`, [htmlVersionId]);
  if (html.rows[0]?.format !== 'route-planner-v1') throw new PersonalDashboardError('HTML_FORMAT', 'Этот HTML не принимает JSON компоновщика');
}

/** Cheap metadata/CAS preflight before a route consumes the upload body. The import repeats it under its mutation lock. */
export async function assertSupportSharedJsonUploadTarget(htmlVersionId: number, expectedActiveSnapshotId: number | null) {
  positiveId(htmlVersionId);
  if (expectedActiveSnapshotId !== null) positiveId(expectedActiveSnapshotId);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const state = await sharedState(client);
    await requireActiveJsonHtml(client, state, htmlVersionId);
    const result = await client.query<{ active_snapshot_id: string | null }>(`select active_snapshot_id::text from support_shared_dashboard_json_state where html_version_id=$1`, [htmlVersionId]);
    if (!result.rows[0] || idOrNull(result.rows[0].active_snapshot_id) !== expectedActiveSnapshotId) {
      throw new PersonalDashboardError('STATE_CONFLICT', 'Общий JSON уже изменился; обновите страницу');
    }
  });
}

export async function getSupportSharedDashboardJsonSnapshot(managerId: number, htmlVersionId: number, id?: number) {
  positiveId(managerId); positiveId(htmlVersionId);
  if (id !== undefined) positiveId(id);
  await ensureSiteSchema();
  let stream: Awaited<ReturnType<typeof openVerifiedSupportSharedRoutePlannerFile>> | undefined;
  try {
    return await withTransaction(async (client) => {
      await authorizeSupportManager(client, managerId);
      const state = await sharedState(client);
      await requireActiveJsonHtml(client, state, htmlVersionId);
      const result = await client.query<JsonRow>(`select ${JSON_SELECT} from support_shared_dashboard_json_snapshots s
        join support_shared_dashboard_json_state st on st.html_version_id=s.html_version_id
        where s.html_version_id=$1 and s.id=coalesce($2::bigint,st.active_snapshot_id)`, [htmlVersionId, id ?? null]);
      const row = result.rows[0];
      if (!row) return null;
      stream = await openVerifiedSupportSharedRoutePlannerFile(row.storage_path, Number(row.file_size), row.sha256);
      return { ...mapJson(row), stream };
    });
  } catch (error) { stream?.destroy(); throw error; }
}

/** Internal validated-file contract; routes inspect the complete JSON stream before committing its private file. */
export async function importSupportSharedDashboardJson(input: {
  htmlVersionId: number; expectedActiveSnapshotId: number | null; originalName: string; savedAt: string;
  fileSize: number; sha256: string; storagePath: string; actorId: string;
}): Promise<{ status: 'imported' | 'duplicate'; snapshot: SupportSharedDashboardJsonSnapshot; prunedStoragePaths: string[] }> {
  positiveId(input.htmlVersionId);
  if (input.expectedActiveSnapshotId !== null) positiveId(input.expectedActiveSnapshotId);
  const uploadedBy = actor(input.actorId);
  if (!Number.isSafeInteger(input.fileSize) || input.fileSize < 1 || input.fileSize > SUPPORT_SHARED_JSON_MAX_BYTES
    || !/^[0-9a-f]{64}$/.test(input.sha256)
    || !/^[0-9a-f]{2}\/[0-9a-f]{64}-[0-9a-f-]{36}\.bin$/.test(input.storagePath)
    || !input.storagePath.startsWith(`${input.sha256.slice(0, 2)}/${input.sha256}-`)
    || !Number.isFinite(Date.parse(input.savedAt)) || !/\.json$/i.test(input.originalName)) {
    throw new PersonalDashboardError('INVALID_JSON_SNAPSHOT', 'Некорректные метаданные JSON');
  }
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const state = await sharedState(client, true);
    await requireActiveJsonHtml(client, state, input.htmlVersionId);
    const current = await client.query<JsonRow>(`select ${JSON_SELECT} from support_shared_dashboard_json_snapshots s
      join support_shared_dashboard_json_state st on st.html_version_id=s.html_version_id
      where s.html_version_id=$1 order by s.id desc`, [input.htmlVersionId]);
    const same = current.rows.find((row) => row.sha256 === input.sha256);
    if (same) return { status: 'duplicate', snapshot: mapJson(same), prunedStoragePaths: [] };
    const jsonState = await client.query<{ active_snapshot_id: string | null }>(`select active_snapshot_id::text from support_shared_dashboard_json_state where html_version_id=$1 for update`, [input.htmlVersionId]);
    if (!jsonState.rows[0] || idOrNull(jsonState.rows[0].active_snapshot_id) !== input.expectedActiveSnapshotId) {
      throw new PersonalDashboardError('STATE_CONFLICT', 'Общий JSON уже изменился; обновите страницу');
    }
    const active = current.rows.find((row) => row.id === jsonState.rows[0].active_snapshot_id);
    if (active && Date.parse(input.savedAt) < Date.parse(active.saved_at)) throw new PersonalDashboardError('STALE_SNAPSHOT', 'Более старый JSON не заменяет текущий');
    if (active && Date.parse(input.savedAt) === Date.parse(active.saved_at)) throw new PersonalDashboardError('SAME_TIME_CONFLICT', 'За это время уже есть другой JSON');
    const retained = current.rows.slice(0, SUPPORT_SHARED_JSON_MAX_VERSIONS - 1);
    const remove = current.rows.filter((row) => !retained.includes(row));
    const quota = await client.query<{ bytes: string }>(`select coalesce(sum(file_size),0)::text as bytes from support_shared_dashboard_json_snapshots`);
    if (Number(quota.rows[0].bytes) - remove.reduce((sum, row) => sum + Number(row.file_size), 0) + input.fileSize > SUPPORT_SHARED_JSON_TOTAL_MAX_BYTES) {
      throw new PersonalDashboardError('SNAPSHOT_QUOTA', 'Достигнут лимит хранения общих JSON: 1 ГиБ; текущие данные сохранены');
    }
    const created = await client.query<Omit<JsonRow, 'active_snapshot_id' | 'previous_snapshot_id'>>(`insert into support_shared_dashboard_json_snapshots
      (html_version_id,original_name,file_size,sha256,storage_path,saved_at,uploaded_by) values ($1,$2,$3,$4,$5,$6,$7)
      returning id::text,html_version_id::text,original_name,file_size::text,sha256,storage_path,saved_at::text,received_at::text,uploaded_by`,
    [input.htmlVersionId, personalDashboardSafeFilename(input.originalName), input.fileSize, input.sha256, input.storagePath, input.savedAt, uploadedBy]);
    const row = created.rows[0];
    await client.query(`update support_shared_dashboard_json_state set previous_snapshot_id=active_snapshot_id,
      active_snapshot_id=$2,updated_by=$3,updated_at=now() where html_version_id=$1`, [input.htmlVersionId, row.id, uploadedBy]);
    if (remove.length) await client.query(`delete from support_shared_dashboard_json_snapshots where html_version_id=$1 and id=any($2::bigint[])`, [input.htmlVersionId, remove.map((item) => item.id)]);
    return { status: 'imported', snapshot: mapJson({ ...row, active_snapshot_id: row.id, previous_snapshot_id: jsonState.rows[0].active_snapshot_id }),
      prunedStoragePaths: remove.map((item) => item.storage_path) };
  });
}

export async function importSupportSharedDashboardSnapshot(input: {
  filename: string; bytes: Buffer; email: string; actorId: string; expectedActiveSnapshotId: number | null;
}): Promise<{ status: 'imported' | 'duplicate'; snapshot: SupportSharedDashboardSnapshot }> {
  const uploadedBy = actor(input.actorId);
  if (input.expectedActiveSnapshotId !== null) positiveId(input.expectedActiveSnapshotId);
  const email = recipientEmail(input.email);
  const metadata = inspectPersonalSnapshot(input.bytes, input.filename);
  if (getManagerEmailHash(email) !== metadata.emailHash) {
    throw new PersonalDashboardError('EMAIL_MISMATCH', 'Email получателя не соответствует общему снимку');
  }
  const today = personalDashboardToday();
  if (metadata.expires < today) throw new PersonalDashboardError('EXPIRED_SNAPSHOT', 'Срок действия общего снимка истёк');
  if (metadata.issued > today) throw new PersonalDashboardError('FUTURE_SNAPSHOT', 'Дата выпуска общего снимка ещё не наступила');
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const state = await sharedState(client, true);
    const current = await client.query<SnapshotRow>(`select ${SNAPSHOT_SELECT} from support_shared_dashboard_snapshots order by issued desc,id desc`);
    const same = current.rows.find((row) => row.sha256 === metadata.sha256);
    // Idempotent retries never change publication, even when a concurrent successful upload changed the CAS token.
    if (same) return { status: 'duplicate', snapshot: mapSnapshot(same, state) };
    if (idOrNull(state.active_snapshot_id) !== input.expectedActiveSnapshotId) {
      throw new PersonalDashboardError('STATE_CONFLICT', 'Общий снимок уже изменился; обновите страницу');
    }
    const active = current.rows.find((row) => row.id === state.active_snapshot_id);
    if (active && active.issued > metadata.issued) throw new PersonalDashboardError('STALE_SNAPSHOT', 'Более старый снимок не заменяет текущий');
    if (active && active.issued === metadata.issued) throw new PersonalDashboardError('SAME_DAY_CONFLICT', 'За эту дату уже есть другой общий снимок');
    const retentionBefore = Date.now() - PERSONAL_DASHBOARD_RETENTION_DAYS * 86_400_000;
    // The current copy becomes the previous copy and is retained regardless of age.
    const retained = current.rows.filter((row) => row.id === state.active_snapshot_id || new Date(row.received_at).getTime() >= retentionBefore);
    if (retained.length + 1 > PERSONAL_DASHBOARD_MANAGER_MAX_VERSIONS
      || retained.reduce((sum, row) => sum + Number(row.file_size), 0) + metadata.fileSize > PERSONAL_DASHBOARD_MANAGER_MAX_BYTES) {
      throw new PersonalDashboardError('SNAPSHOT_QUOTA', 'Достигнут лимит хранения общих снимков; текущие данные сохранены');
    }
    const created = await client.query<SnapshotRow>(`insert into support_shared_dashboard_snapshots
      (original_name,encrypted_payload,file_size,sha256,recipient_email,email_hash,person_name,person_role,issued,expires,uploaded_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning ${SNAPSHOT_SELECT}`,
    [metadata.originalName, input.bytes, metadata.fileSize, metadata.sha256, email, metadata.emailHash,
      metadata.name, metadata.role, metadata.issued, metadata.expires, uploadedBy]);
    const row = created.rows[0];
    await client.query(`update support_shared_dashboard_state set previous_snapshot_id=active_snapshot_id,
      active_snapshot_id=$1,updated_by=$2,updated_at=now() where id=1`, [row.id, uploadedBy]);
    const retainedIds = new Set(retained.map((item) => item.id));
    const removeIds = current.rows.filter((item) => !retainedIds.has(item.id)).map((item) => item.id);
    if (removeIds.length) await client.query(`delete from support_shared_dashboard_snapshots where id=any($1::bigint[])`, [removeIds]);
    return { status: 'imported', snapshot: mapSnapshot(row, { ...state, active_snapshot_id: row.id, previous_snapshot_id: state.active_snapshot_id }) };
  });
}
