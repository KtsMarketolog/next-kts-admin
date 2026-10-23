import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import test, { before } from 'node:test';
import { Worker } from 'node:worker_threads';
import * as XLSX from 'xlsx';
import { parseCatalogExcelInWorker, parseStockWorkbookInWorker, createExcelProcessingClient } from '../src/entities/catalog/api/excelProcessing/client';
import { ExcelProcessingError, ExcelResourceLimitError } from '../src/entities/catalog/api/excelProcessing/errors';
import { CatalogImportDuplicateError, getCatalogImportSourceRow } from '../src/entities/catalog/api/catalogImportValidation';

before(() => { execFileSync(process.execPath, ['scripts/build-excel-worker.mjs'], { stdio: 'pipe' }); });

function workbook(sheet: XLSX.WorkSheet, bookType: 'xlsx' | 'biff8' = 'xlsx') {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Synthetic');
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType, compression: true }));
}
const errorCode = (code: string) => (error: unknown) => error instanceof ExcelProcessingError && error.code === code;

test('real worker preserves catalog source coordinates and duplicate errors, and both XLSX/XLS stock modes', async () => {
  for (const bookType of ['xlsx', 'biff8'] as const) {
    const sheet = XLSX.utils.aoa_to_sheet([['Артикул', 'Наименование'], [], ['001', 'Synthetic'], [], ['002', 'Synthetic B']]);
    const rows = await parseCatalogExcelInWorker(workbook(sheet, bookType));
    assert.deepEqual(rows.map(getCatalogImportSourceRow), [3, 5]);
    assert.deepEqual(rows.map(row => row.article), ['001', '002']);
    sheet.A5 = { t: 's', v: '001' };
    await assert.rejects(parseCatalogExcelInWorker(workbook(sheet, bookType)), (error: unknown) => {
      assert.ok(error instanceof CatalogImportDuplicateError);
      assert.deepEqual(error.duplicates, [{ article: '001', rows: [3, 5], totalRows: 2 }]);
      assert.equal(error.duplicateCount, 1); assert.equal(error.truncated, false); return true;
    });
    const stocks = await parseStockWorkbookInWorker(workbook(XLSX.utils.aoa_to_sheet([['Артикул', 'Сейчас'], ['001', 11]]), bookType));
    assert.equal(stocks[0].row['Сейчас'], 11);
  }
});

test('worker lifetime covers cancellation, deadline, malformed reply, crash and spawn failures', async () => {
  const workers: Worker[] = [];
  const parse = createExcelProcessingClient({ spawn: () => {
    const worker = new Worker('setInterval(() => {},1000)', { eval: true, execArgv: [] });
    workers.push(worker); return worker;
  } });
  const abort = new AbortController();
  const canceled = assert.rejects(parse('catalog', Buffer.alloc(1), { signal: abort.signal }), errorCode('EXCEL_PROCESSING_ABORTED'));
  await assert.rejects(parse('stock', Buffer.alloc(1)), errorCode('EXCEL_PROCESSING_BUSY'));
  abort.abort(); await canceled; assert.equal(workers[0].threadId, -1);
  await assert.rejects(parse('catalog', Buffer.alloc(1), { timeoutMs: 10 }), errorCode('EXCEL_PROCESSING_TIMEOUT'));
  assert.equal(workers[1].threadId, -1);
  await assert.rejects(parse('catalog', Buffer.alloc(1), { signal: AbortSignal.abort() }), errorCode('EXCEL_PROCESSING_ABORTED'));
  await assert.rejects(parse('catalog', Buffer.alloc(25 * 1024 * 1024 + 1)), ExcelResourceLimitError);
  await assert.rejects(parse('stock', Buffer.alloc(15 * 1024 * 1024 + 1)), ExcelResourceLimitError);
  assert.equal(workers.length, 2);
  for (const script of ['process.exit(0)', 'throw new Error("Synthetic crash")', 'require("node:worker_threads").parentPort.postMessage({ok:true,kind:"catalog",rows:[{}],sourceRows:[2]});']) {
    let worker: Worker | undefined;
    const fail = createExcelProcessingClient({ spawn: () => (worker = new Worker(script, { eval: true, execArgv: [] })) });
    await assert.rejects(fail('catalog', Buffer.alloc(1)), errorCode('EXCEL_PROCESSING_FAILED'));
    assert.equal(worker?.threadId, -1);
  }
  const failed = createExcelProcessingClient({ spawn: () => { throw new Error('Synthetic unavailable runtime'); } });
  await assert.rejects(failed('catalog', Buffer.alloc(1)), errorCode('EXCEL_PROCESSING_FAILED'));
  await assert.rejects(failed('catalog', Buffer.alloc(1)), errorCode('EXCEL_PROCESSING_FAILED'));
});

