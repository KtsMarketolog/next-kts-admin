import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';

export const CURRENCY_HTML_MAX_BYTES = 2 * 1024 * 1024;
const MAX_STORED_HTML_BYTES = 100 * 1024 * 1024;

export type CurrencyDashboardHtmlVersion = {
  id: number; originalName: string; fileSize: number; sha256: string;
  sourceVersion: string; createdAt: string; createdBy: string;
};
export type CurrencyDashboardHtmlState = {
  versions: CurrencyDashboardHtmlVersion[]; activeVersionId: number | null;
  previousVersionId: number | null; revision: number;
};
export type CurrencyDashboardHtmlInput = { htmlContent: string; originalName: string; sourceVersion: string };
type VersionRow = {
  id: string; original_name: string; file_size: number; sha256: string;
  source_version: string; created_at: Date; created_by: string; html_content?: string;
};
type StateRow = { active_version_id: string | null; previous_version_id: string | null; revision: string };
const VERSION_COLUMNS = 'id::text,original_name,file_size,sha256,source_version,created_at,created_by';

export class CurrencyHtmlError extends Error {
  constructor(message: string, readonly code = 'CURRENCY_HTML_INVALID', readonly status = 400) { super(message); this.name = 'CurrencyHtmlError'; }
}
export class CurrencyHtmlConflictError extends CurrencyHtmlError {
  constructor(readonly currentRevision: number) {
    super('Версия уже изменена другим пользователем. Обновите список и повторите действие.', 'CURRENCY_HTML_CONFLICT', 409);
  }
}

function safeInteger(value: unknown, zero = false): number {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) < (zero ? 0 : 1)) throw new CurrencyHtmlError('Некорректный номер версии');
  return Number(number);
}
function actor(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f]/.test(value)) throw new CurrencyHtmlError('Некорректный автор изменения');
  return value;
}
function validate(input: CurrencyDashboardHtmlInput) {
  if (typeof input.htmlContent !== 'string' || !input.htmlContent.trim() || input.htmlContent.includes('\u0000')) throw new CurrencyHtmlError('Пустой или повреждённый HTML');
  const fileSize = Buffer.byteLength(input.htmlContent, 'utf8');
  if (fileSize > CURRENCY_HTML_MAX_BYTES) throw new CurrencyHtmlError('HTML больше 2 МБ', 'CURRENCY_HTML_TOO_LARGE', 413);
  if (typeof input.originalName !== 'string' || !input.originalName.trim() || input.originalName.length > 255 || /[\u0000-\u001f/\\]/.test(input.originalName)) throw new CurrencyHtmlError('Некорректное имя HTML-файла');
  if (typeof input.sourceVersion !== 'string' || !input.sourceVersion.trim() || input.sourceVersion.length > 40 || /[\u0000-\u001f]/.test(input.sourceVersion)) throw new CurrencyHtmlError('Не удалось определить версию HTML');
  return { fileSize, sha256: createHash('sha256').update(input.htmlContent, 'utf8').digest('hex') };
}
function version(row: VersionRow): CurrencyDashboardHtmlVersion {
  return { id: safeInteger(row.id), originalName: row.original_name, fileSize: row.file_size, sha256: row.sha256,
    sourceVersion: row.source_version, createdAt: row.created_at.toISOString(), createdBy: row.created_by };
}
function state(row: StateRow, versions: VersionRow[]): CurrencyDashboardHtmlState {
  return { revision: safeInteger(row.revision, true), activeVersionId: row.active_version_id === null ? null : safeInteger(row.active_version_id),
    previousVersionId: row.previous_version_id === null ? null : safeInteger(row.previous_version_id), versions: versions.map(version) };
}
async function readState(runQuery: typeof query): Promise<CurrencyDashboardHtmlState> {
  const result = await runQuery<StateRow>('select active_version_id::text,previous_version_id::text,revision::text from currency_dashboard_html_state where id=1');
  if (!result.rows[0]) throw new Error('Currency HTML state is missing');
  const versions = await runQuery<VersionRow>(`select ${VERSION_COLUMNS} from currency_dashboard_html_versions order by id desc`);
  return state(result.rows[0], versions.rows);
}
async function lock(client: PoolClient) {
  const row = (await client.query<StateRow>('select active_version_id::text,previous_version_id::text,revision::text from currency_dashboard_html_state where id=1 for update')).rows[0];
  if (!row) throw new Error('Currency HTML state is missing');
  return row;
}
async function insert(client: PoolClient, input: CurrencyDashboardHtmlInput, createdBy: string): Promise<VersionRow> {
  const data = validate(input);
  const old = (await client.query<VersionRow>(`select ${VERSION_COLUMNS} from currency_dashboard_html_versions where sha256=$1`, [data.sha256])).rows[0];
  if (old) return old;
  const stored = (await client.query<{ total: string }>('select coalesce(sum(file_size),0)::text as total from currency_dashboard_html_versions')).rows[0];
  if (Number(stored.total) + data.fileSize > MAX_STORED_HTML_BYTES) throw new CurrencyHtmlError('Хранилище HTML заполнено. Обратитесь к администратору: опубликованная версия и история сохранены.', 'CURRENCY_HTML_QUOTA', 409);
  return (await client.query<VersionRow>(`insert into currency_dashboard_html_versions
    (original_name,html_content,file_size,sha256,source_version,created_by) values($1,$2,$3,$4,$5,$6)
    returning ${VERSION_COLUMNS}`, [input.originalName, input.htmlContent, data.fileSize, data.sha256, input.sourceVersion, actor(createdBy)])).rows[0];
}
async function checkedVersion(client: { query: typeof query }, versionId: number) {
  const row = (await client.query<VersionRow>(`select ${VERSION_COLUMNS},html_content from currency_dashboard_html_versions where id=$1`, [safeInteger(versionId)])).rows[0];
  if (!row) return null;
  const content = row.html_content;
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') !== row.file_size
    || createHash('sha256').update(content, 'utf8').digest('hex') !== row.sha256) {
    throw new CurrencyHtmlError('Проверка целостности HTML не пройдена. Действующая версия не изменена.', 'CURRENCY_HTML_INTEGRITY', 409);
  }
  return { version: version(row), htmlContent: content };
}

