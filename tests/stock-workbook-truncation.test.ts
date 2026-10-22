import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';

import { HEADER_ARTICLE_ALIASES, HEADER_STOCK_ALIASES, parseCurrentStock, parseStockWorkbook, readCellByAliases, readRawCellByAliases } from '../src/entities/catalog/api/stockWorkbookParser';

function sparseWarehouseWorkbook(lastRow: number, bookType: 'xlsx' | 'biff8') {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['ЛДМ 2'], ['Артикул', 'Сейчас'], ['SYNTHETIC-SKU', 3],
  ]);
  XLSX.utils.sheet_add_aoa(sheet, [
    ['1Основной склад Волжск'], ['Артикул', 'Сейчас'], ['SYNTHETIC-SKU', 8],
  ], { origin: `A${lastRow - 2}` });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Synthetic');
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType, compression: true }));
}

for (const bookType of ['xlsx', 'biff8'] as const) {
  test(`stock ${bookType} rejects a small workbook with a warehouse beyond the parser cutoff`, () => {
    const buffer = sparseWarehouseWorkbook(60_000, bookType);
    assert.ok(buffer.byteLength < 15 * 1024, 'file-size limit alone cannot catch this case');
    const limited = XLSX.read(buffer, { type: 'buffer', cellDates: false, sheetRows: 50_005 });
    assert.ok(limited.Sheets[limited.SheetNames[0]]['!fullref'], 'fixture really exercises SheetJS truncation');
    assert.throws(() => parseStockWorkbook(buffer), /обрезан при чтении\. Остатки не изменены/);
  });

  test(`stock ${bookType} rejects the first clipped row even when its header was read`, () => {
    assert.throws(() => parseStockWorkbook(sparseWarehouseWorkbook(50_006, bookType)), /обрезан при чтении\. Остатки не изменены/);
  });

  test(`stock ${bookType} keeps both warehouses in a complete sheet up to the existing row limit`, () => {
    for (const lastRow of [6, 50_000]) {
      const rows = parseStockWorkbook(sparseWarehouseWorkbook(lastRow, bookType))
        .filter(({ row }) => readCellByAliases(row, HEADER_ARTICLE_ALIASES));
      assert.deepEqual(rows.map(({ rowNumber, location, row }) => ({
        rowNumber, location, stock: parseCurrentStock(readRawCellByAliases(row, HEADER_STOCK_ALIASES)),
      })), [
        { rowNumber: 3, location: 'moscow', stock: 3 },
        { rowNumber: lastRow, location: 'volzhsk', stock: 8 },
      ]);
    }
  });

  test(`stock ${bookType} keeps the existing post-read row limit`, () => {
    assert.throws(() => parseStockWorkbook(sparseWarehouseWorkbook(50_001, bookType)), /слишком большой/);
  });
}
