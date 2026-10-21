import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';

import { parseCatalogExcel } from '../src/entities/catalog/api/catalogExcel';
import { CatalogImportDuplicateError } from '../src/entities/catalog/api/catalogImportValidation';

function workbook(sheet: XLSX.WorkSheet, bookType: 'xlsx' | 'biff8') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Synthetic');
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType }));
}

function duplicates(sheet: XLSX.WorkSheet, bookType: 'xlsx' | 'biff8') {
  try {
    parseCatalogExcel(workbook(sheet, bookType));
    assert.fail('Expected duplicate article rejection');
  } catch (error) {
    assert.ok(error instanceof CatalogImportDuplicateError);
    assert.match(error.message, /Каталог не изменён/);
    return error.duplicates;
  }
}

for (const bookType of ['xlsx', 'biff8'] as const) {
  test(`catalog ${bookType} rejects repeated, identical and cross-brand products before returning rows`, () => {
    for (const data of [
      [['ABC', 'First brand'], ['ABC', 'First brand']],
      [['ABC', 'First brand'], ['abc', 'Other brand']],
      [['  AB\tC  ', 'First brand'], ['ab c', 'Other brand']],
    ]) {
      const sheet = XLSX.utils.aoa_to_sheet([['Артикул', 'Бренд'], ...data]);
      assert.deepEqual(duplicates(sheet, bookType), [{ article: data[0][0].trim().replace(/\s+/g, ' '), rows: [2, 3], totalRows: 2 }]);
    }
  });

  test(`catalog ${bookType} duplicate errors report physical rows across blanks and multiline headers`, () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Synthetic catalogue'],
      [],
      ['Артикул', 'Наименование', 'Цена'],
      ['', '', 'EUR'],
      ['ABC', 'First', 100],
      [],
      ['', 'No article'],
      [],
      ['abc', 'Second', 200],
    ]);
    assert.deepEqual(duplicates(sheet, bookType), [{ article: 'ABC', rows: [5, 9], totalRows: 2 }]);
  });

  test(`catalog ${bookType} duplicate row coordinates preserve a nonzero worksheet range`, () => {
    const sheet: XLSX.WorkSheet = {};
    XLSX.utils.sheet_add_aoa(sheet, [
      ['Артикул', 'Наименование'],
      ['OFFSET', 'First'],
      [],
      ['offset', 'Second'],
    ], { origin: 'D10' });
    // XLSX worksheets may start away from A1; row indices are absolute, not
    // the compact matrix position or a position relative to this range.
    sheet['!ref'] = 'D10:E13';
    assert.deepEqual(duplicates(sheet, bookType), [{ article: 'OFFSET', rows: [11, 13], totalRows: 2 }]);
  });

  test(`catalog ${bookType} sparse duplicate diagnostics include the supported last worksheet row`, () => {
    const sheet = XLSX.utils.aoa_to_sheet([['Артикул'], ['SPARSE']]);
    sheet.A50005 = { t: 's', v: 'sparse' };
    sheet['!ref'] = 'A1:A50005';
    assert.deepEqual(duplicates(sheet, bookType), [{ article: 'SPARSE', rows: [2, 50005], totalRows: 2 }]);
  });

  test(`catalog ${bookType} unique articles and distinct leading-zero strings stay accepted`, () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Артикул', 'Наименование'],
      ['0012', 'Leading zeroes'],
      ['12', 'Plain string'],
      ['UNIQUE', 'Distinct'],
    ]);
    const products = parseCatalogExcel(workbook(sheet, bookType));
    assert.deepEqual(products.map((row) => row.article), ['0012', '12', 'UNIQUE']);
    assert.ok(products.every((row) => !Object.keys(row).some((key) => /row/i.test(key))));
  });
}