export async function getCurrencyDashboardHtmlState(): Promise<CurrencyDashboardHtmlState> {
  await ensureSiteSchema();
  // Metadata and pointers must describe one publication, even during concurrent publishes.
  return withTransaction(async (client) => {
    await client.query('set transaction isolation level repeatable read read only');
    return readState(client.query.bind(client));
  });
}

/** First installation only. Future deploys never overwrite an administrator's published version. */
export async function ensureCurrencyDashboardHtmlSeed(input: { current: CurrencyDashboardHtmlInput; previous?: CurrencyDashboardHtmlInput }) {
  await ensureSiteSchema();
  const existing = (await query<{ active_version_id: string | null }>('select active_version_id::text from currency_dashboard_html_state where id=1')).rows[0];
  if (existing?.active_version_id) return;
  validate(input.current);
  if (input.previous) validate(input.previous);
  await withTransaction(async (client) => {
    const row = await lock(client);
    if (row.active_version_id !== null) return;
    const previous = input.previous ? await insert(client, input.previous, 'system:builtin') : null;
    const current = await insert(client, input.current, 'system:builtin');
    await client.query(`update currency_dashboard_html_state set active_version_id=$1,previous_version_id=$2,
      revision=1,updated_by='system:builtin',updated_at=now() where id=1`, [current.id, previous && previous.id !== current.id ? previous.id : null]);
  });
}

export async function createCurrencyDashboardHtmlVersion(input: CurrencyDashboardHtmlInput & { actor: string }) {
  validate(input); actor(input.actor);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await lock(client);
    const created = await insert(client, input, input.actor);
    return { ...await readState(client.query.bind(client)), version: version(created) };
  });
}

export async function publishCurrencyDashboardHtmlVersion(versionId: number, expectedRevision: number, changedBy: string) {
  safeInteger(versionId); safeInteger(expectedRevision, true); actor(changedBy);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const row = await lock(client);
    if (safeInteger(row.revision, true) !== expectedRevision) throw new CurrencyHtmlConflictError(Number(row.revision));
    if (!await checkedVersion(client, versionId)) throw new CurrencyHtmlError('HTML-версия не найдена', 'CURRENCY_HTML_NOT_FOUND', 404);
    if (Number(row.active_version_id) === versionId) return readState(client.query.bind(client));
    await client.query(`update currency_dashboard_html_state set previous_version_id=active_version_id,active_version_id=$1,
      revision=revision+1,updated_by=$2,updated_at=now() where id=1`, [versionId, changedBy]);
    return readState(client.query.bind(client));
  });
}

export async function rollbackCurrencyDashboardHtmlVersion(expectedRevision: number, changedBy: string) {
  safeInteger(expectedRevision, true); actor(changedBy);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const row = await lock(client);
    if (safeInteger(row.revision, true) !== expectedRevision) throw new CurrencyHtmlConflictError(Number(row.revision));
    if (!row.previous_version_id) throw new CurrencyHtmlError('Предыдущей опубликованной HTML-версии ещё нет', 'CURRENCY_HTML_NO_PREVIOUS');
    if (!await checkedVersion(client, safeInteger(row.previous_version_id))) throw new CurrencyHtmlError('Предыдущая версия не найдена', 'CURRENCY_HTML_NOT_FOUND', 404);
    await client.query(`update currency_dashboard_html_state set active_version_id=previous_version_id,previous_version_id=active_version_id,
      revision=revision+1,updated_by=$1,updated_at=now() where id=1`, [changedBy]);
    return readState(client.query.bind(client));
  });
}

/** Caller must require management access for drafts. Never expose raw HTML as an unsandboxed document. */
export async function getCurrencyDashboardHtmlVersion(versionId: number) {
  safeInteger(versionId);
  await ensureSiteSchema();
  return checkedVersion({ query }, versionId);
}

export async function getPublishedCurrencyDashboardHtml() {
  await ensureSiteSchema();
  // Fetch one selected immutable version; a concurrent publish cannot change its bytes.
  const row = (await query<{ active_version_id: string | null }>('select active_version_id::text from currency_dashboard_html_state where id=1')).rows[0];
  return row?.active_version_id ? checkedVersion({ query }, safeInteger(row.active_version_id)) : null;
}