test('worker heap exhaustion is contained, reported as unavailable, and releases admission after termination', async () => {
  let worker: Worker | undefined;
  const parse = createExcelProcessingClient({ spawn: () => (worker = new Worker(
    'const values=[]; for(let i=0;i<2000000;i++) values.push({value:i,text:String(i)});', {
      eval: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 2 },
    },
  )) });
  await assert.rejects(parse('catalog', Buffer.alloc(1)), (error: unknown) => {
    assert.ok(error instanceof ExcelProcessingError);
    assert.equal(error.code, 'EXCEL_PROCESSING_FAILED'); assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /разделите/);
    return true;
  });
  assert.equal(worker?.threadId, -1);
});

test('success is not returned when cancellation or deadline occurs during native worker termination', async () => {
  for (const reason of ['abort', 'deadline'] as const) {
    let terminated: (() => void) | undefined;
    const fakeWorker = new EventEmitter() as EventEmitter & { terminate: () => Promise<number> };
    fakeWorker.terminate = () => new Promise<number>((resolve) => { terminated = () => resolve(0); });
    const parse = createExcelProcessingClient({ spawn: () => fakeWorker as unknown as Worker });
    const controller = new AbortController();
    const result = parse('stock', Buffer.alloc(1), { signal: controller.signal, timeoutMs: reason === 'deadline' ? 20 : 1_000 });
    const rejected = assert.rejects(result, errorCode(reason === 'deadline' ? 'EXCEL_PROCESSING_TIMEOUT' : 'EXCEL_PROCESSING_ABORTED'));
    fakeWorker.emit('message', { ok: true, kind: 'stock', rows: [] });
    assert.ok(terminated);
    await assert.rejects(parse('catalog', Buffer.alloc(1)), errorCode('EXCEL_PROCESSING_BUSY'));
    if (reason === 'abort') controller.abort();
    else await new Promise<void>((resolve) => setTimeout(resolve, 30));
    terminated();
    await rejected;
  }
});

test('real worker handles a 50,000-row, 20-column catalog without blocking request-thread timers', { timeout: 120_000 }, async () => {
  const headers = ['Артикул', 'Наименование', 'Бренд', 'Категории', 'Подкатегории', 'Модель', 'Ценовая группа',
    'Цена EUR', 'Цена RUB', 'Цена CNY', 'Общая скидка', 'Ручная скидка', 'Ручная скидка роп', ...Array.from({ length: 7 }, (_, index) => `Дополнительно ${index}`)];
  const matrix: (string | number)[][] = [headers];
  for (let index = 1; index < 50_000; index += 1) matrix.push([
    `SYN-${index}`, `Компрессор SC 18 CLX.2 104L2197 (117U6013, 117U5012) №${index}`, 'Synthetic', 'Категория', 'Подкатегория',
    `SC18-${index}`, 'Группа', 12.34, 1234.56, 78.9, 5, 2, 1, ...Array.from({ length: 7 }, () => 'Обычная характеристика товара'),
  ]);
  const bytes = workbook(XLSX.utils.aoa_to_sheet(matrix));
  assert.ok(bytes.length <= 25 * 1024 * 1024, `fixture must fit the existing byte limit (${bytes.length})`);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  try {
    const rows = await parseCatalogExcelInWorker(bytes);
    assert.equal(rows.length, 49_999); assert.equal(rows.at(-1)?.article, 'SYN-49999');
    assert.equal(getCatalogImportSourceRow(rows.at(-1)!), 50_000);
    assert.equal(Number(rows[0].priceRub), 1234.56);
    assert.ok(ticks >= 5, `request-thread timers continued while the worker parsed (${ticks})`);
  } finally { clearInterval(timer); }
});

test('real worker preserves a large legacy XLS catalog with 20,000 rows and 14 columns', { timeout: 120_000 }, async () => {
  const matrix: (string | number)[][] = [[
    'Артикул', 'Наименование', 'Бренд', 'Категории', 'Подкатегории', 'Модель', 'Ценовая группа',
    'Цена EUR', 'Цена RUB', 'Цена CNY', 'Общая скидка', 'Ручная скидка', 'Ручная скидка роп', 'Комментарий',
  ]];
  for (let index = 1; index < 20_000; index += 1) matrix.push([
    `SYN-${index}`, `Компрессор SC 18 CLX.2 ${index}`, 'Synthetic', 'Категория', 'Подкатегория', 'SC18', 'Группа',
    12.34, 1234.56, 78.9, 5, 2, 1, 'Дополнение',
  ]);
  const bytes = workbook(XLSX.utils.aoa_to_sheet(matrix), 'biff8');
  assert.ok(bytes.length <= 25 * 1024 * 1024);
  const rows = await parseCatalogExcelInWorker(bytes);
  assert.equal(rows.length, 19_999); assert.equal(rows.at(-1)?.article, 'SYN-19999');
  assert.equal(getCatalogImportSourceRow(rows.at(-1)!), 20_000);
  assert.equal(Number(rows[0].priceRub), 1234.56);
});
