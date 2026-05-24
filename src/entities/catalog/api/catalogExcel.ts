import * as XLSX from 'xlsx';

import type { CatalogProductInput } from './catalogAdmin';

type RawRow = Record<string, unknown>;
type RawMatrixRow = unknown[];

const MAX_CATALOG_EXCEL_BYTES = 25 * 1024 * 1024;
const MAX_CATALOG_EXCEL_ROWS = 50_000;
const MAX_CATALOG_EXCEL_SHEETS = 5;

const HEADER_BRAND = 'Бренд';
const HEADER_CATEGORY = 'Категории';
const HEADER_SUBCATEGORY = 'Подкатегории';
const HEADER_TITLE = 'Наименование';
const HEADER_PRICE_GROUP = 'Ценовая группа';
const HEADER_PRICE_EUR = 'Цена EUR';
const HEADER_PRICE_RUB = 'Цена RUB';
const HEADER_PRICE_CNY = 'Цена CNY';
const HEADER_PRICE_USD = 'USD';
const HEADER_GENERAL_DISCOUNT = 'Общая скидка';
const HEADER_MANUAL_DISCOUNT = 'Ручная скидка';
const HEADER_MANUAL_DISCOUNT_ROP = 'Ручная скидка роп';
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

function readFirstPrice(row: RawRow, keys: string[]) {
  for (const key of keys) {
    const value = readPrice(row, key);
    if (value !== null) return value;
  }
  return null;
}

