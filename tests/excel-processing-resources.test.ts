import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import * as XLSX from 'xlsx';
import { parseCatalogExcel } from '../src/entities/catalog/api/catalogExcel';
import { parseStockWorkbook } from '../src/entities/catalog/api/stockWorkbookParser';
import { ExcelResourceLimitError } from '../src/entities/catalog/api/excelProcessing/errors';
import { assertExcelArchiveResources, assertExcelWorkbookResources, EXCEL_RESOURCE_LIMITS } from '../src/entities/catalog/api/excelProcessing/resources';
import { assertLegacyOleResources } from '../src/entities/catalog/api/excelProcessing/legacyOleResources';

function archive(entries: Array<{ name: string; text: string; declaredSize?: number; method?: 0 | 8; descriptor?: boolean; extra?: Buffer }>, comment = Buffer.alloc(0)) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const extra = entry.extra ?? Buffer.alloc(0);
    const data = Buffer.from(entry.text);
    const method = entry.method ?? 8;
    const payload = method ? deflateRawSync(data) : data;
    const size = entry.declaredSize ?? data.length;
    const flags = entry.descriptor ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.descriptor ? 0 : payload.length, 18); local.writeUInt32LE(entry.descriptor ? 0 : size, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    const descriptor = Buffer.alloc(entry.descriptor ? 16 : 0);
    if (entry.descriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(payload.length, 8); descriptor.writeUInt32LE(size, 12);
    }
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(flags, 8); header.writeUInt16LE(method, 10);
    header.writeUInt32LE(payload.length, 20); header.writeUInt32LE(size, 24); header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(extra.length, 30); header.writeUInt32LE(localOffset, 42);
    locals.push(local, name, extra, payload, descriptor); central.push(header, name, extra);
    localOffset += local.length + name.length + extra.length + payload.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(localOffset, 16); end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, end, comment]);
}

function workbook(matrix: unknown[][], bookType: 'xlsx' | 'biff8' = 'xlsx') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(matrix), 'Synthetic');
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType, compression: true }));
}

function replaceWorkbookXml(buffer: Buffer, find: string, replace: string): Buffer {
  const cfb = XLSX.CFB.read(buffer, { type: 'buffer' });
  const file = cfb.FileIndex.find((item: { name: string }) => item.name === 'sheet1.xml');
  assert.ok(file);
  const source = Buffer.from(file.content).toString('utf8');
  assert.ok(source.includes(find));
  file.content = Buffer.from(source.replace(find, replace)); file.size = file.content.length;
  return Buffer.from(XLSX.CFB.write(cfb, { type: 'buffer', fileType: 'zip', compression: true }));
}

test('archive budgets count actual inflation, including forged local AND central uncompressed sizes', () => {
  const bomb = archive([{ name: 'xl/sharedStrings.xml', text: 'x'.repeat(1_000_000), declaredSize: 100 }]);
  assert.ok(bomb.length < 2_000);
  assert.throws(() => assertExcelArchiveResources(bomb), ExcelResourceLimitError);
  const limits = { zipEntries: 10, unpackedBytes: 1_000, entryBytes: 800 };
  assert.throws(() => assertExcelArchiveResources(archive([{ name: 'one', text: 'x'.repeat(600) }, { name: 'two', text: 'y'.repeat(600) }]), limits), ExcelResourceLimitError);
  assert.throws(() => assertExcelArchiveResources(archive([{ name: 'one', text: 'x'.repeat(801) }]), limits), ExcelResourceLimitError);
});

test('archive preflight supports ordinary deflated, stored and data-descriptor entries without ratio false positives', () => {
  for (const method of [0, 8] as const) {
    for (const descriptor of [true, false]) {
      assert.doesNotThrow(() => assertExcelArchiveResources(archive([{ name: 'xl/synthetic.xml', text: 'x'.repeat(500_000), method, descriptor }])));
    }
  }
});

test('archive preflight rejects ambiguous headers, ZIP64 overrides, overlapping paths and EOCD comment smuggling', () => {
  const valid = archive([{ name: 'a', text: 'one' }]);
  const mismatched = Buffer.from(valid); mismatched.writeUInt32LE(0x7fffffff, 22);
  assert.throws(() => assertExcelArchiveResources(mismatched), /Некорректный/);
  const zip64 = Buffer.alloc(12); zip64.writeUInt16LE(1, 0); zip64.writeUInt16LE(8, 2); zip64.writeBigUInt64LE(BigInt(8_000_000_000), 4);
  assert.throws(() => assertExcelArchiveResources(archive([{ name: 'a', text: 'one', extra: zip64 }])), /Некорректный/);
  assert.throws(() => assertExcelArchiveResources(archive([{ name: 'A', text: 'one' }, { name: 'a', text: 'two' }])), /Некорректный/);
  assert.throws(() => assertExcelArchiveResources(archive([{ name: '../a', text: 'one' }])), /Некорректный/);
  assert.throws(() => assertExcelArchiveResources(archive([{ name: 'a', text: 'one' }], Buffer.from([0x50, 0x4b, 0x05, 0x06]))), /Некорректный/);
  for (const length of [2, 20, valid.length - 1]) assert.throws(() => assertExcelArchiveResources(valid.subarray(0, length)), /Некорректный/);
  assert.throws(() => assertExcelArchiveResources(valid, { zipEntries: 0, unpackedBytes: 100, entryBytes: 100 }), ExcelResourceLimitError);
});

