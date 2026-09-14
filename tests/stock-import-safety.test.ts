import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as XLSX from 'xlsx';

import type { StockImportResult } from '../src/entities/catalog/api/stockImportTypes';
import {
  HEADER_ARTICLE_ALIASES,
  HEADER_STOCK_ALIASES,
  parseCurrentStock,
  parseStockWorkbook,
  readRawCellByAliases,
} from '../src/entities/catalog/api/stockWorkbookParser';

function workbook(rows: unknown[][]) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Synthetic');
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
}

test('stock parser refuses missing or unknown quantity headers, including a later warehouse section', () => {
  for (const rows of [
    [['Артикул', 'Остаток всего'], ['SYNTHETIC', 123]],
    [['Артикул', 'Комментарий'], ['SYNTHETIC', '']],
    [['Наименование', 'Сейчас'], ['SYNTHETIC', 123]],
    [['1Основной склад Волжск'], ['Артикул', 'Сейчас'], ['SYNTHETIC', 5], ['ЛДМ 2'], ['Артикул', 'Остаток всего'], ['SYNTHETIC', 10]],
  ]) {
    assert.throws(() => parseStockWorkbook(workbook(rows)), /колонк.*остатков.*Остатки не изменены/);
  }
});

test('stock parser keeps recognized aliases and blank quantity cells as explicit zero stock', () => {
  for (const article of HEADER_ARTICLE_ALIASES) {
    for (const quantity of HEADER_STOCK_ALIASES) {
      const rows = parseStockWorkbook(workbook([[article, quantity], ['SYNTHETIC', '']]));
      assert.equal(rows.length, 1);
      assert.equal(parseCurrentStock(readRawCellByAliases(rows[0].row, HEADER_STOCK_ALIASES)), 0);
    }
  }
});

test('stock parser preserves two-level headers, warehouse markers and quantity values', () => {
  const rows = parseStockWorkbook(workbook([
    ['1Основной склад Волжск'],
    ['Номенклатура.Код', 'Сейчас', 'Ожидается'],
    ['', 'Доступно', 'Доступно'],
    ['SYNTHETIC', 7, 1],
    ['ЛДМ 2'],
    ['Артикул', 'Остатки'],
    ['SYNTHETIC', 3],
  ]));
  assert.deepEqual(rows.map(({ location, row }) => ({ location, stock: parseCurrentStock(readRawCellByAliases(row, HEADER_STOCK_ALIASES)) })), [
    { location: 'volzhsk', stock: 7 }, { location: 'moscow', stock: 3 },
  ]);
});

type StockState = { id: number; article: string; stock: number; volzhsk: number; moscow: number; expected: boolean; unit: string };
const originalStocks: StockState[] = [
  { id: 1, article: 'BAD-SKU', stock: 30, volzhsk: 10, moscow: 20, expected: true, unit: 'old-unit' },
  { id: 2, article: 'GOOD-SKU', stock: 90, volzhsk: 40, moscow: 50, expected: false, unit: 'шт.' },
];
const require = createRequire(import.meta.url);
let compiledImporter: Promise<string> | undefined;

