import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import type { FetchMessageObject, ImapFlow, ImapFlowOptions, MessageStructureObject } from 'imapflow';

export const MANAGER_DASHBOARD_MAIL_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MANAGER_DASHBOARD_MAIL_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_DETAILS = 200;
const MAX_MIME_NODES = 500;
const MAILBOX = 'INBOX';
const EMAIL_ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

type Environment = Record<string, string | undefined>;
type SnapshotInput = {
  filename: string;
  bytes: Buffer;
  sourceKey: string;
  sender?: string;
  messageId?: string;
};
type SnapshotResult = {
  status: string;
  managerId: number | null;
  code: string;
  message?: string;
};
export type ManagerDashboardMailClient = Pick<ImapFlow,
  'connect' | 'getMailboxLock' | 'fetch' | 'download' | 'logout' | 'close' | 'on'
> & { mailbox: false | { exists: number; uidValidity: bigint; readOnly?: boolean } };

export type ManagerDashboardMailDependencies = {
  createClient: (options: ImapFlowOptions) => Promise<ManagerDashboardMailClient>;
  acquireLock: (name: string) => Promise<(() => Promise<void>) | null>;
  importSnapshot: (input: SnapshotInput) => Promise<SnapshotResult>;
  recordFailure: (input: Omit<SnapshotInput, 'bytes'> & { code: string }) => Promise<SnapshotResult>;
  now: () => Date;
};

export type ManagerDashboardMailResult = {
  status: 'disabled' | 'busy' | 'completed';
  reason?: string;
  checkedMessages: number;
  attachments: number;
  imported: number;
  duplicates: number;
  stale: number;
  failed: number;
  skipped: { sender: number; messageSize: number; noAttachment: number; age: number };
  results: Array<{
    uid: number;
    originalName: string;
    status: string;
    managerId: number | null;
    code: string;
    message: string;
  }>;
  truncatedResults: boolean;
};

function readConfig(env: Environment) {
  const enabled = env.MANAGER_DASHBOARD_MAIL_ENABLED?.trim() === 'true';
  const allowed = (env.MANAGER_DASHBOARD_MAIL_ALLOWED_FROM ?? '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const host = env.MANAGER_DASHBOARD_MAIL_HOST || env.STOCK_MAIL_HOST
    || env.SMTP_HOST?.replace(/^smtp\./i, 'imap.') || 'imap.yandex.ru';
  const user = env.MANAGER_DASHBOARD_MAIL_USER || env.STOCK_MAIL_USER || env.SMTP_USER;
  const password = env.MANAGER_DASHBOARD_MAIL_PASSWORD || env.STOCK_MAIL_PASSWORD
    || env.SMTP_PASSWORD || env.SMTP_PASS;
  const port = Number(env.MANAGER_DASHBOARD_MAIL_PORT || env.STOCK_MAIL_PORT || '993');
  const secureValue = env.MANAGER_DASHBOARD_MAIL_SECURE ?? env.STOCK_MAIL_SECURE ?? 'true';
  const secure = secureValue === 'true' || secureValue === '1';
  const reason = allowed.length === 0 ? 'sender_not_configured'
    : !allowed.every((sender) => EMAIL_ADDRESS.test(sender) && !sender.includes('*')) ? 'sender_invalid'
      : !user || !password || !host || !Number.isInteger(port) || port < 1 || port > 65535
        || !['true', 'false', '1', '0'].includes(secureValue) ? 'connection_not_configured' : undefined;
  return {
    enabled, configured: !reason, reason, host, user: user ?? '', password: password ?? '', port, secure,
    allowed: new Set(allowed),
    scanLimit: Math.min(1000, Math.max(1, Math.floor(Number(env.MANAGER_DASHBOARD_MAIL_SCAN_LIMIT) || 300))),
    lookbackDays: Math.min(14, Math.max(1, Math.floor(Number(env.MANAGER_DASHBOARD_MAIL_LOOKBACK_DAYS) || 14))),
  };
}

/** Safe to expose to administrators: never returns connection details or credentials. */
export function getManagerDashboardMailStatus(env: Environment = process.env) {
  const { enabled, configured, reason } = readConfig(env);
  return { enabled, configured, reason: !enabled ? 'not_enabled' : reason };
}

function emptyResult(): ManagerDashboardMailResult {
  return {
    status: 'completed', checkedMessages: 0, attachments: 0, imported: 0, duplicates: 0, stale: 0, failed: 0,
    skipped: { sender: 0, messageSize: 0, noAttachment: 0, age: 0 }, results: [], truncatedResults: false,
  };
}

function outcomeMessage(status: string) {
  switch (status) {
    case 'imported': return 'Снимок обновлён.';
    case 'duplicate': return 'Этот снимок уже загружен.';
    case 'stale': return 'Сохранён более свежий снимок.';
    case 'expired': return 'Срок действия снимка истёк.';
    case 'unknown': return 'Менеджер по email снимка не найден.';
    case 'ambiguous': return 'Email снимка соответствует нескольким менеджерам.';
    case 'conflict': return 'Снимок конфликтует с ранее загруженными данными.';
    case 'quota': return 'Превышен лимит хранилища снимков.';
    case 'message_too_large': return 'Письмо превышает 64 МиБ.';
    case 'attachment_too_large': return 'Файл превышает 8 МиБ.';
    case 'download_failed': return 'Не удалось прочитать вложение. Повторная проверка почты повторит попытку.';
    case 'import_unavailable': return 'Не удалось сохранить снимок. Повторная проверка почты повторит попытку.';
    case 'mime_invalid': return 'Не удалось определить вложения письма.';
    default: return 'Файл не прошёл проверку формата снимка.';
  }
}

function addOutcome(result: ManagerDashboardMailResult, uid: number, originalName: string, outcome: SnapshotResult) {
  result.attachments += 1;
  if (outcome.status === 'imported') result.imported += 1;
  else if (outcome.status === 'duplicate') result.duplicates += 1;
  else if (outcome.status === 'stale') result.stale += 1;
  else result.failed += 1;
  if (result.results.length < MAX_RESULT_DETAILS) {
    result.results.push({
      uid, originalName: originalName.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255),
      status: outcome.status, code: outcome.code, managerId: outcome.managerId,
      message: outcome.message ?? outcomeMessage(outcome.status),
    });
  } else result.truncatedResults = true;
}

