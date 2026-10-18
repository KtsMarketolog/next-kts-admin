import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

import { ensureSiteSchema } from '@/shared/lib/db';
import { query, tryAcquireSessionAdvisoryLock, withTransaction } from '@/shared/lib/db/client';
import { runPostCommitTasks } from '@/shared/lib/postCommitTasks';

import { ensureCatalogSchema } from './catalogDb';
import {
  HEADER_ARTICLE_ALIASES,
  HEADER_EXPECTED_ALIASES,
  HEADER_STOCK_ALIASES,
  HEADER_UNIT_ALIASES,
  normalizeStockProductName,
  parseCurrentStock,
  parseExpected,
  parseStockWorkbook,
  readCellByAliases,
  readRawCellByAliases,
} from './stockWorkbookParser';
export { normalizeStockProductName } from './stockWorkbookParser';

export type {
  StockImportError,
  StockImportResult,
  StockImportLog,
  StockEmailSkipReason,
  StockEmailSkipSample,
  StockEmailImportResult
} from './stockImportTypes';
import type {
  StockLocationKey,
  StockImportError,
  StockImportResult,
  StockImportLog,
  StockEmailSkipSample,
  StockEmailImportResult
} from './stockImportTypes';

// Inventory is shared across all mailboxes and manual Excel imports. A session
// lock has no time-based expiry that could let a second worker steal a long run.
const LOCK_KEY = 'kts-stock-import';
const LEGACY_LOCK_KEY = 'email';
const MAX_ERRORS = 200;
const MAX_SKIP_SAMPLES = 5;
const DEFAULT_MAIL_SCAN_LIMIT = 300;
const DEFAULT_STOCK_ALLOWED_FROM = ['saunakva@yandex.ru'];

type StockEmailCandidate = {
  uid: number | string;
  uidNumber: number;
  dateMs: number;
  buffer: Buffer;
  fileName: string;
  emailFrom: string;
  emailSubject: string;
  receiptKey: string;
};

function pushError(errors: StockImportError[], error: StockImportError) {
  if (errors.length < MAX_ERRORS) errors.push(error);
}

async function ensureStockImportSchema() {
  await ensureCatalogSchema();
  await ensureSiteSchema();
  await query(`
    alter table catalog_products add column if not exists stock integer not null default 0;
    alter table catalog_products add column if not exists stock_volzhsk integer not null default 0;
    alter table catalog_products add column if not exists stock_moscow integer not null default 0;
    alter table catalog_products add column if not exists is_expected boolean not null default false;
    alter table catalog_products add column if not exists stock_updated_at timestamptz;
    alter table catalog_products add column if not exists unit text;
    alter table wholesale_products add column if not exists stock integer not null default 0;
    alter table wholesale_products add column if not exists stock_volzhsk integer not null default 0;
    alter table wholesale_products add column if not exists stock_moscow integer not null default 0;
    alter table wholesale_products add column if not exists is_expected boolean not null default false;
    alter table wholesale_products add column if not exists stock_updated_at timestamptz;
    alter table wholesale_products add column if not exists unit text;

    create table if not exists stock_import_logs (
      id bigserial primary key,
      created_at timestamptz not null default now(),
      file_name text not null default '',
      email_from text not null default '',
      email_subject text not null default '',
      status text not null default 'failed',
      total_rows integer not null default 0,
      updated_rows integer not null default 0,
      not_found_rows integer not null default 0,
      failed_rows integer not null default 0,
      errors_json jsonb not null default '[]'::jsonb
    );

    create table if not exists stock_import_locks (
      key text primary key,
      locked_at timestamptz not null default now()
    );

    create table if not exists stock_import_mail_receipts (
      receipt_key text primary key,
      log_id bigint not null references stock_import_logs(id),
      created_at timestamptz not null default now()
    );

    create index if not exists catalog_products_stock_article_norm_idx
      on catalog_products (lower(trim(coalesce(article, ''))));
    create index if not exists stock_import_logs_created_idx on stock_import_logs(created_at desc);
  `);
}

async function saveImportLog(client: PoolClient, result: Omit<StockImportResult, 'logId'>) {
  const saved = await client.query<{ id: string }>(
    `insert into stock_import_logs (
       file_name, email_from, email_subject, status,
       total_rows, updated_rows, not_found_rows, failed_rows, errors_json
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     returning id::text`,
    [
      result.fileName,
      result.emailFrom,
      result.emailSubject,
      result.status,
      result.totalRows,
      result.updatedRows,
      result.notFoundRows,
      result.failedRows,
      JSON.stringify(result.errors),
    ],
  );
  const id = Number(saved.rows[0]?.id ?? 0);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Не удалось записать результат импорта остатков');
  return id;
}