async function importerWithSyntheticDatabase(stocks = originalStocks) {
  // Compile the real importer in memory. Every schema/DB dependency is replaced;
  // only xlsx may be loaded by the sandboxed module, so no mail/DB connection is possible.
  compiledImporter ??= build({
    entryPoints: [fileURLToPath(new URL('../src/entities/catalog/api/stockImport.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'silent',
    plugins: [{
      name: 'synthetic-stock-database',
      setup(builder) {
        builder.onResolve({ filter: /^(@\/shared\/lib\/db(?:\/client)?|\.\/catalogDb)$/ }, () => ({ path: 'synthetic-stock-database', external: true }));
      },
    }],
  }).then((result) => result.outputFiles[0].text);
  const catalog = new Map(stocks.map((stock) => [stock.id, { ...stock }]));
  const wholesale = new Map(stocks.map((stock) => [stock.id, { ...stock }]));
  const writes: number[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    assert.doesNotMatch(sql, /\b(?:delete\s+from|update|insert\s+into)\s+wholesale_price_lists\b/i, 'stock import must never change old price lists');
    if (sql.includes('select id::text') && sql.includes('from catalog_products')) {
      const rows = [...catalog.values()].filter(({ article }) => article.toLowerCase() === String(params[0]).toLowerCase()).map(({ id }) => ({ id: String(id) }));
      return { rowCount: rows.length, rows };
    }
    if (/^\s*update (catalog_products|wholesale_products)\s+set stock =/.test(sql)) {
      const target = sql.includes('update catalog_products') ? catalog : wholesale;
      const id = Number(params[0]);
      const current = target.get(id)!;
      target.set(id, { ...current, stock: Number(params[1]), volzhsk: Number(params[2]), moscow: Number(params[3]), expected: params[4] === true, unit: String(params[5] || current.unit) });
      if (target === catalog) writes.push(id);
    }
    return { rowCount: 1, rows: [{ id: '1' }] };
  };
  const database = {
    ensureSiteSchema: async () => {}, ensureCatalogSchema: async () => {}, query,
    tryAcquireSessionAdvisoryLock: async () => async () => {},
    withTransaction: async (callback: (client: { query: typeof query }) => Promise<unknown>) => callback({ query }),
  };
  const loaded = { exports: {} as { importStockFromExcelBuffer: (input: { buffer: Buffer; fileName: string }) => Promise<StockImportResult> } };
  new Function('require', 'module', 'exports', await compiledImporter)((name: string) => {
    if (name === 'synthetic-stock-database') return database;
    assert.equal(name, 'xlsx', 'unexpected dependency must not reach real infrastructure');
    return require(name);
  }, loaded, loaded.exports);
  return {
    catalog, wholesale, writes,
    run: (rows: unknown[][]) => loaded.exports.importStockFromExcelBuffer({ buffer: workbook(rows), fileName: 'Synthetic.xlsx' }),
  };
}

test('unknown quantity header rejects the real stock importer before any inventory update', async () => {
  const h = await importerWithSyntheticDatabase();
  await assert.rejects(h.run([['Артикул', 'Остаток всего'], ['BAD-SKU', 123]]), /Остатки не изменены/);
  assert.deepEqual(h.writes, []);
  assert.deepEqual([...h.catalog.values()], originalStocks);
  assert.deepEqual([...h.wholesale.values()], originalStocks);
});

for (const badFirst of [false, true]) {
  test(`invalid warehouse quantity preserves the whole SKU and permits other SKUs; invalid row ${badFirst ? 'first' : 'last'}`, async () => {
    const h = await importerWithSyntheticDatabase();
    const badSection: unknown[][] = [['ЛДМ 2'], ['Артикул', 'Сейчас'], [' bad-sku ', 'invalid'], ['GOOD-SKU', 2]];
    const goodSection: unknown[][] = [['1Основной склад Волжск'], ['Артикул', 'Сейчас'], ['BAD-SKU', 5], ['GOOD-SKU', 8]];
    const result = await h.run(badFirst ? [...badSection, ...goodSection] : [...goodSection, ...badSection]);
    assert.equal(result.status, 'partial_success');
    assert.equal(result.totalRows, 4);
    assert.equal(result.updatedRows, 1);
    assert.equal(result.failedRows, 1);
    assert.match(result.errors[0].error, /по этому артикулу не изменены/);
    assert.deepEqual(h.writes, [2]);
    assert.deepEqual(h.catalog.get(1), originalStocks[0]);
    assert.deepEqual(h.wholesale.get(1), originalStocks[0]);
    assert.deepEqual(h.catalog.get(2), { ...originalStocks[1], stock: 10, volzhsk: 8, moscow: 2 });
    assert.deepEqual(h.wholesale.get(2), h.catalog.get(2));
  });
}

test('an invalid SKU with no other valid SKU leaves every stock value unchanged', async () => {
  const h = await importerWithSyntheticDatabase();
  const result = await h.run([['Артикул', 'Сейчас'], ['BAD-SKU', 5], ['bad-sku', -1], ['BAD-SKU', 7]]);
  assert.equal(result.status, 'failed');
  assert.equal(result.updatedRows, 0);
  assert.equal(result.failedRows, 1);
  assert.deepEqual(h.writes, []);
  assert.deepEqual([...h.catalog.values()], originalStocks);
  assert.deepEqual([...h.wholesale.values()], originalStocks);
});

test('a recognized blank quantity still intentionally replaces prior stock with zero', async () => {
  const h = await importerWithSyntheticDatabase();
  const result = await h.run([['Артикул', 'Сейчас'], ['BAD-SKU', '']]);
  assert.equal(result.status, 'success');
  assert.equal(result.updatedRows, 1);
  assert.equal(h.catalog.get(1)?.stock, 0);
  assert.equal(h.wholesale.get(1)?.stock, 0);
});

test('ambiguous catalog SKU keeps all matching products unchanged', async () => {
  const stocks = [originalStocks[0], { ...originalStocks[1], article: 'bad-sku' }];
  const h = await importerWithSyntheticDatabase(stocks);
  const result = await h.run([['Артикул', 'Сейчас'], ['BAD-SKU', 5]]);
  assert.equal(result.status, 'failed');
  assert.equal(result.updatedRows, 0);
  assert.deepEqual(h.writes, []);
  assert.deepEqual([...h.catalog.values()], stocks);
  assert.deepEqual([...h.wholesale.values()], stocks);
});
