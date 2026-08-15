import assert from 'node:assert/strict';
import test from 'node:test';

import * as XLSX from 'xlsx';

import { parseCatalogExcel } from '../src/entities/catalog/api/catalogExcel';

test('catalog Excel parser reads a current SheetJS workbook', () => {
  const sheet = XLSX.utils.json_to_sheet([
    {
      Бренд: 'Test Brand',
      Категории: 'Компрессоры',
      Подкатегории: 'Спиральные',
      Наименование: 'Тестовый товар',
      Артикул: 'TEST-001',
      Модель: 'M1',
      'Цена EUR': 125.5,
    },
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Каталог');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  const products = parseCatalogExcel(Buffer.from(buffer));

  assert.equal(products.length, 1);
  assert.deepEqual(products[0], {
    brand: 'Test Brand',
    category: 'Компрессоры',
    subcategory: 'Спиральные',
    title: 'Тестовый товар',
    article: 'TEST-001',
    model: 'M1',
    priceGroup: '',
    priceEur: '125.5',
    priceRub: null,
    priceCny: null,
    generalDiscount: null,
    manualDiscount: null,
    manualDiscountRop: null,
    isActive: true,
  });
});

test('catalog Excel parser rejects workbooks with too many sheets', () => {
  const workbook = XLSX.utils.book_new();
  for (let index = 1; index <= 6; index += 1) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Артикул'], [`TEST-${index}`]]), `Лист ${index}`);
  }
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  assert.throws(() => parseCatalogExcel(Buffer.from(buffer)), /слишком много листов/);
});