async function acquireImportLock() {
  return tryAcquireSessionAdvisoryLock(LOCK_KEY);
}

// Keep the old workbook guard during a rolling upgrade. The session lock above
// prevents TTL stealing between new workers; old workers still use this row.
async function acquireLegacyImportLock() {
  await ensureStockImportSchema();
  return withTransaction(async (client) => {
    await client.query(`delete from stock_import_locks where key = $1 and locked_at < now() - interval '30 minutes'`, [LEGACY_LOCK_KEY]);
    const inserted = await client.query(
      `insert into stock_import_locks (key, locked_at)
       values ($1, now())
       on conflict (key) do nothing`,
      [LEGACY_LOCK_KEY],
    );
    return inserted.rowCount === 1;
  });
}

async function releaseLegacyImportLock() {
  await query(`delete from stock_import_locks where key = $1`, [LEGACY_LOCK_KEY]);
}

class StockImportBusyError extends Error {
  constructor() { super('Импорт остатков уже выполняется'); }
}

class StockWorkbookValidationError extends Error {}

type StockWarning = { code: string; message: string };

function attachWarnings(result: StockImportResult | undefined, warnings: StockWarning[]) {
  if (result && warnings.length) result.warnings = [...(result.warnings ?? []), ...warnings];
}

function mailReceiptKey(scope: string, uid: number | string, buffer: Buffer) {
  return createHash('sha256').update(scope).update('\0').update(String(uid)).update('\0').update(buffer).digest('hex');
}

async function recordMailReceipts(client: PoolClient, keys: string[], logId: number) {
  if (!keys.length) return;
  await client.query(`insert into stock_import_mail_receipts (receipt_key, log_id)
    select receipt_key, $2 from unnest($1::text[]) as receipt_key
    on conflict (receipt_key) do nothing`, [keys, logId]);
}

type AggregatedStock = {
  article: string;
  firstRowNumber: number;
  stockByLocation: Record<StockLocationKey, number>;
  stockWithoutLocation: number;
  isExpected: boolean;
  unit: string;
};

function createAggregatedStock(article: string, firstRowNumber: number): AggregatedStock {
  return {
    article,
    firstRowNumber,
    stockByLocation: {
      volzhsk: 0,
      moscow: 0,
    },
    stockWithoutLocation: 0,
    isExpected: false,
    unit: '',
  };
}

function totalAggregatedStock(stock: AggregatedStock) {
  return stock.stockByLocation.volzhsk + stock.stockByLocation.moscow + stock.stockWithoutLocation;
}

type StockWorkbookInput = {
  buffer: Buffer;
  fileName: string;
  emailFrom?: string;
  emailSubject?: string;
  mailReceiptKeys?: string[];
};

export async function importStockFromExcelBuffer(input: StockWorkbookInput): Promise<StockImportResult> {
  const release = await acquireImportLock();
  if (!release) {
    throw new StockImportBusyError();
  }
  let result: StockImportResult | undefined;
  try {
    result = await importStockFromExcelBufferLocked(input);
    return result;
  } finally {
    attachWarnings(result, await runPostCommitTasks([{
      code: 'stock_lock_cleanup_failed', message: 'Результат импорта сохранён; завершение блокировки требует проверки.', run: release,
    }]));
  }
}