function normalizeHeader(value: unknown) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function cellAt(row: RawMatrixRow | undefined, index: number) {
  const value = row?.[index];
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function isContinuationHeaderRow(row: RawMatrixRow | undefined) {
  if (!row) return false;
  const values = row.map(normalizeHeader).filter(Boolean);
  if (values.length === 0) return false;
  const known = new Set(['usd', 'eur', 'rub', 'руб', 'руб.', 'cny', 'цена']);
  return values.every((value) => known.has(value));
}

function includesAny(value: string, aliases: string[]) {
  return aliases.some((alias) => value.includes(alias));
}

function findColumn(headers: string[], match: (header: string) => boolean) {
  const index = headers.findIndex(match);
  return index >= 0 ? index : null;
}

function parseCatalogMatrix(sheet: XLSX.WorkSheet): CatalogProductInput[] | null {
  const matrix = XLSX.utils.sheet_to_json<RawMatrixRow>(sheet, { header: 1, defval: null, raw: true, blankrows: false });
  if (matrix.length > MAX_CATALOG_EXCEL_ROWS) throw new Error('Excel-С„Р°Р№Р» СЃР»РёС€РєРѕРј Р±РѕР»СЊС€РѕР№');
  const headerRowIndex = matrix.findIndex((row) => row.some((cell) => normalizeHeader(cell) === normalizeHeader(HEADER_ARTICLE)));
  if (headerRowIndex < 0) return null;

  let headerEndIndex = headerRowIndex;
  while (headerEndIndex + 1 < matrix.length && headerEndIndex - headerRowIndex < 2 && isContinuationHeaderRow(matrix[headerEndIndex + 1])) {
    headerEndIndex += 1;
  }

  const maxColumns = Math.max(...matrix.slice(headerRowIndex, headerEndIndex + 1).map((row) => row.length));
  const headers = Array.from({ length: maxColumns }, (_, columnIndex) =>
    matrix
      .slice(headerRowIndex, headerEndIndex + 1)
      .map((row) => normalizeHeader(row[columnIndex]))
      .filter(Boolean)
      .join(' '),
  );

  const columns = {
    article: findColumn(headers, (header) => includesAny(header, ['артикул'])),
    title: findColumn(headers, (header) => includesAny(header, ['наименование'])),
    category: findColumn(headers, (header) => includesAny(header, ['категории']) && !includesAny(header, ['подкатегории'])),
    subcategory: findColumn(headers, (header) => includesAny(header, ['подкатегории'])),
    brand: findColumn(headers, (header) => includesAny(header, ['бренд'])),
    priceGroup: findColumn(headers, (header) => includesAny(header, ['ценовая группа'])),
    priceUsd: findColumn(headers, (header) => includesAny(header, ['usd', 'доллар'])),
    priceEur: findColumn(headers, (header) => includesAny(header, ['eur', 'евро'])),
    priceRub: findColumn(headers, (header) => includesAny(header, ['rub', 'руб'])),
    priceCny: findColumn(headers, (header) => includesAny(header, ['cny', 'юань'])),
    generalDiscount: findColumn(headers, (header) => includesAny(header, ['общая скидка'])),
    manualDiscountRop: findColumn(headers, (header) => includesAny(header, ['ручная скидка роп'])),
    manualDiscount: findColumn(headers, (header) => includesAny(header, ['ручная скидка']) && !includesAny(header, ['роп'])),
  };

  if (columns.article === null) return null;

  const products = matrix
    .slice(headerEndIndex + 1)
    .map((row) => {
      const article = cellAt(row, columns.article ?? -1);
      const title = columns.title === null ? article : cellAt(row, columns.title) || article;
      return {
        brand: columns.brand === null ? '' : cellAt(row, columns.brand),
        category: columns.category === null ? 'Без категории' : cellAt(row, columns.category) || 'Без категории',
        subcategory: columns.subcategory === null ? 'Без подкатегории' : cellAt(row, columns.subcategory) || 'Без подкатегории',
        title,
        article,
        priceGroup: columns.priceGroup === null ? '' : cellAt(row, columns.priceGroup),
        priceEur: columns.priceEur === null ? null : cellAt(row, columns.priceEur),
        priceRub: columns.priceRub === null ? null : cellAt(row, columns.priceRub),
        priceCny: columns.priceCny === null ? null : cellAt(row, columns.priceCny),
        priceUsd: columns.priceUsd === null ? null : cellAt(row, columns.priceUsd),
        generalDiscount: columns.generalDiscount === null ? null : cellAt(row, columns.generalDiscount),
        manualDiscount: columns.manualDiscount === null ? null : cellAt(row, columns.manualDiscount),
        manualDiscountRop: columns.manualDiscountRop === null ? null : cellAt(row, columns.manualDiscountRop),
        isActive: true,
      };
    })
    .filter((row) => row.article);

  return products;
}

export function parseCatalogExcel(buffer: Buffer): CatalogProductInput[] {
  if (buffer.byteLength > MAX_CATALOG_EXCEL_BYTES) throw new Error('Excel-С„Р°Р№Р» СЃР»РёС€РєРѕРј Р±РѕР»СЊС€РѕР№');
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, sheetRows: MAX_CATALOG_EXCEL_ROWS + 5 });
  if (workbook.SheetNames.length > MAX_CATALOG_EXCEL_SHEETS) throw new Error('Excel-С„Р°Р№Р» СЃРѕРґРµСЂР¶РёС‚ СЃР»РёС€РєРѕРј РјРЅРѕРіРѕ Р»РёСЃС‚РѕРІ');
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('В Excel-файле нет листов');

  const sheet = workbook.Sheets[sheetName];
  const matrixProducts = parseCatalogMatrix(sheet);
  if (matrixProducts) {
    if (matrixProducts.length === 0) {
      throw new Error('В Excel-файле нет товаров с заполненным артикулом');
    }
    return matrixProducts;
  }

  const rows = XLSX.utils.sheet_to_json<RawRow>(sheet, { defval: null, raw: true });
  if (rows.length > MAX_CATALOG_EXCEL_ROWS) throw new Error('Excel-С„Р°Р№Р» СЃР»РёС€РєРѕРј Р±РѕР»СЊС€РѕР№');
  if (rows.length === 0) throw new Error('В Excel-файле нет строк');

  const products = rows
    .map((row) => ({
      brand: readCell(row, HEADER_BRAND),
      category: readCell(row, HEADER_CATEGORY) || 'Без категории',
      subcategory: readCell(row, HEADER_SUBCATEGORY) || 'Без подкатегории',
      title: readCell(row, HEADER_TITLE) || readCell(row, HEADER_ARTICLE),
      article: readCell(row, HEADER_ARTICLE),
      priceGroup: readCell(row, HEADER_PRICE_GROUP),
      priceEur: readPrice(row, HEADER_PRICE_EUR),
      priceRub: readPrice(row, HEADER_PRICE_RUB),
      priceCny: readPrice(row, HEADER_PRICE_CNY),
      priceUsd: readFirstPrice(row, [HEADER_PRICE_USD, 'Цена USD']),
      generalDiscount: readPrice(row, HEADER_GENERAL_DISCOUNT),
      manualDiscount: readPrice(row, HEADER_MANUAL_DISCOUNT),
      manualDiscountRop: readPrice(row, HEADER_MANUAL_DISCOUNT_ROP),
      isActive: true,
    }))
    .filter((row) => row.article);

  if (products.length === 0) {
    throw new Error('В Excel-файле нет товаров с заполненным артикулом');
  }

  return products;
}
