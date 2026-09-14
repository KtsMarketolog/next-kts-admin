import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';

import { parseCatalogExcel } from '../src/entities/catalog/api/catalogExcel';

function sparseWorkbook(lastRow: number, bookType: 'xlsx' | 'biff8') {
  const sheet = XLSX.utils.aoa_to_sheet([['Артикул', 'Наименование'], ['EARLY', 'Synthetic early product']]);
  sheet[`A${lastRow}`] = { t: 's', v: 'LATE' };
  sheet[`B${lastRow}`] = { t: 's', v: 'Synthetic late product' };
  sheet['!ref'] = `A1:B${lastRow}`;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Synthetic');
  return Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType }));
}

for (const bookType of ['xlsx', 'biff8'] as const) {
  test(`catalog ${bookType} refuses a clipped sparse sheet rather than silently importing only its prefix`, () => {
    const buffer = sparseWorkbook(50_006, bookType);
    assert.ok(buffer.byteLength < 25 * 1024 * 1024);
    assert.throws(() => parseCatalogExcel(buffer), /обрезан при чтении.*Каталог не изменён/);
  });

  test(`catalog ${bookType} preserves both sparse products when the last row is still inside the read boundary`, () => {
    const products = parseCatalogExcel(sparseWorkbook(50_005, bookType));
    assert.deepEqual(products.map(({ article }) => article), ['EARLY', 'LATE']);
  });
}