// Private: both public entry points acquire the same session lock first.
async function importStockFromExcelBufferLocked(input: StockWorkbookInput): Promise<StockImportResult> {
  const legacyLocked = await acquireLegacyImportLock();
  if (!legacyLocked) throw new StockImportBusyError();
  let result: StockImportResult | undefined;
  try {
    await ensureStockImportSchema();
    let rows: ReturnType<typeof parseStockWorkbook>;
    try { rows = parseStockWorkbook(input.buffer); }
    catch (error) { throw new StockWorkbookValidationError(error instanceof Error ? error.message : 'Невозможно прочитать Excel-файл остатков'); }
    const errors: StockImportError[] = [];
    let totalRows = 0;
    let updatedRows = 0;
    let notFoundRows = 0;
    let failedRows = 0;
    const stockByArticle = new Map<string, AggregatedStock>();
    const invalidArticles = new Set<string>();

    for (const { rowNumber, row, location } of rows) {
      const rawArticle = readCellByAliases(row, HEADER_ARTICLE_ALIASES);
      const article = normalizeStockProductName(rawArticle);
      const stock = parseCurrentStock(readRawCellByAliases(row, HEADER_STOCK_ALIASES));
      const unit = normalizeStockProductName(readCellByAliases(row, HEADER_UNIT_ALIASES)).slice(0, 80);
      const isExpected = parseExpected(readRawCellByAliases(row, HEADER_EXPECTED_ALIASES));

      if (!article) {
        continue;
      }
      totalRows += 1;
      const articleKey = article.toLowerCase();
      if (stock === null) {
        failedRows += 1;
        // A partial warehouse aggregate is not a complete replacement snapshot.
        // Keep every prior stock field for this SKU, regardless of row ordering.
        invalidArticles.add(articleKey);
        stockByArticle.delete(articleKey);
        pushError(errors, { row: rowNumber, name: article, error: 'Сейчас не является целым неотрицательным числом. Остатки по этому артикулу не изменены.' });
        continue;
      }
      if (invalidArticles.has(articleKey)) continue;

      const aggregated = stockByArticle.get(articleKey) ?? createAggregatedStock(article, rowNumber);
      if (location) {
        aggregated.stockByLocation[location] += stock;
      } else {
        aggregated.stockWithoutLocation += stock;
      }
      aggregated.isExpected ||= isExpected;
      if (!aggregated.unit && unit) aggregated.unit = unit;
      stockByArticle.set(articleKey, aggregated);
    }

    result = await withTransaction(async (client) => {
      const receiptKeys = input.mailReceiptKeys ?? [];
      if (receiptKeys.length) {
        const previous = await client.query<{ result: StockImportResult }>(`
          select jsonb_build_object(
            'logId', logs.id, 'fileName', logs.file_name, 'emailFrom', logs.email_from,
            'emailSubject', logs.email_subject, 'status', logs.status, 'totalRows', logs.total_rows,
            'updatedRows', logs.updated_rows, 'notFoundRows', logs.not_found_rows,
            'failedRows', logs.failed_rows, 'errors', logs.errors_json
          ) as result
          from stock_import_mail_receipts receipts join stock_import_logs logs on logs.id = receipts.log_id
          where receipts.receipt_key = $1`, [receiptKeys[0]]);
        if (previous.rows[0]?.result) {
          const stored = previous.rows[0].result;
          await recordMailReceipts(client, stored.status === 'failed' ? receiptKeys.slice(0, 1) : receiptKeys, stored.logId!);
          return { ...stored, saved: true, alreadyApplied: true };
        }
      }
      for (const stockRow of stockByArticle.values()) {
        const stock = totalAggregatedStock(stockRow);
        const products = await client.query<{ id: string }>(
          `select id::text
           from catalog_products
           where lower(trim(coalesce(article, ''))) = lower($1)`,
          [stockRow.article],
        );

        if (products.rowCount === 0) {
          notFoundRows += 1;
          pushError(errors, { row: stockRow.firstRowNumber, name: stockRow.article, error: 'Товар с таким Номенклатура.Код не найден' });
          continue;
        }

        if ((products.rowCount ?? 0) > 1) {
          failedRows += 1;
          pushError(errors, { row: stockRow.firstRowNumber, name: stockRow.article, error: 'Найдено несколько товаров с таким Номенклатура.Код' });
          continue;
        }

        const productId = Number(products.rows[0]?.id ?? 0);
        await client.query(
          `update catalog_products
           set stock = $2,
               stock_volzhsk = $3,
               stock_moscow = $4,
               is_expected = $5,
               unit = coalesce(nullif($6, ''), unit),
               stock_updated_at = now(),
               updated_at = now()
           where id = $1`,
          [productId, stock, stockRow.stockByLocation.volzhsk, stockRow.stockByLocation.moscow, stockRow.isExpected, stockRow.unit],
        );
        await client.query(
          `update wholesale_products
           set stock = $2,
               stock_volzhsk = $3,
               stock_moscow = $4,
               is_expected = $5,
               unit = coalesce(nullif($6, ''), unit),
               stock_updated_at = now(),
               updated_at = now()
           where catalog_product_id = $1`,
          [productId, stock, stockRow.stockByLocation.volzhsk, stockRow.stockByLocation.moscow, stockRow.isExpected, stockRow.unit],
        );
        updatedRows += 1;
      }
      const status: StockImportResult['status'] =
        errors.length === 0 ? 'success' : updatedRows > 0 ? 'partial_success' : 'failed';
      const withoutId = {
        fileName: input.fileName,
        emailFrom: input.emailFrom ?? '',
        emailSubject: input.emailSubject ?? '',
        status,
        totalRows,
        updatedRows,
        notFoundRows,
        failedRows,
        errors,
      };
      const logId = await saveImportLog(client, withoutId);
      // Receipts prevent a failed mailbox MOVE from replaying this snapshot or
      // superseded older mail. They commit with the stock changes and result.
      await recordMailReceipts(client, status === 'failed' ? receiptKeys.slice(0, 1) : receiptKeys, logId);
      return { logId, ...withoutId, saved: true };
    }, { trackCommitOutcome: true });
    return result;
  } finally {
    attachWarnings(result, await runPostCommitTasks([{
      code: 'stock_legacy_lock_cleanup_failed', message: 'Результат импорта сохранён; завершение блокировки импорта требует проверки.', run: releaseLegacyImportLock,
    }]));
  }
}

function envBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1';
}

function matchesAllowedSender(address: string, allowed: string) {
  const normalizedAddress = address.trim().toLowerCase();
  return allowed
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalizedAddress);
}

function buildAllowedSenders(configured: string | undefined, user: string | undefined) {
  return Array.from(
    new Set(
      [configured, user, ...DEFAULT_STOCK_ALLOWED_FROM]
        .flatMap((item) => String(item ?? '').split(','))
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ).join(',');
}

function attachmentAllowed(fileName: string, prefix: string) {
  const normalized = fileName.trim();
  if (!normalized.toLowerCase().endsWith('.xlsx')) return false;
  return !prefix || normalized.toLowerCase().startsWith(prefix.trim().toLowerCase());
}

function createEmailResult(
  input: {
    status?: StockEmailImportResult['status'];
    processed?: number;
    result?: StockImportResult | null;
    checkedMessages: number;
    skipped: StockEmailImportResult['skipped'];
    allowedFrom: string;
    subjectPart: string;
    filePrefix: string;
    scanLimit?: number;
    warnings?: StockWarning[];
  },
): StockEmailImportResult {
  return {
    status: input.status ?? 'completed',
    processed: input.processed ?? 0,
    result: input.result ?? null,
    warnings: input.warnings ?? [],
    checkedMessages: input.checkedMessages,
    skipped: input.skipped,
    settings: {
      allowedFrom: input.allowedFrom,
      subjectPart: input.subjectPart,
      filePrefix: input.filePrefix,
      scanLimit: input.scanLimit ?? DEFAULT_MAIL_SCAN_LIMIT,
    },
  };
}

function addSkippedEmailSample(
  skipped: StockEmailImportResult['skipped'],
  sample: StockEmailSkipSample,
) {
  skipped[sample.reason] += 1;
  if (skipped.samples.length < MAX_SKIP_SAMPLES) skipped.samples.push(sample);
}

async function moveMessage(client: any, uid: number | string, folder: string) {
  if (!folder) return;
  await client.mailboxCreate(folder).catch(() => undefined);
  await client.messageMove(String(uid), folder, { uid: true }).catch(async (error: unknown) => {
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => undefined);
    // Seen is not an import receipt: the next scan intentionally searches all
    // messages. Atomic database receipts prevent replay if MOVE is unavailable.
    throw error;
  });
}

