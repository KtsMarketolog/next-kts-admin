/** Synthetic acceptance only. Run via scripts/test-catalog-stock-locking-postgres.sh. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { CATALOG_STOCK_WRITE_LOCK } from '../src/shared/lib/db/catalogStockWrite';
import { ensureCatalogSchema } from '../src/entities/catalog/api/catalogDb';
import { createCatalogAdminProduct, replaceCatalogFromRows } from '../src/entities/catalog/api/catalogAdmin/core';
import { CatalogExistingArticleConflictError } from '../src/entities/catalog/api/catalogAdmin/importMatching';
import { parseCatalogExcel } from '../src/entities/catalog/api/catalogExcel';
import { importStockFromExcelBuffer } from '../src/entities/catalog/api/stockImport';
import type { CatalogProductInput } from '../src/entities/catalog/api/catalogAdmin/types';

function guard() {
  assert.equal(process.env.KTS_CATALOG_STOCK_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_catalog_stock_integration'); assert.equal(url.username, 'catalog_app');
  assert.equal(url.password, '');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['host', 'port']);
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-catalog-stock-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55481');
}
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
function input(article: string, overrides: Partial<CatalogProductInput> = {}): CatalogProductInput {
  return { article, title: `Synthetic ${article}`, category: 'Synthetic duplicate test category', subcategory: 'Synthetic subgroup',
    brand: 'Synthetic brand', priceGroup: 'Synthetic price group', priceRub: '200', ...overrides };
}
function workbook(matrix: unknown[][]) {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(matrix), 'Synthetic');
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
}
const snapshotTables = ['catalog_products', 'catalog_categories', 'catalog_subcategories', 'catalog_brands',
  'catalog_category_subcategories', 'catalog_brand_categories', 'catalog_brand_subcategories',
  'wholesale_products', 'wholesale_categories', 'wholesale_price_lists', 'wholesale_price_list_items',
  'wholesale_price_list_group_stock_settings', 'stock_import_logs', 'stock_import_mail_receipts'] as const;
async function snapshot(client?: PoolClient) {
  const result: Record<string, unknown[]> = {};
  for (const table of snapshotTables) {
    const sql = `select row_to_json(t) as row from ${table} t order by row_to_json(t)::text`;
    result[table] = (client ? await client.query(sql) : await query(sql)).rows.map(({ row }) => row);
  }
  return result;
}
async function fixture() {
  // Only these synthetic tables inside the guarded disposable database are reset.
  await query('delete from wholesale_price_lists');
  await query('delete from wholesale_products');
  await query('delete from catalog_products');
  const first = await createCatalogAdminProduct(input('SYN-A', { stock: 13 }));
  const second = await createCatalogAdminProduct(input('SYN-B', { stock: 17 }));
  assert.ok(first && second);
  const priceId = (await query(`insert into wholesale_price_lists(title,token,comment,show_stock,show_stock_text)
    values('Preserved synthetic price',$1,'Do not lose this comment',false,true) returning id`, [randomUUID()])).rows[0].id;
  await query(`insert into wholesale_price_list_items(price_list_id,wholesale_product_id,custom_wholesale_price,
    discount_percent,price_manually_changed,visible,sort_order,snapshot_product_title)
    select $1,id,123.45,7.5,true,true,id::integer,'Preserved title' from wholesale_products`, [priceId]);
  await query(`insert into wholesale_price_list_group_stock_settings(price_list_id,price_group,show_stock_numbers,show_stock_text)
    values($1,'Synthetic price group',true,false)`, [priceId]);
  await query(`update catalog_products set stock_volzhsk=3,stock_moscow=stock-3,is_expected=true,stock_updated_at='2026-01-01T00:00:00Z'`);
  await query(`update wholesale_products set stock_volzhsk=3,stock_moscow=stock-3,is_expected=true,stock_updated_at='2026-01-01T00:00:00Z'`);
  return { first, second, priceId };
}

test('catalog duplicate import preserves real PostgreSQL data and price settings', { timeout: 120_000 }, async t => {
  guard();
  try {
    await ensureCatalogSchema(); await ensureSiteSchema();
    await importStockFromExcelBuffer({ buffer: workbook([['Артикул', 'Сейчас'], ['SYN-WARMUP-MISSING', 0]]), fileName: 'Synthetic-warmup.xlsx' });

    await t.test('invalid Excel with duplicates changes no catalog, wholesale, stock, price positions or settings', async () => {
      await fixture(); const before = await snapshot();
      const file = workbook([['Артикул', 'Наименование', 'Бренд', 'Цена RUB'],
        ['SYN-A', 'Changed first product', 'Changed brand', 999],
        ['SYN-B', 'Changed second product', 'Changed brand', 999],
        [' syn-a ', 'Duplicate near end', 'Another brand', 888]]);
      await assert.rejects(async () => replaceCatalogFromRows(parseCatalogExcel(file)), code('CATALOG_DUPLICATE_ARTICLES'));
      assert.deepEqual(await snapshot(), before);
      // Repository validation also protects callers that bypass the Excel parser.
      await assert.rejects(replaceCatalogFromRows([input('SYN-A'), input('SYN-B'), input('syn-a')]), code('CATALOG_DUPLICATE_ARTICLES'));
      assert.deepEqual(await snapshot(), before);
    });

    await t.test('persisted-normalization collisions reject before any write, including truncation and whitespace', async () => {
      await fixture(); const before = await snapshot();
      for (const articles of [['SYN  CODE', ' syn\tcode '], ['SYN\u00a0CODE', 'SYN CODE'],
        [`${'x'.repeat(120)}A`, `${'x'.repeat(120)}B`]]) {
        await assert.rejects(replaceCatalogFromRows([input('SYN-A'), ...articles.map(article => input(article))]), code('CATALOG_DUPLICATE_ARTICLES'));
        assert.deepEqual(await snapshot(), before);
      }
    });

    await t.test('unique reimport retains product and wholesale IDs and every saved price override and stock value', async () => {
      const { first, second } = await fixture(); const before = await snapshot();
      const identities = (await query('select id,catalog_product_id from wholesale_products order by id')).rows;
      const stocks = async () => (await query(`select id,stock,stock_volzhsk,stock_moscow,is_expected,stock_updated_at
        from catalog_products order by id`)).rows;
      const originalStocks = await stocks();
      const file = workbook([['Артикул', 'Наименование', 'Бренд', 'Цена RUB'],
        ['SYN-B', 'Updated second product', 'Synthetic updated brand', 210],
        ['SYN-A', 'Updated first product', 'Synthetic updated brand', 220]]);
      const result = await replaceCatalogFromRows(parseCatalogExcel(file));
      assert.equal(result.importedProducts, 2);
      const after = await snapshot();
      assert.deepEqual((await query('select id,catalog_product_id from wholesale_products order by id')).rows, identities);
      assert.deepEqual((await query('select id::integer from catalog_products order by id')).rows.map(row => row.id), [first.id, second.id]);
      for (const table of ['wholesale_price_list_items', 'wholesale_price_list_group_stock_settings', 'wholesale_price_lists'] as const) assert.deepEqual(after[table], before[table]);
      assert.deepEqual(await stocks(), originalStocks);
      assert.deepEqual((await query('select stock,stock_volzhsk,stock_moscow,is_expected,stock_updated_at from wholesale_products order by id')).rows,
        originalStocks.map(({ stock, stock_volzhsk, stock_moscow, is_expected, stock_updated_at }) =>
          ({ stock, stock_volzhsk, stock_moscow, is_expected, stock_updated_at })));
      assert.deepEqual(after.stock_import_logs, before.stock_import_logs);
      assert.equal((await query('select price_rub::text from catalog_products where id=$1', [first.id])).rows[0].price_rub, '220.00');
    });

    for (const inactive of [false, true]) await t.test(`existing ${inactive ? 'inactive' : 'active'} duplicate rejects before updating the valid prefix`, async () => {
      const { second } = await fixture();
      const duplicate = await createCatalogAdminProduct(input('syn-b', { brand: 'Different brand', isActive: !inactive, stock: 98 }));
      assert.ok(duplicate); const before = await snapshot();
      await assert.rejects(replaceCatalogFromRows([input('SYN-A', { title: 'Do not write prefix', priceRub: '777' }), input('SYN-B')]), (error: unknown) => {
        assert.ok(error instanceof CatalogExistingArticleConflictError);
        assert.equal(error.duplicateCount, 1);
        assert.equal(error.duplicates[0].article, 'SYN-B');
        assert.deepEqual([...error.duplicates[0].productIds].sort((a, b) => a - b), [second.id, duplicate.id]);
        return true;
      });
      assert.deepEqual(await snapshot(), before);
    });

    await t.test('multiple wholesale links do not masquerade as multiple catalog products', async () => {
      const { first } = await fixture();
      await query(`insert into wholesale_products(catalog_product_id,title,sku,sort_order,stock)
        values($1,'Synthetic second legacy wholesale link','SYN-A',100,13)`, [first.id]);
      const beforeIds = (await query('select id,catalog_product_id from wholesale_products order by id')).rows;
      const beforePrices = (await snapshot()).wholesale_price_list_items;
      await replaceCatalogFromRows([input('SYN-A'), input('SYN-B')]);
      assert.deepEqual((await query('select id,catalog_product_id from wholesale_products order by id')).rows, beforeIds);
      assert.deepEqual((await snapshot()).wholesale_price_list_items, beforePrices);
      assert.equal((await query('select count(*)::integer as n from catalog_products')).rows[0].n, 2);
    });

    await t.test('a legacy product with empty article and matching title is not overwritten by a new SKU', async () => {
      await fixture();
      const legacy = await createCatalogAdminProduct(input('SYN-LEGACY', { title: 'NEW-SKU', stock: 44 }));
      assert.ok(legacy);
      await query("update catalog_products set article='' where id=$1", [legacy.id]);
      await replaceCatalogFromRows([input('SYN-A'), input('SYN-B'), input('NEW-SKU', { title: 'Actual new product' })]);
      const old = (await query('select article,title,stock,is_active from catalog_products where id=$1', [legacy.id])).rows[0];
      assert.deepEqual(old, { article: '', title: 'NEW-SKU', stock: 44, is_active: false });
      const created = (await query("select id,title from catalog_products where article='NEW-SKU'")).rows[0];
      assert.ok(created); assert.notEqual(Number(created.id), legacy.id); assert.equal(created.title, 'Actual new product');
      assert.equal((await query('select count(*)::integer as n from wholesale_products where catalog_product_id=$1', [legacy.id])).rows[0].n, 1);
    });

    await t.test('ambiguity introduced by another writer is detected after the common lock, before mutation', async () => {
      await fixture();
      let ready!: () => void, release!: () => void;
      const locked = new Promise<void>(resolve => { ready = resolve; }), proceed = new Promise<void>(resolve => { release = resolve; });
      let expected: Awaited<ReturnType<typeof snapshot>> | undefined;
      const writer = withTransaction(async client => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [CATALOG_STOCK_WRITE_LOCK]);
        await client.query(`insert into catalog_products(slug,title,article,is_active) values($1,'Synthetic concurrent duplicate','SYN-B',false)`, [randomUUID()]);
        expected = await snapshot(client); ready(); await proceed;
      });
      await locked;
      const pending = assert.rejects(replaceCatalogFromRows([input('SYN-A', { priceRub: '999' }), input('SYN-B')]), code('CATALOG_EXISTING_DUPLICATE_ARTICLES'));
      try {
        const deadline = Date.now() + 3000;
        let waiters = 0;
        while (Date.now() < deadline) {
          waiters = Number((await query(`select count(*) as n from pg_locks where locktype='advisory'
            and objid=(hashtext($1)::bigint & 4294967295)::oid and not granted`, [CATALOG_STOCK_WRITE_LOCK])).rows[0].n);
          if (waiters > 0) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(waiters > 0, 'import must wait for the writer before matching existing identities');
      } finally { release(); }
      await writer; await pending;
      assert.deepEqual(await snapshot(), expected);
    });
  } finally { await globalThis.__ktsPgPool?.end(); globalThis.__ktsPgPool = undefined; }
});