function ktspParts(structure: MessageStructureObject | undefined) {
  const parts: Array<{ part: string; filename: string }> = [];
  const pending = structure ? [structure] : [];
  let visited = 0;
  while (pending.length) {
    if (++visited > MAX_MIME_NODES) throw new Error('mime_invalid');
    const node = pending.pop()!;
    // Do not accept attachments from a forwarded message using the outer sender's identity.
    if (node.type.toLowerCase() === 'message/rfc822') continue;
    const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? '';
    if (filename.trim().toLowerCase().endsWith('.ktsp')) {
      const part = node.part ?? (node === structure && !node.childNodes?.length ? '1' : '');
      if (!/^\d+(\.\d+)*$/.test(part)) throw new Error('mime_invalid');
      parts.push({ part, filename });
    }
    if (node.childNodes) pending.push(...node.childNodes.slice().reverse());
  }
  return parts;
}

async function readBoundedAttachment(stream: Readable) {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MANAGER_DASHBOARD_MAIL_MAX_ATTACHMENT_BYTES) throw new Error('attachment_too_large');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  } finally {
    stream.destroy();
  }
}

const defaultDependencies: ManagerDashboardMailDependencies = {
  async createClient(options) {
    const { ImapFlow } = await import('imapflow');
    return new ImapFlow(options);
  },
  async acquireLock(name) {
    const { tryAcquireSessionAdvisoryLock } = await import('./db/client');
    return tryAcquireSessionAdvisoryLock(name);
  },
  async importSnapshot(input) {
    const { importPersonalDashboardSnapshot } = await import('./db/managerDashboardRepo');
    return importPersonalDashboardSnapshot(input);
  },
  async recordFailure(input) {
    const { recordPersonalDashboardImportFailure } = await import('./db/managerDashboardRepo');
    return recordPersonalDashboardImportFailure(input);
  },
  now: () => new Date(),
};

