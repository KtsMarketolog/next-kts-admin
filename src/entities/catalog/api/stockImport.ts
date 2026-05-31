import { ensureSiteSchema } from '@/shared/lib/db';
import { query, withTransaction } from '@/shared/lib/db/client';

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

const LOCK_KEY = 'email';
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

    create index if not exists catalog_products_stock_article_norm_idx
      on catalog_products (lower(trim(coalesce(article, ''))));
    create index if not exists stock_import_logs_created_idx on stock_import_logs(created_at desc);
  `);
}

async function saveImportLog(result: Omit<StockImportResult, 'logId'>) {
  const saved = await query<{ id: string }>(
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
  return Number(saved.rows[0]?.id ?? 0) || null;
}

async function acquireImportLock() {
  await ensureStockImportSchema();
  const result = await withTransaction(async (client) => {
    await client.query(`delete from stock_import_locks where key = $1 and locked_at < now() - interval '30 minutes'`, [LOCK_KEY]);
    const inserted = await client.query(
      `insert into stock_import_locks (key, locked_at)
       values ($1, now())
       on conflict (key) do nothing`,
      [LOCK_KEY],
    );
    return inserted.rowCount === 1;
  });
  return result;
}

async function releaseImportLock() {
  await query(`delete from stock_import_locks where key = $1`, [LOCK_KEY]).catch(() => {});
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

export async function importStockFromExcelBuffer(input: {
  buffer: Buffer;
  fileName: string;
  emailFrom?: string;
  emailSubject?: string;
}): Promise<StockImportResult> {
  const locked = await acquireImportLock();
  if (!locked) {
    throw new Error('Импорт остатков уже выполняется');
  }

  try {
    await ensureStockImportSchema();
    const rows = parseStockWorkbook(input.buffer);
    const errors: StockImportError[] = [];
    let totalRows = 0;
    let updatedRows = 0;
    let notFoundRows = 0;
    let failedRows = 0;
    const stockByArticle = new Map<string, AggregatedStock>();

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
      if (stock === null) {
        failedRows += 1;
        pushError(errors, { row: rowNumber, name: article, error: 'Сейчас не является целым неотрицательным числом' });
        continue;
      }

      const articleKey = article.toLowerCase();
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

    await withTransaction(async (client) => {
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
    });

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
    const logId = await saveImportLog(withoutId);
    return { logId, ...withoutId };
  } finally {
    await releaseImportLock();
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
    processed?: number;
    result?: StockImportResult | null;
    checkedMessages: number;
    skipped: StockEmailImportResult['skipped'];
    allowedFrom: string;
    subjectPart: string;
    filePrefix: string;
    scanLimit?: number;
  },
): StockEmailImportResult {
  return {
    processed: input.processed ?? 0,
    result: input.result ?? null,
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
  await client.messageMove(String(uid), folder, { uid: true }).catch(async () => {
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => undefined);
  });
}

export async function importStockFromEmail(): Promise<StockEmailImportResult> {
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

  const [{ ImapFlow }, { simpleParser }] = await Promise.all([import('imapflow'), import('mailparser')]);
  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass: password },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
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
        return createEmailResult({
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
          };
        } else {
          supersededCandidateUids.push(message.uid);
        }
      }

      if (candidate) {
        try {
          const result = await importStockFromExcelBuffer({
            buffer: candidate.buffer,
            fileName: candidate.fileName,
            emailFrom: candidate.emailFrom,
            emailSubject: candidate.emailSubject,
          });
          await moveMessage(client, candidate.uid, result.status === 'failed' ? errorFolder : processedFolder);
          if (result.status !== 'failed') {
            await Promise.all(supersededCandidateUids.map((uid) => moveMessage(client, uid, processedFolder)));
          }
          return createEmailResult({
            processed: 1,
            result,
            checkedMessages: uids.length,
            skipped,
            allowedFrom,
            subjectPart,
            filePrefix,
            scanLimit,
          });
        } catch (error) {
          await moveMessage(client, candidate.uid, errorFolder);
          throw error;
        }
      }

      return createEmailResult({
        checkedMessages: uids.length,
        skipped,
        allowedFrom,
        subjectPart,
        filePrefix,
        scanLimit,
      });
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
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
