import { parentPort, workerData } from 'node:worker_threads';
import { parseCatalogExcel } from '../catalogExcel';
import { parseStockWorkbook } from '../stockWorkbookParser';
import { CatalogImportDuplicateError, getCatalogImportSourceRow } from '../catalogImportValidation';
import { ExcelResourceLimitError } from './errors';

if (!parentPort) throw new Error('Excel parsing requires a worker');
try {
  const { kind, bytes } = workerData as { kind: 'catalog' | 'stock'; bytes: Uint8Array };
  if (!(bytes instanceof Uint8Array) || !['catalog', 'stock'].includes(kind)) throw new Error('Некорректная задача обработки Excel.');
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (kind === 'catalog') {
    const rows = parseCatalogExcel(buffer);
    parentPort.postMessage({ ok: true, kind, rows, sourceRows: rows.map(getCatalogImportSourceRow) });
  } else {
    parentPort.postMessage({ ok: true, kind, rows: parseStockWorkbook(buffer) });
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof CatalogImportDuplicateError ? {
    code: error.code, duplicates: error.duplicates, duplicateCount: error.duplicateCount, truncated: error.truncated,
  } : {
    code: error instanceof ExcelResourceLimitError ? error.code : 'EXCEL_INVALID_FILE',
    message: error instanceof Error ? error.message.slice(0, 2_000) : 'Не удалось прочитать Excel-файл.',
  } });
}