export async function importStockFromEmail(): Promise<StockEmailImportResult> {
  const warnings: StockWarning[] = [];
  const emailResult = (input: Parameters<typeof createEmailResult>[0]) => createEmailResult({ ...input, warnings });
  const host = process.env.STOCK_MAIL_HOST || process.env.SMTP_HOST?.replace(/^smtp\./i, 'imap.') || 'imap.yandex.ru';
  const port = Number(process.env.STOCK_MAIL_PORT || 993);
  const secure = envBoolean(process.env.STOCK_MAIL_SECURE, true);
  const user = process.env.STOCK_MAIL_USER || process.env.SMTP_USER;
  const password = process.env.STOCK_MAIL_PASSWORD || process.env.SMTP_PASSWORD || process.env.SMTP_PASS;
  const allowedFrom = buildAllowedSenders(process.env.STOCK_MAIL_ALLOWED_FROM, user);
  const subjectPart = process.env.STOCK_MAIL_SUBJECT?.trim() ?? '';
  const filePrefix = process.env.STOCK_MAIL_FILENAME_PREFIX?.trim() || 'Остатки';
  const scanLimit = Math.min(Math.max(Number(process.env.STOCK_MAIL_SCAN_LIMIT) || DEFAULT_MAIL_SCAN_LIMIT, 1), 1000);
  const processedFolder = process.env.STOCK_MAIL_PROCESSED_FOLDER || 'Processed';
  const errorFolder = process.env.STOCK_MAIL_ERROR_FOLDER || 'ImportErrors';

  if (!host || !user || !password || !allowedFrom) {
    throw new Error('Не настроены STOCK_MAIL_USER/STOCK_MAIL_PASSWORD или SMTP_USER/SMTP_PASSWORD для чтения почты');
  }

  const release = await acquireImportLock();
  if (!release) {
    return emailResult({
      status: 'busy', checkedMessages: 0,
      skipped: { sender: 0, subject: 0, attachment: 0, samples: [] },
      allowedFrom, subjectPart, filePrefix, scanLimit,
    });
  }
  let client: import('imapflow').ImapFlow | undefined;
  try {
    const [{ ImapFlow }, { simpleParser }] = await Promise.all([import('imapflow'), import('mailparser')]);
    client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass: password },
      logger: false,
    });
    // Awaited operations report transport failures; emitted errors must not
    // bypass the finally blocks that release our database and mailbox locks.
    client.on('error', () => {});

    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uidValidity = client.mailbox && client.mailbox.uidValidity;
      if (!uidValidity) throw new Error('Почтовый сервер не вернул UIDVALIDITY; остатки не изменены');
      const receiptScope = JSON.stringify([host.toLowerCase(), port, user.toLowerCase(), 'INBOX', String(uidValidity)]);
      const uidsResult = await client.search({ all: true }, { uid: true });
      const uids = Array.isArray(uidsResult)
        ? uidsResult
            .map((uid) => Number(uid))
            .filter((uid) => Number.isFinite(uid) && uid > 0)
            .sort((a, b) => b - a)
            .slice(0, scanLimit)
        : [];
      const skipped: StockEmailImportResult['skipped'] = {
        sender: 0,
        subject: 0,
        attachment: 0,
        samples: [],
      };
      if (uids.length === 0) {
        return emailResult({
          checkedMessages: 0,
          skipped,
          allowedFrom,
          subjectPart,
          filePrefix,
          scanLimit,
        });
      }
      let candidate: StockEmailCandidate | null = null;
      const supersededCandidateUids: Array<number | string> = [];
      const mailReceiptKeys: string[] = [];
      for await (const message of client.fetch(uids.join(','), { uid: true, source: true }, { uid: true })) {
        if (!message.source || !message.uid) continue;
        const parsed = await simpleParser(message.source as Buffer);
        const fromAddress = parsed.from?.value?.[0]?.address ?? '';
        const subject = parsed.subject ?? '';
        const attachments = parsed.attachments.map((item) => item.filename ?? '');
        const uidNumber = Number(message.uid) || 0;
        const dateMs = parsed.date?.getTime() || uidNumber;

        if (!matchesAllowedSender(fromAddress, allowedFrom)) {
          skipped.sender += 1;
          if (parsed.attachments.some((item) => attachmentAllowed(item.filename ?? '', filePrefix))) {
            addSkippedEmailSample(skipped, { reason: 'sender', from: fromAddress, subject, attachments });
          }
          continue;
        }
        if (subjectPart && !subject.toLowerCase().includes(subjectPart.toLowerCase())) {
          addSkippedEmailSample(skipped, { reason: 'subject', from: fromAddress, subject, attachments });
          continue;
        }

        const attachment = parsed.attachments.find((item) => attachmentAllowed(item.filename ?? '', filePrefix));
        if (!attachment) {
          addSkippedEmailSample(skipped, { reason: 'attachment', from: fromAddress, subject, attachments });
          continue;
        }

        const receiptKey = mailReceiptKey(receiptScope, message.uid, attachment.content);
        mailReceiptKeys.push(receiptKey);

        if (!candidate || dateMs > candidate.dateMs || (dateMs === candidate.dateMs && uidNumber > candidate.uidNumber)) {
          if (candidate) supersededCandidateUids.push(candidate.uid);
          candidate = {
            uid: message.uid,
            uidNumber,
            dateMs,
            buffer: attachment.content,
            fileName: attachment.filename ?? 'stock.xlsx',
            emailFrom: fromAddress,
            emailSubject: subject,
            receiptKey,
          };
        } else {
          supersededCandidateUids.push(message.uid);
        }
      }

      if (candidate) {
        let result: StockImportResult;
        try {
          result = await importStockFromExcelBufferLocked({
            buffer: candidate.buffer,
            fileName: candidate.fileName,
            emailFrom: candidate.emailFrom,
            emailSubject: candidate.emailSubject,
            mailReceiptKeys: [candidate.receiptKey, ...mailReceiptKeys.filter((key) => key !== candidate.receiptKey)],
          });
        } catch (error) {
          // Contention with an old worker during rollout is not a bad file.
          // In particular, neither this candidate nor superseded mail may move.
          if (error instanceof StockImportBusyError) {
            return emailResult({
              status: 'busy', checkedMessages: uids.length, skipped,
              allowedFrom, subjectPart, filePrefix, scanLimit,
            });
          }
          // An infrastructure error (including an uncertain COMMIT outcome)
          // is not a bad workbook. Leave it in INBOX: the receipt is checked
          // under the import lock before a retry can alter inventory.
          if (error instanceof StockWorkbookValidationError) {
            await runPostCommitTasks([{
              code: 'stock_invalid_mail_move_failed', message: 'Не удалось перенести некорректное письмо в папку ошибок.',
              run: () => moveMessage(client, candidate!.uid, errorFolder),
            }]);
          }
          throw error;
        }
        warnings.push(...(result.warnings ?? []));
        warnings.push(...await runPostCommitTasks([{
          code: 'stock_mail_move_failed',
          message: 'Результат импорта сохранён, но письмо не перенесено в архив. Повторная проверка почты не применит эти остатки заново.',
          run: () => moveMessage(client, candidate!.uid, result.status === 'failed' ? errorFolder : processedFolder),
        }, ...(result.status !== 'failed' ? supersededCandidateUids.map((uid) => ({
          code: 'stock_superseded_mail_move_failed',
          message: 'Результат импорта сохранён, но старое письмо не перенесено в архив. Его остатки повторно не применятся.',
          run: () => moveMessage(client, uid, processedFolder),
        })) : [])]));
        return emailResult({ processed: 1, result, checkedMessages: uids.length, skipped, allowedFrom, subjectPart, filePrefix, scanLimit });
      }

      return emailResult({
        checkedMessages: uids.length,
        skipped,
        allowedFrom,
        subjectPart,
        filePrefix,
        scanLimit,
      });
    } finally {
      warnings.push(...await runPostCommitTasks([{
        code: 'stock_mailbox_cleanup_failed', message: 'Результат проверки сохранён; завершение почтовой сессии требует проверки.', run: () => lock.release(),
      }]));
    }
  } finally {
    warnings.push(...await runPostCommitTasks([
      ...(client ? [
        { code: 'stock_mail_logout_failed', message: 'Результат проверки сохранён; почтовая сессия завершена принудительно.', run: () => client!.logout() },
        { code: 'stock_mail_close_failed', message: 'Результат проверки сохранён; закрытие почтового соединения требует проверки.', run: () => client!.close() },
      ] : []),
      { code: 'stock_lock_cleanup_failed', message: 'Результат проверки сохранён; завершение блокировки импорта требует проверки.', run: release },
    ]));
  }
}

export async function getStockImportLogs(limit = 20): Promise<StockImportLog[]> {
  await ensureStockImportSchema();
  const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const result = await query<{
    id: string;
    created_at: string;
    file_name: string;
    email_from: string;
    email_subject: string;
    status: StockImportResult['status'];
    total_rows: string;
    updated_rows: string;
    not_found_rows: string;
    failed_rows: string;
    errors_json: StockImportError[];
  }>(
    `select id::text,
            created_at::text,
            file_name,
            email_from,
            email_subject,
            status,
            total_rows::text,
            updated_rows::text,
            not_found_rows::text,
            failed_rows::text,
            errors_json
     from stock_import_logs
     order by created_at desc
     limit $1`,
    [normalizedLimit],
  );

  return result.rows.map((row) => ({
    logId: Number(row.id),
    createdAt: row.created_at,
    fileName: row.file_name,
    emailFrom: row.email_from,
    emailSubject: row.email_subject,
    status: row.status,
    totalRows: Number(row.total_rows),
    updatedRows: Number(row.updated_rows),
    notFoundRows: Number(row.not_found_rows),
    failedRows: Number(row.failed_rows),
    errors: Array.isArray(row.errors_json) ? row.errors_json : [],
  }));
}
