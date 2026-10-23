import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { CatalogProductInput } from '../catalogAdmin/types';
import type { ParsedStockRow } from '../stockImportTypes';
import { CatalogImportDuplicateError, setCatalogImportSourceRow, type CatalogImportDuplicate } from '../catalogImportValidation';
import { ExcelProcessingError, ExcelResourceLimitError } from './errors';

export const EXCEL_PROCESSING_TIMEOUT_MS = 120_000;
export type ExcelProcessingOptions = { signal?: AbortSignal; timeoutMs?: number };
type Kind = 'catalog' | 'stock';
type Result = CatalogProductInput[] | ParsedStockRow[];
type WorkerMessage = {
  ok: boolean;
  kind?: Kind;
  rows?: Result;
  sourceRows?: number[];
  error?: { code?: string; message?: string; duplicates?: CatalogImportDuplicate[]; duplicateCount?: number; truncated?: boolean };
};

function checkInterrupted(signal?: AbortSignal, deadlineAt?: number): void {
  if (signal?.aborted) throw new ExcelProcessingError('EXCEL_PROCESSING_ABORTED');
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new ExcelProcessingError('EXCEL_PROCESSING_TIMEOUT');
}

function decodeMessage(message: WorkerMessage, kind: Kind): Result {
  if (!message || typeof message.ok !== 'boolean') throw new ExcelProcessingError('EXCEL_PROCESSING_FAILED');
  if (!message.ok) {
    const error = message.error;
    if (error?.code === 'CATALOG_DUPLICATE_ARTICLES' && Array.isArray(error.duplicates)
      && Number.isSafeInteger(error.duplicateCount) && typeof error.truncated === 'boolean') {
      throw new CatalogImportDuplicateError(error.duplicates, error.duplicateCount!, error.truncated);
    }
    if (typeof error?.message !== 'string' || !error.message || error.message.length > 2_000) throw new ExcelProcessingError('EXCEL_PROCESSING_FAILED');
    if (error.code === 'EXCEL_RESOURCE_LIMIT') {
      const restored = new ExcelResourceLimitError('');
      restored.message = error.message;
      throw restored;
    }
    if (error.code === 'EXCEL_INVALID_FILE') throw new Error(error.message);
    throw new ExcelProcessingError('EXCEL_PROCESSING_FAILED');
  }
  if (message.kind !== kind || !Array.isArray(message.rows) || message.rows.length > 50_005) throw new ExcelProcessingError('EXCEL_PROCESSING_FAILED');
  if (kind === 'catalog') {
    const rows = message.rows as CatalogProductInput[];
    if (!Array.isArray(message.sourceRows) || message.sourceRows.length !== rows.length) throw new ExcelProcessingError('EXCEL_PROCESSING_FAILED');
    rows.forEach((row, index) => {
      if (!row || typeof row !== 'object' || typeof row.article !== 'string') throw new ExcelProcessingError('EXCEL_PROCESSING_FAILED');
      setCatalogImportSourceRow(row, message.sourceRows![index]);
    });
  }
  return message.rows;
}

/** Local fail-fast guard is defense in depth; callers also hold the shared
 * catalog/stock admission slot until the parsing worker has terminated.
 * No database, credentials or paths supplied by users enter the worker.
 */
export function createExcelProcessingClient(options: {
  spawn?: (kind: Kind, bytes: Uint8Array) => Worker;
} = {}) {
  const spawn = options.spawn ?? ((kind, bytes) => new Worker(
    path.join(process.cwd(), '.runtime-build', 'excel-processing-worker.cjs'), {
      workerData: { kind, bytes }, transferList: [bytes.buffer as ArrayBuffer], execArgv: [], env: {},
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 },
    },
  ));
  let active = false;
  return async function parse(kind: Kind, buffer: Buffer, execution: ExcelProcessingOptions = {}): Promise<Result> {
    checkInterrupted(execution.signal);
    if (active) throw new ExcelProcessingError('EXCEL_PROCESSING_BUSY');
    if (buffer.byteLength > (kind === 'catalog' ? 25 : 15) * 1024 * 1024) throw new ExcelResourceLimitError('Excel-файл слишком большой.');
    const timeoutMs = execution.timeoutMs ?? EXCEL_PROCESSING_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid Excel processing timeout');
    const deadlineAt = Date.now() + timeoutMs;
    active = true;
    return new Promise<Result>((resolve, reject) => {
      let worker: Worker | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = async (error?: Error, result?: Result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        execution.signal?.removeEventListener('abort', abort);
        // The upload/global admission slot must never be freed while an aborted
        // native inflate or SheetJS parse is still running.
        try { await worker?.terminate(); }
        catch { error ??= new ExcelProcessingError('EXCEL_PROCESSING_FAILED'); }
        finally { active = false; }
        if (!error) {
          // Cancellation or loss of the shared admission connection can happen
          // after the result arrives but before native worker termination ends.
          try { checkInterrupted(execution.signal, deadlineAt); }
          catch (interrupted) { error = interrupted as ExcelProcessingError; }
        }
        if (error) reject(error);
        else resolve(result!);
      };
      const abort = () => { void settle(new ExcelProcessingError('EXCEL_PROCESSING_ABORTED')); };
      try {
        worker = spawn(kind, Uint8Array.from(buffer));
        worker.once('message', (message: WorkerMessage) => {
          if (settled) return;
          try {
            checkInterrupted(execution.signal, deadlineAt);
            const result = decodeMessage(message, kind);
            checkInterrupted(execution.signal, deadlineAt);
            void settle(undefined, result);
          } catch (error) {
            void settle(error instanceof Error ? error : new ExcelProcessingError('EXCEL_PROCESSING_FAILED'));
          }
        });
        worker.once('error', () => { void settle(new ExcelProcessingError('EXCEL_PROCESSING_FAILED')); });
        worker.once('exit', () => { void settle(new ExcelProcessingError('EXCEL_PROCESSING_FAILED')); });
        execution.signal?.addEventListener('abort', abort, { once: true });
        checkInterrupted(execution.signal, deadlineAt);
        timer = setTimeout(() => { void settle(new ExcelProcessingError('EXCEL_PROCESSING_TIMEOUT')); }, Math.max(1, deadlineAt - Date.now()));
      } catch (error) {
        void settle(error instanceof ExcelProcessingError ? error : new ExcelProcessingError('EXCEL_PROCESSING_FAILED'));
      }
    });
  };
}

const parse = createExcelProcessingClient();
export async function parseCatalogExcelInWorker(buffer: Buffer, options?: ExcelProcessingOptions): Promise<CatalogProductInput[]> {
  return await parse('catalog', buffer, options) as CatalogProductInput[];
}
export async function parseStockWorkbookInWorker(buffer: Buffer, options?: ExcelProcessingOptions): Promise<ParsedStockRow[]> {
  return await parse('stock', buffer, options) as ParsedStockRow[];
}
