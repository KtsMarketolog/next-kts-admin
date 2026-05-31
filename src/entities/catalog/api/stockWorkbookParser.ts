import * as XLSX from 'xlsx';

import type { ParsedStockRow, RawRow, StockLocationKey } from './stockImportTypes';

export const HEADER_ARTICLE_ALIASES = ['Номенклатура.Код', 'Номенклатура. Код', 'Артикул'];
export const HEADER_STOCK_ALIASES = ['Сейчас', 'Сейчас Доступно', 'Остаток', 'Остатки'];
export const HEADER_UNIT_ALIASES = ['Ед. изм.', 'Ед. изм', 'Единица измерения'];
export const HEADER_EXPECTED_ALIASES = ['Ожидается', 'Ожидается Доступно'];
const MAX_STOCK_WORKBOOK_BYTES = 15 * 1024 * 1024;
const MAX_STOCK_WORKBOOK_ROWS = 50_000;

export function normalizeStockProductName(value: unknown) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeHeader(value: unknown) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function readCellByAliases(row: RawRow, aliases: string[]) {
  const wanted = new Set(aliases.map(normalizeHeader));
  const entry = Object.entries(row).find(([key]) => wanted.has(normalizeHeader(key)));
  const value = entry?.[1];
  return value === null || value === undefined ? '' : String(value).trim();
}

export function readRawCellByAliases(row: RawRow, aliases: string[]) {
  const wanted = new Set(aliases.map(normalizeHeader));
  const entry = Object.entries(row).find(([key]) => wanted.has(normalizeHeader(key)));
  return entry?.[1] ?? '';
}

function parseStock(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const amount = Math.round(value);
    return Math.abs(value - amount) < 0.000001 && Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
  }

  const text = String(value).replace(/\u00a0/g, ' ').trim().replace(/\s+/g, '');
  let normalized = text;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(normalized)) {
    normalized = normalized.replace(/,/g, '');
  } else if (/^\d+,\d+$/.test(normalized)) {
    normalized = normalized.replace(',', '.');
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const amount = Number(normalized);
  const rounded = Math.round(amount);
  return Math.abs(amount - rounded) < 0.000001 && Number.isSafeInteger(rounded) && rounded >= 0 ? rounded : null;
}

export function parseCurrentStock(value: unknown) {
  if (value === null || value === undefined || value === '') return 0;
  const text = String(value).replace(/\u00a0/g, ' ').trim();
  if (!text) return 0;
  return parseStock(value);
}

export function parseExpected(value: unknown) {
  const text = String(value ?? '').replace(/\u00a0/g, ' ').trim().toLowerCase();
  if (!text) return false;
  if (['нет', 'false', '0', '0.0', '0,0'].includes(text)) return false;
  return true;
}

function buildRawRow(headers: unknown[], row: unknown[]): RawRow {
  return Object.fromEntries(
    headers.map((header, columnIndex) => {
      const key = normalizeStockProductName(header) || `__EMPTY_${columnIndex}`;
      return [key, row[columnIndex] ?? ''];
    }),
  );
}

function stockHeaderAliases(values: string[]) {
  return values.map(normalizeHeader);
}

function isStockHeaderValues(headers: unknown[]) {
  const normalized = headers.map(normalizeHeader);
  return (
    stockHeaderAliases(HEADER_ARTICLE_ALIASES).some((header) => normalized.includes(header)) &&
    stockHeaderAliases(HEADER_STOCK_ALIASES).some((header) => normalized.includes(header))
  );
}

function buildStockHeaders(row: unknown[], previousRow?: unknown[]) {
  return row.map((cell, columnIndex) => {
    const current = normalizeStockProductName(cell);
    const parent = normalizeStockProductName(previousRow?.[columnIndex]);
    const currentHeader = normalizeHeader(current);
    const parentHeader = normalizeHeader(parent);
    if (currentHeader === 'доступно' && ['сейчас', 'ожидается'].includes(parentHeader)) return `${parent} ${current}`;
    return current || parent;
  });
}

function detectStockLocationMarker(row: unknown[]): StockLocationKey | null {
  const cells = row.map(normalizeHeader).filter(Boolean);
  if (cells.some((cell) => cell.includes('1основной') && cell.includes('волжск'))) return 'volzhsk';
  if (cells.some((cell) => /^лдм\s*2$/.test(cell))) return 'moscow';
  if (cells.some((cell) => cell.includes('резервы ктс'))) return 'volzhsk';
  return null;
}

function isLegacyStockHeaderRow(row: unknown[]) {
  const normalized = row.map(normalizeHeader);
  const aliases = (values: string[]) => values.map(normalizeHeader);
  return (
    aliases(HEADER_ARTICLE_ALIASES).some((header) => normalized.includes(header)) &&
    aliases(HEADER_STOCK_ALIASES).some((header) => normalized.includes(header))
  );
}

export function parseStockWorkbook(buffer: Buffer): ParsedStockRow[] {
  if (buffer.byteLength > MAX_STOCK_WORKBOOK_BYTES) throw new Error('Excel-файл с остатками слишком большой');
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, sheetRows: MAX_STOCK_WORKBOOK_ROWS + 5 });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('В Excel-файле нет листов');
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
  if (rows.length > MAX_STOCK_WORKBOOK_ROWS) throw new Error('Excel-файл с остатками слишком большой');
  const parsedRows: ParsedStockRow[] = [];
  let headers: string[] | null = null;
  let currentLocation: StockLocationKey | null = null;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const locationMarker = detectStockLocationMarker(row);
    if (locationMarker) {
      currentLocation = locationMarker;
      continue;
    }

    const headerCandidate = buildStockHeaders(row, rows[rowIndex - 1]);
    if (isStockHeaderValues(headerCandidate)) {
      headers = headerCandidate;
      continue;
    }

    if (!headers) continue;
    parsedRows.push({
      rowNumber: rowIndex + 1,
      row: buildRawRow(headers, row),
      location: currentLocation,
    });
  }

  if (parsedRows.length > 0) return parsedRows;

  const headerIndex = rows.findIndex(isLegacyStockHeaderRow);
  if (headerIndex === -1) {
    return XLSX.utils
      .sheet_to_json<RawRow>(sheet, { defval: null, raw: true })
      .map((row, index) => ({ rowNumber: index + 2, row, location: null }));
  }

  const legacyHeaders = rows[headerIndex] ?? [];
  return rows.slice(headerIndex + 1).map((row, index) => ({
    rowNumber: headerIndex + index + 2,
    row: buildRawRow(legacyHeaders, row),
    location: null,
  }));
}