test('small XLSX with a million-character cell is rejected in catalog and stock paths', () => {
  const catalog = replaceWorkbookXml(workbook([['Артикул', 'Наименование'], ['SYN-A', 'MARKER']]), 'MARKER', 'x'.repeat(1_000_000));
  const stock = replaceWorkbookXml(workbook([['Артикул', 'Сейчас'], ['MARKER', 1]]), 'MARKER', 'x'.repeat(1_000_000));
  assert.ok(catalog.length < 30_000); assert.ok(stock.length < 30_000);
  assert.throws(() => parseCatalogExcel(catalog), (error: unknown) => error instanceof ExcelResourceLimitError && /B2.*32767/.test(error.message));
  assert.throws(() => parseStockWorkbook(stock), (error: unknown) => error instanceof ExcelResourceLimitError && /A2.*32767/.test(error.message));
});

test('normal .xlsx and legacy .xls keep maximum legal cell text, prices, formatting and stock parsing', () => {
  for (const bookType of ['xlsx', 'biff8'] as const) {
    // SheetJS's BIFF8 fixture writer itself truncates strings at 255 characters;
    // that pre-existing writer behavior is unrelated to the upload guard.
    const text = 'x'.repeat(bookType === 'xlsx' ? EXCEL_RESOURCE_LIMITS.cellCharacters : 255);
    const catalog = parseCatalogExcel(workbook([['Артикул', 'Наименование', 'Цена RUB'], ['001', text, 123.45]], bookType));
    assert.equal(catalog[0].title, text); assert.equal(Number(catalog[0].priceRub), 123.45);
    const stock = parseStockWorkbook(workbook([['Артикул', 'Сейчас'], ['001', 11]], bookType));
    assert.equal(stock[0].row['Артикул'], '001'); assert.equal(stock[0].row['Сейчас'], 11);
  }
});

test('legacy XLS metadata is checked before native stream materialization', () => {
  const valid = workbook([['Артикул', 'Наименование'], ...Array.from({ length: 200 }, (_, index) => [`SYN-${index}`, 'Synthetic product'])], 'biff8');
  assert.doesNotThrow(() => assertLegacyOleResources(valid));
  // Small fixtures are checked by the preflight only: malformed structures are
  // never passed to SheetJS. No large allocation or exhaustion is necessary.
  const directory = valid.readUInt32LE(48);
  const fatSector = valid.readUInt32LE(76);
  const directoryOffset = (directory + 1) * 512;
  const fatOffset = (fatSector + 1) * 512;
  const cyclic = Buffer.from(valid);
  cyclic.writeUInt32LE(directory, fatOffset + directory * 4);
  assert.throws(() => assertLegacyOleResources(cyclic), /Некорректная структура/);
  const outside = Buffer.from(valid);
  outside.writeUInt32LE(valid.length, 48);
  assert.throws(() => assertLegacyOleResources(outside), /Некорректная структура/);
  const directoryCycle = Buffer.from(valid);
  directoryCycle.writeUInt32LE(0, directoryOffset + 76);
  assert.throws(() => assertLegacyOleResources(directoryCycle), /Некорректная структура/);
  const oversizedStream = Buffer.from(valid);
  oversizedStream.writeUInt32LE(valid.length + 1, directoryOffset + 128 + 120);
  assert.throws(() => assertLegacyOleResources(oversizedStream), ExcelResourceLimitError);
  assert.throws(() => assertLegacyOleResources(valid, { unpackedBytes: 512, entryBytes: valid.length }), ExcelResourceLimitError);
});

test('decoded workbook guards huge sparse dimensions and aggregate text before rectangular conversion', () => {
  const sheet = XLSX.utils.aoa_to_sheet([['Артикул', 'Наименование'], ['SYN', 'Synthetic']]);
  const book = { SheetNames: ['Synthetic'], Sheets: { Synthetic: sheet } };
  sheet['!ref'] = 'A1:XFD50000';
  assert.throws(() => assertExcelWorkbookResources(book), /столбцов/);
  sheet['!ref'] = 'A1:IV50000';
  assert.throws(() => assertExcelWorkbookResources(book), /Диапазон ячеек/);
  sheet['!ref'] = 'A1:A1025';
  const text = 'x'.repeat(32_767);
  for (let row = 1; row <= 1025; row += 1) sheet[`A${row}`] = { t: 's', v: text };
  assert.throws(() => assertExcelWorkbookResources(book), /общий объём текста/);
});
