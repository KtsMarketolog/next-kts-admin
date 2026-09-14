import { createHash } from 'node:crypto';

export const PERSONAL_DASHBOARD_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
export const PERSONAL_DASHBOARD_HTML_MAX_BYTES = 5 * 1024 * 1024;
// 14 daily maximum-size files (112 MiB) plus room for the next atomic replacement.
export const PERSONAL_DASHBOARD_MANAGER_MAX_BYTES = 128 * 1024 * 1024;
export const PERSONAL_DASHBOARD_MANAGER_MAX_VERSIONS = 32;
export const PERSONAL_DASHBOARD_RETENTION_DAYS = 14;

/** Snapshot business dates and the 10:00 delivery deadline use Moscow time. */
export function personalDashboardToday(now = new Date()): string {
  return new Date(now.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export class PersonalDashboardError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PersonalDashboardError';
  }
}

export type PersonalSnapshotMetadata = {
  originalName: string;
  fileSize: number;
  sha256: string;
  emailHash: string;
  name: string;
  role: string;
  issued: string;
  expires: string;
};

/** Exactly matches the supplied personal HTML: trim, lowercase, UTF-8 SHA-256, standard base64. */
export function getManagerEmailHash(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('base64');
}

export function personalDashboardSafeFilename(filename: string): string {
  if (typeof filename !== 'string') return 'snapshot.ktsp';
  const name = filename.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim() ?? '';
  return name.slice(0, 255) || 'snapshot.ktsp';
}

function invalid(code = 'INVALID_SNAPSHOT', message = 'Файл не является поддерживаемым личным снимком .ktsp'): never {
  throw new PersonalDashboardError(code, message);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function metadataText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}

function date(value: unknown): string {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) invalid('INVALID_DATE', 'Некорректная дата личного снимка');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid('INVALID_DATE', 'Некорректная дата личного снимка');
  return value;
}

function base64(value: unknown, exactBytes?: number, minBytes = 1): string {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) invalid();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || decoded.length < minBytes || (exactBytes !== undefined && decoded.length !== exactBytes)) invalid();
  return value;
}

/** Inspects only the unencrypted envelope. Never decrypts, authenticates the sender, or handles a password. */
export function inspectPersonalSnapshot(bytes: Buffer, filename: string): PersonalSnapshotMetadata {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > PERSONAL_DASHBOARD_SNAPSHOT_MAX_BYTES) {
    invalid('SNAPSHOT_SIZE', 'Размер личного снимка должен быть от 1 байта до 8 МиБ');
  }
  if (typeof filename !== 'string' || filename.length > 1024 || !/\.ktsp$/i.test(filename.trim())) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    invalid();
  }
  const envelope = object(parsed);
  if (envelope.fmt !== 'kts-personal' || envelope.v !== 1 || typeof envelope.gz !== 'boolean') invalid();
  const kdf = object(envelope.kdf);
  if (kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || !Number.isInteger(kdf.iter) || Number(kdf.iter) < 200_000 || Number(kdf.iter) > 600_000) {
    invalid('UNSUPPORTED_CRYPTO', 'Неподдерживаемые параметры шифрования личного снимка');
  }
  base64(kdf.salt, 16);
  base64(envelope.iv, 12);
  base64(envelope.ct, undefined, 16);
  const emailHash = base64(envelope.emailHash, 32);
  const issued = date(envelope.issued);
  const expires = date(envelope.expires);
  if (expires < issued) invalid('INVALID_DATE', 'Срок действия снимка меньше даты выпуска');
  return {
    originalName: personalDashboardSafeFilename(filename),
    fileSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    emailHash,
    name: metadataText(envelope.name, 240),
    role: metadataText(envelope.role, 160),
    issued,
    expires,
  };
}