/** INBOX is opened read-only; there are deliberately no IMAP mutation methods in this workflow. */
export async function importManagerDashboardFromEmail(options: {
  env?: Environment;
  dependencies?: Partial<ManagerDashboardMailDependencies>;
} = {}): Promise<ManagerDashboardMailResult> {
  const config = readConfig(options.env ?? process.env);
  const result = emptyResult();
  if (!config.enabled || !config.configured) {
    return { ...result, status: 'disabled', reason: !config.enabled ? 'not_enabled' : config.reason };
  }
  const deps = { ...defaultDependencies, ...options.dependencies };
  const accountHash = createHash('sha256')
    .update(JSON.stringify([config.host.toLowerCase(), config.port, config.user.toLowerCase(), MAILBOX]))
    .digest('hex');
  const release = await deps.acquireLock(`manager_dashboard_mail:${accountHash}`);
  if (!release) return { ...result, status: 'busy', reason: 'import_in_progress' };
  let client: ManagerDashboardMailClient | undefined;
  try {
    client = await deps.createClient({
      host: config.host, port: config.port, secure: config.secure,
      // On port 143 require STARTTLS, rather than sending the password over plaintext.
      ...(config.secure ? {} : { doSTARTTLS: true }),
      auth: { user: config.user, pass: config.password },
      logger: false, logRaw: false, disableAutoIdle: true,
      connectionTimeout: 30_000, greetingTimeout: 15_000, socketTimeout: 60_000,
      maxLineLength: 1024 * 1024, maxLiteralSize: 1024 * 1024, maxResponseSize: 2 * 1024 * 1024,
    });
    // ImapFlow also emits transport errors; the awaited operation reports failure below.
    client.on('error', () => {});
    await client.connect();
    const mailboxLock = await client.getMailboxLock(MAILBOX, { readOnly: true });
    try {
      const mailbox = client.mailbox;
      if (!mailbox || mailbox.readOnly !== true || !mailbox.uidValidity || mailbox.uidValidity <= BigInt(0)) {
        throw new Error('Mailbox did not provide a read-only UIDVALIDITY session');
      }
      if (mailbox.exists === 0) return result;
      const uidValidity = mailbox.uidValidity.toString();
      const makeSourceKey = (uid: number, part: string, fingerprint: string) => `imap:v1:${createHash('sha256')
        .update(JSON.stringify([accountHash, uidValidity, uid, part, fingerprint])).digest('hex')}`;
      const recordFailure = async (message: FetchMessageObject, filename: string, part: string, status: string, code: string) => {
        try {
          await deps.recordFailure({
            filename, sourceKey: makeSourceKey(message.uid, part, `failure:${code}`), code,
            sender: message.envelope?.from?.[0]?.address?.trim().toLowerCase(),
            messageId: message.envelope?.messageId?.slice(0, 500),
          });
          addOutcome(result, message.uid, filename, { status, managerId: null, code });
        } catch {
          addOutcome(result, message.uid, filename, { status: 'import_unavailable', managerId: null, code: 'IMPORT_UNAVAILABLE' });
        }
      };
      const start = Math.max(1, mailbox.exists - config.scanLimit + 1);
      const messages: FetchMessageObject[] = [];
      // Sequence numbers select a bounded recent window. All content downloads below use UIDs.
      for await (const message of client.fetch(`${start}:${mailbox.exists}`, {
        uid: true, envelope: true, bodyStructure: true, size: true, internalDate: true,
      }, { uid: false })) {
        if (messages.length >= config.scanLimit) break;
        messages.push(message);
      }
      // Finish FETCH before issuing DOWNLOAD commands: ImapFlow serializes commands.
      const cutoff = deps.now().getTime() - config.lookbackDays * 86_400_000;
      for (const message of messages.sort((a, b) => b.uid - a.uid)) {
        result.checkedMessages += 1;
        const receivedAt = message.internalDate ? new Date(message.internalDate).getTime() : NaN;
        if (!Number.isFinite(receivedAt) || receivedAt < cutoff) {
          result.skipped.age += 1;
          continue;
        }
        const from = message.envelope?.from ?? [];
        const sender = from[0]?.address?.trim().toLowerCase() ?? '';
        if (from.length !== 1 || !config.allowed.has(sender)) {
          result.skipped.sender += 1;
          continue;
        }
        let parts: ReturnType<typeof ktspParts>;
        try {
          parts = ktspParts(message.bodyStructure);
        } catch {
          await recordFailure(message, '', '', 'mime_invalid', 'INVALID_MESSAGE');
          continue;
        }
        if (!parts.length) {
          result.skipped.noAttachment += 1;
          continue;
        }
        if (!Number.isSafeInteger(message.size) || message.size! < 0
          || message.size! > MANAGER_DASHBOARD_MAIL_MAX_MESSAGE_BYTES) {
          result.skipped.messageSize += 1;
          for (const { filename, part } of parts) {
            await recordFailure(message, filename, part, 'message_too_large', 'MESSAGE_TOO_LARGE');
          }
          continue;
        }
        for (const { part, filename } of parts) {
          let bytes: Buffer;
          try {
            const download = await client.download(String(message.uid), part, {
              uid: true, maxBytes: MANAGER_DASHBOARD_MAIL_MAX_ATTACHMENT_BYTES + 1, chunkSize: 64 * 1024,
            });
            bytes = await readBoundedAttachment(download.content);
          } catch (error) {
            const status = error instanceof Error && error.message === 'attachment_too_large'
              ? 'attachment_too_large' : 'download_failed';
            await recordFailure(message, filename, part, status,
              status === 'attachment_too_large' ? 'ATTACHMENT_TOO_LARGE' : 'ATTACHMENT_DOWNLOAD_FAILED');
            continue;
          }
          const contentHash = createHash('sha256').update(bytes).digest('hex');
          const sourceKey = makeSourceKey(message.uid, part, contentHash);
          try {
            const imported = await deps.importSnapshot({
              filename, bytes, sourceKey, sender, messageId: message.envelope?.messageId?.slice(0, 500),
            });
            addOutcome(result, message.uid, filename, imported);
          } catch {
            addOutcome(result, message.uid, filename, { status: 'import_unavailable', managerId: null, code: 'import_unavailable' });
          }
        }
      }
    } finally {
      mailboxLock.release();
    }
    return result;
  } catch {
    // Library errors can contain server responses. Never expose mailbox details or credentials.
    throw new Error('Не удалось проверить почту дашбордов. Проверьте подключение и повторите попытку.');
  } finally {
    try {
      if (client) {
        await client.logout().catch(() => undefined);
        client.close();
      }
    } finally {
      await release();
    }
  }
}
