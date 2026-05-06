import * as XLSX from 'xlsx';

import type { CatalogProductInput } from './catalogAdmin';

type RawRow = Record<string, unknown>;

const HEADER_BRAND = 'Бренд';
const HEADER_CATEGORY = 'Категории';
const HEADER_SUBCATEGORY = 'Подкатегории';
const HEADER_TITLE = 'Наименование';
const HEADER_PRICE_GROUP = 'Ценовая группа';
const HEADER_PRICE_EUR = 'Цена EUR';
const HEADER_PRICE_RUB = 'Цена RUB';
const HEADER_PRICE_CNY = 'Цена CNY';
const HEADER_ARTICLE = 'Артикул';

function readCell(row: RawRow, key: string) {
  const value = row[key];
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function readPrice(row: RawRow, key: string) {
  const value = row[key];
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'number' ? value : String(value).trim();
}

export function parseCatalogExcel(buffer: Buffer): CatalogProductInput[] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('В Excel-файле нет листов');

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: null, raw: true });
  if (rows.length === 0) throw new Error('В Excel-файле нет строк');

  const products = rows
    .map((row) => ({
      brand: readCell(row, HEADER_BRAND),
      category: readCell(row, HEADER_CATEGORY) || 'Без категории',
      subcategory: readCell(row, HEADER_SUBCATEGORY) || 'Без подкатегории',
      title: readCell(row, HEADER_TITLE),
      article: readCell(row, HEADER_ARTICLE),
      priceGroup: readCell(row, HEADER_PRICE_GROUP),
      priceEur: readPrice(row, HEADER_PRICE_EUR),
      priceRub: readPrice(row, HEADER_PRICE_RUB),
      priceCny: readPrice(row, HEADER_PRICE_CNY),
      isActive: true,
    }))
    .filter((row) => row.title);

  if (products.length === 0) {
    throw new Error('В Excel-файле нет товаров с заполненным наименованием');
  }

  return products;
}
