/** Synthetic acceptance only. Run via scripts/test-catalog-stock-locking-postgres.sh. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, type PoolClient } from 'pg';
import * as XLSX from 'xlsx';

import { query, withTransaction } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { CATALOG_STOCK_WRITE_LOCK, withCatalogStockWrite } from '../src/shared/lib/db/catalogStockWrite';
import { ensureCatalogSchema } from '../src/entities/catalog/api/catalogDb';
import { createCatalogAdminProduct, deleteCatalogAdminProduct, replaceCatalogFromRows, updateCatalogAdminProduct } from '../src/entities/catalog/api/catalogAdmin/core';
import type { CatalogProductInput } from '../src/entities/catalog/api/catalogAdmin/types';
import { importStockFromExcelBuffer } from '../src/entities/catalog/api/stockImport';
import { getPublicWholesalePriceListRevision, getPublicWholesaleRequestItems } from '../src/shared/lib/db/wholesaleRepo';

function guard() {
  assert.equal(process.env.KTS_CATALOG_STOCK_TEST, '1', 'Explicit isolated integration flag is required');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_catalog_stock_integration');
  assert.equal(url.username, 'catalog_app');
  assert.equal(url.password, '', 'No application credentials permitted');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-catalog-stock-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55481');
}

function input(article: string, overrides: Partial<CatalogProductInput> = {}): CatalogProductInput {
  return { title: `Synthetic ${article}`, article, category: 'Synthetic category', subcategory: 'Synthetic subcategory', brand: 'Synthetic brand', priceRub: '200', priceEur: '20', ...overrides };
}

function stockBuffer(rows: [string, number][]) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Артикул', 'Сейчас'], ...rows]), 'Synthetic');
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
}

function stock(rows: [string, number][], suffix = 'regular', mailReceiptKeys?: string[]) {
  return importStockFromExcelBuffer({ buffer: stockBuffer(rows), fileName: `Synthetic-${suffix}.xlsx`, mailReceiptKeys });
}

function warehouseStockBuffer(article: string, sparse: boolean) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['ЛДМ 2'], ['Артикул', 'Сейчас', 'Ед. изм.', 'Ожидается'], [article, 3, 'шт.', 0],
  ]);
  XLSX.utils.sheet_add_aoa(sheet, [
    ['1Основной склад Волжск'], ['Артикул', 'Сейчас', 'Ед. изм.', 'Ожидается'], [article, 8, 'шт.', 0],
  ], { origin: sparse ? 'A60001' : 'A4' });
  XLSX.utils.book_append_sheet(book, sheet, 'Synthetic');
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }));
}

async function stockImportSnapshot() {
  const tables = ['catalog_products', 'wholesale_products', 'wholesale_price_lists', 'wholesale_price_list_items',
    'wholesale_price_list_group_stock_settings', 'site_settings', 'stock_import_logs', 'stock_import_mail_receipts'] as const;
  return Object.fromEntries(await Promise.all(tables.map(async (table) => [table,
    (await query<{ row: Record<string, unknown> }>(`select row_to_json(t) as row from ${table} t order by row_to_json(t)::text`)).rows.map(({ row }) => row),
  ] as const)));
}

async function connected<T>(run: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'synthetic-catalog-stock-test' });
  await client.connect();
  try { return await run(client); }
  finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}

function settle<T>(promise: Promise<T>) {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

function success<T>(outcome: Awaited<ReturnType<typeof settle<T>>>) {
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

async function until(check: () => Promise<boolean>, description: string, duration = 5_000) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Did not observe ${description}`);
}

async function gateWaiters(gate: number) {
  return Number((await query<{ count: string }>(`select count(*) from pg_locks where locktype='advisory' and objid=$1::oid and not granted`, [gate])).rows[0].count);
}

async function writerWaiters() {
  return Number((await query<{ count: string }>(`select count(*) from pg_locks where locktype='advisory'
    and objid=(hashtext($1)::bigint & 4294967295)::oid and not granted`, [CATALOG_STOCK_WRITE_LOCK])).rows[0].count);
}

async function prices() {
  return (await query(`select row_to_json(t) as row from wholesale_price_list_items t order by id`)).rows.map(({ row }) => row);
}

async function productRows() {
  return (await query(`select c.id::integer,c.article,c.title,c.stock,c.price_rub::text,
    w.id::integer as wholesale_id,w.title as wholesale_title,w.stock as wholesale_stock,
    w.price_rub::text as wholesale_price_rub,w.is_active as wholesale_active
    from catalog_products c join wholesale_products w on w.catalog_product_id=c.id order by c.id`)).rows;
}

async function fixture(prefix: string) {
  // Explicit synthetic membership reset; only the isolated guarded database is used.
  await query('delete from wholesale_price_list_items');
  await query('delete from wholesale_price_lists');
  await query('delete from wholesale_products');
  await query('delete from catalog_products');
  const first = await createCatalogAdminProduct(input(`${prefix}-A`, { stock: 3 }));
  const second = await createCatalogAdminProduct(input(`${prefix}-B`, { stock: 4 }));
  assert.ok(first && second);
  const priceId = (await query(`insert into wholesale_price_lists(title,token,comment) values ('Preserved synthetic price',$1,'Preserved comment') returning id`, [`synthetic-${prefix}`])).rows[0].id;
  await query(`insert into wholesale_price_list_items(price_list_id,wholesale_product_id,custom_wholesale_price,discount_percent,price_manually_changed,visible,sort_order)
    select $1,p.id,123.45,7.5,true,true,p.id::integer from wholesale_products p order by p.id`, [priceId]);
  return { first, second, originalPrices: await prices() };
}

async function installGate(event: 'insert' | 'update' | 'delete', gate: number) {
  await query(`create function synthetic_catalog_gate() returns trigger language plpgsql as $$
    begin perform pg_advisory_xact_lock(${gate}); return null; end $$`);
  await query(`create trigger synthetic_catalog_gate before ${event} on catalog_products for each statement execute function synthetic_catalog_gate()`);
}

async function removeGate() {
  await query('drop trigger if exists synthetic_catalog_gate on catalog_products');
  await query('drop function if exists synthetic_catalog_gate()');
}

test('catalog/stock writes and transaction policy in isolated PostgreSQL', { timeout: 120_000 }, async (t) => {
  guard();
  try {
    assert.equal((await query(`select to_regclass('public.catalog_products')::text as present`)).rows[0].present, null, 'Refuse pre-existing application schema');
    await ensureCatalogSchema();
    await ensureSiteSchema();
    assert.deepEqual((await query('select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user')).rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    // Complete actual import schema initialization before introducing lock gates.
    await stock([['SYNTHETIC-WARMUP-NOT-FOUND', 0]], 'warmup');

    await t.test('catalog disappearance and return preserve each manager visibility choice and every saved price setting', async () => {
      const prefix = 'catalog-return';
      const { first, second } = await fixture(prefix);
      const retained = await createCatalogAdminProduct(input(`${prefix}-RETAINED`));
      assert.ok(retained);
      const firstToken = `synthetic-${prefix}`;
      const secondToken = `synthetic-${prefix}-other-manager`;
      await query(`update wholesale_price_list_items i set visible=false,price_manually_changed=false,
        custom_wholesale_price=null,discount_percent=17.5
        from wholesale_products p where p.id=i.wholesale_product_id and p.catalog_product_id=$1`, [second.id]);
      const otherPriceId = (await query(`insert into wholesale_price_lists(title,token,comment)
        values ('Other synthetic manager price',$1,'Preserved independent manager choice') returning id`, [secondToken])).rows[0].id;
      await query(`insert into wholesale_price_list_items(price_list_id,wholesale_product_id,custom_wholesale_price,
        discount_percent,price_manually_changed,visible,sort_order,snapshot_product_title)
        select $1,p.id,987.65,12.5,true,p.catalog_product_id=$3,45,'Preserved manager title'
        from wholesale_products p where p.catalog_product_id=any($2::bigint[])`, [otherPriceId, [first.id, second.id], second.id]);

      const initialImport = [input(first.article), input(second.article), input(retained.article)];
      await replaceCatalogFromRows(initialImport);
      const beforeItems = await prices();
      const beforeLists = (await query(`select row_to_json(p) as row,p.xmin::text as version
        from wholesale_price_lists p order by id`)).rows;
      const beforeIdentities = (await query(`select c.id::integer as catalog_id,w.id::integer as wholesale_id,
        c.article from catalog_products c join wholesale_products w on w.catalog_product_id=c.id order by c.id`)).rows;
      const itemIds = (await query<{ id: number }>('select id::integer from wholesale_price_list_items order by id')).rows.map(({ id }) => id);
      const beforePublic = await Promise.all([firstToken, secondToken].map(token => getPublicWholesaleRequestItems(token, itemIds)));
      assert.deepEqual(beforePublic.map(items => items.map(({ sku, priceRub }) => ({ sku, priceRub }))), [
        [{ sku: first.article, priceRub: '123.45' }], [{ sku: second.article, priceRub: '987.65' }],
      ]);
      const beforeCacheRevisions = await Promise.all([firstToken, secondToken].map(getPublicWholesalePriceListRevision));
      assert.ok(beforeCacheRevisions.every(Boolean));

      await replaceCatalogFromRows([input(retained.article)]);
      for (const table of ['catalog_products', 'wholesale_products'] as const) {
        const key = table === 'catalog_products' ? 'id' : 'catalog_product_id';
        assert.deepEqual((await query(`select is_active from ${table} where ${key}=any($1::bigint[]) order by id`,
          [[first.id, second.id]])).rows, [{ is_active: false }, { is_active: false }]);
      }
      assert.deepEqual(await prices(), beforeItems, 'Temporary catalog absence must not change manager choices, prices, discounts, snapshots, positions or timestamps');
      assert.deepEqual((await query(`select row_to_json(p) as row,p.xmin::text as version
        from wholesale_price_lists p order by id`)).rows, beforeLists, 'Import must not alter or increment manager price-list revisions');
      assert.deepEqual(await Promise.all([firstToken, secondToken].map(token => getPublicWholesaleRequestItems(token, itemIds))), [[], []],
        'Inactive products must not remain orderable even when their saved selection is enabled');
      const absentCacheRevisions = await Promise.all([firstToken, secondToken].map(getPublicWholesalePriceListRevision));
      absentCacheRevisions.forEach((revision, index) => assert.notEqual(revision, beforeCacheRevisions[index], 'Product activity must invalidate public price cache'));

      await replaceCatalogFromRows([input(first.article, { priceRub: '333' }), input(second.article, { priceRub: '444' }), input(retained.article)]);
      for (const table of ['catalog_products', 'wholesale_products'] as const) {
        const key = table === 'catalog_products' ? 'id' : 'catalog_product_id';
        assert.deepEqual((await query(`select is_active from ${table} where ${key}=any($1::bigint[]) order by id`,
          [[first.id, second.id]])).rows, [{ is_active: true }, { is_active: true }]);
      }
      assert.deepEqual((await query(`select c.id::integer as catalog_id,w.id::integer as wholesale_id,
        c.article from catalog_products c join wholesale_products w on w.catalog_product_id=c.id order by c.id`)).rows, beforeIdentities,
        'Returning products must reconnect to the original saved positions, not become duplicate product records');
      assert.deepEqual(await prices(), beforeItems);
      assert.deepEqual((await query(`select row_to_json(p) as row,p.xmin::text as version
        from wholesale_price_lists p order by id`)).rows, beforeLists);
      assert.deepEqual(await Promise.all([firstToken, secondToken].map(token => getPublicWholesaleRequestItems(token, itemIds))), beforePublic,
        'Only each manager-selected product must return automatically, retaining individual prices despite changed catalog prices');
      const restoredCacheRevisions = await Promise.all([firstToken, secondToken].map(getPublicWholesalePriceListRevision));
      restoredCacheRevisions.forEach((revision, index) => assert.notEqual(revision, absentCacheRevisions[index], 'Reactivation must invalidate absent-state cache'));
    });

    await t.test('a small sparse workbook cannot commit a truncated warehouse snapshot or success receipt', async () => {
      const { first, second, originalPrices } = await fixture('sparse-stock');
      for (const table of ['catalog_products', 'wholesale_products'] as const) {
        await query(`update ${table} set stock=30,stock_moscow=20,stock_volzhsk=10,is_expected=true,
          unit='Preserved unit',stock_updated_at='2026-01-01T00:00:00Z',updated_at='2026-01-01T00:00:00Z'`);
      }
      await query(`update wholesale_price_lists set show_stock=false,show_stock_text=true`);
      await query(`insert into wholesale_price_list_group_stock_settings(price_list_id,price_group,show_stock_numbers,show_stock_text)
        select id,'Synthetic preserved group',true,false from wholesale_price_lists`);
      await query(`insert into site_settings(key,value,updated_at)
        values('synthetic-stock-regression','Preserved setting','2026-01-01T00:00:00Z')`);
      const before = await stockImportSnapshot();
      assert.equal(before.catalog_products.filter(({ id }) => id === second.id).length, 1);
      assert.equal(before.wholesale_products.filter(({ catalog_product_id }) => catalog_product_id === second.id).length, 1);
      const receiptKey = 'synthetic-sparse-stock-receipt';
      const buffer = warehouseStockBuffer(first.article, true);
      assert.ok(buffer.byteLength < 15 * 1024, 'Sparse workbook must be small enough to bypass the byte-size guard');
      const limitedSheet = XLSX.read(buffer, { type: 'buffer', sheetRows: 50_005 }).Sheets.Synthetic;
      assert.equal(limitedSheet['!fullref'], 'A1:D60003', 'The late warehouse must actually lie beyond the SheetJS read cap');
      assert.equal(limitedSheet['!ref'], 'A1:D3', 'The retained prefix alone appears to be an ordinary small sheet');

      await assert.rejects(importStockFromExcelBuffer({
        buffer, fileName: 'Synthetic-sparse-stock.xlsx', mailReceiptKeys: [receiptKey],
      }), /обрезан при чтении.*Остатки не изменены/);
      assert.deepEqual(await stockImportSnapshot(), before,
        'Rejected truncation must preserve both SKUs, all stock and row timestamps, saved prices and settings, logs and receipts');

      const result = await importStockFromExcelBuffer({
        buffer: warehouseStockBuffer(first.article, false), fileName: 'Synthetic-repaired-stock.xlsx', mailReceiptKeys: [receiptKey],
      });
      assert.equal(result.status, 'success');
      assert.equal(result.saved, true);
      assert.equal(result.totalRows, 2);
      assert.equal(result.updatedRows, 1);
      assert.equal(result.notFoundRows, 0);
      assert.equal(result.failedRows, 0);
      assert.deepEqual(result.errors, []);
      assert.notEqual(result.alreadyApplied, true, 'Rejected file must not consume the receipt for a repaired import');
      for (const table of ['catalog_products', 'wholesale_products'] as const) {
        const productKey = table === 'catalog_products' ? 'id' : 'catalog_product_id';
        const row = (await query(`select stock,stock_moscow,stock_volzhsk,is_expected,unit,stock_updated_at,updated_at
          from ${table} where ${productKey}=$1`, [first.id])).rows[0];
        assert.deepEqual([row.stock, row.stock_moscow, row.stock_volzhsk, row.is_expected, row.unit], [11, 3, 8, false, 'шт.']);
        assert.ok(row.stock_updated_at > new Date('2026-01-01T00:00:00Z'));
        assert.ok(row.updated_at > new Date('2026-01-01T00:00:00Z'));
      }
      const after = await stockImportSnapshot();
      assert.deepEqual(after.catalog_products.filter(({ id }) => id === second.id), before.catalog_products.filter(({ id }) => id === second.id));
      assert.deepEqual(after.wholesale_products.filter(({ catalog_product_id }) => catalog_product_id === second.id),
        before.wholesale_products.filter(({ catalog_product_id }) => catalog_product_id === second.id));
      for (const table of ['wholesale_price_lists', 'wholesale_price_list_items', 'wholesale_price_list_group_stock_settings', 'site_settings']) {
        assert.deepEqual(after[table], before[table], `Successful stock import must preserve ${table}`);
      }
      assert.deepEqual(await prices(), originalPrices);
      assert.equal(after.stock_import_logs.length, before.stock_import_logs.length + 1);
      assert.equal(after.stock_import_mail_receipts.length, before.stock_import_mail_receipts.length + 1);
      assert.deepEqual((await query('select status from stock_import_logs where id=$1', [result.logId])).rows, [{ status: 'success' }]);
      assert.equal((await query('select log_id::integer as log_id from stock_import_mail_receipts where receipt_key=$1', [receiptKey])).rows[0].log_id, result.logId);
    });

    for (const operation of ['edit', 'create', 'delete', 'replace'] as const) {
      await t.test(`${operation}: catalog-first and stock-second serialize, preserving every saved price position`, async () => {
        const { first, second, originalPrices } = await fixture(operation);
        const gate = 774_410;
        const event = operation === 'create' ? 'insert' : operation === 'delete' ? 'delete' : 'update';
        await installGate(event, gate);
        try {
          await connected(async (owner) => {
            await owner.query('begin');
            await owner.query('select pg_advisory_xact_lock($1)', [gate]);
            const action = settle<unknown>(operation === 'edit'
              ? updateCatalogAdminProduct(first.id, input(first.article, { title: 'Synthetic edited title', priceRub: '333' }))
              : operation === 'create'
                ? createCatalogAdminProduct(input(`${operation}-NEW`))
                : operation === 'delete'
                  ? deleteCatalogAdminProduct(first.id)
                  : replaceCatalogFromRows([input(first.article, { priceRub: '444' }), input(second.article)]));
            await until(async () => (await gateWaiters(gate)) === 1, 'catalog writer inside its first mutation');
            const imported = settle(stock([[first.article, 55], [second.article, 66]], operation));
            await until(async () => (await writerWaiters()) === 1, 'stock import queued before touching product rows');
            assert.deepEqual(await prices(), originalPrices, 'Public reads remain available, saved overrides remain untouched');
            await owner.query('commit');
            success(await action);
            const result = success(await imported);
            assert.equal(result.updatedRows, operation === 'delete' ? 1 : 2);
            assert.equal(result.notFoundRows, operation === 'delete' ? 1 : 0);
          });
          const rows = await productRows();
          const row = rows.find((item) => item.id === first.id);
          if (operation === 'delete') {
            assert.equal(row, undefined);
            assert.equal((await query('select is_active from wholesale_products where catalog_product_id=$1', [first.id])).rows[0].is_active, false);
          } else {
            assert.equal(row?.stock, 55);
            assert.equal(row?.wholesale_stock, 55);
            if (operation === 'edit') {
              assert.equal(row?.title, 'Synthetic edited title');
              assert.equal(row?.wholesale_title, 'Synthetic edited title');
              assert.equal(row?.price_rub, '333.00');
              assert.equal(row?.wholesale_price_rub, '333.00');
            }
            if (operation === 'replace') assert.equal(row?.price_rub, '444.00');
          }
          assert.equal(rows.find((item) => item.id === second.id)?.stock, 66);
          assert.deepEqual(await prices(), originalPrices, 'No saved price, visibility, timestamp or position changed');
        } finally { await removeGate(); }
      });
    }

    await t.test('stock-first and delete-second no longer take wholesale/catalog row locks in opposite order', async () => {
      const { first, second, originalPrices } = await fixture('stock-first');
      const gate = 774_411;
      await installGate('update', gate);
      try {
        await connected(async (owner) => {
          await owner.query('begin');
          await owner.query('select pg_advisory_xact_lock($1)', [gate]);
          const imported = settle(stock([[first.article, 90], [second.article, 91]], 'stock-first'));
          await until(async () => (await gateWaiters(gate)) === 1, 'stock writer inside catalogue update');
          const deleted = settle(deleteCatalogAdminProduct(first.id));
          await until(async () => (await writerWaiters()) === 1, 'delete waits before wholesale mutation');
          await connected(async (reader) => {
            await reader.query('begin');
            await reader.query('select id from wholesale_products where catalog_product_id=$1 for update nowait', [first.id]);
            await reader.query('rollback');
          });
          await owner.query('commit');
          assert.equal(success(await imported).updatedRows, 2);
          success(await deleted);
        });
        assert.deepEqual(await prices(), originalPrices);
        const remaining = await productRows();
        assert.equal(remaining.length, 1);
        assert.equal(remaining[0].stock, 91);
        assert.equal(remaining[0].wholesale_stock, 91);
      } finally { await removeGate(); }
    });

    await t.test('a real stock deadlock retries the whole transaction without duplicate counters, errors, log or mail receipt', async () => {
      const { first, second, originalPrices } = await fixture('retry');
      const gate = 774_412;
      await query('create sequence synthetic_stock_attempts');
      await query(`create function synthetic_stock_deadlock() returns trigger language plpgsql as $$ begin
        if new.id=${first.id} and new.stock=76 then perform nextval('synthetic_stock_attempts'); end if;
        if new.id=${second.id} and new.stock=77 then perform pg_advisory_xact_lock(${gate}); end if;
        return new; end $$`);
      await query('create trigger synthetic_stock_deadlock before update on catalog_products for each row execute function synthetic_stock_deadlock()');
      const beforeLogs = Number((await query('select count(*) as count from stock_import_logs')).rows[0].count);
      try {
        await connected(async (outsider) => {
          await outsider.query('select pg_advisory_lock($1)', [gate]);
          const imported = settle(stock([['SYNTHETIC-MISSING', 1], [first.article, 76], [second.article, 77]], 'deadlock-retry', ['synthetic-receipt-1']));
          await until(async () => (await gateWaiters(gate)) === 1, 'stock holds first row and waits for external advisory gate');
          // The importer started waiting first, so PostgreSQL's detector aborts
          // that transaction. This write completes only after the import rolls back.
          await outsider.query('update catalog_products set model=$2 where id=$1', [first.id, 'Synthetic outside edit']);
          await outsider.query('select pg_advisory_unlock($1)', [gate]);
          const result = success(await imported);
          assert.equal(result.totalRows, 3);
          assert.equal(result.updatedRows, 2);
          assert.equal(result.notFoundRows, 1);
          assert.equal(result.failedRows, 0);
          assert.equal(result.errors.length, 1);
          assert.equal(result.status, 'partial_success');
          assert.equal(Number((await query('select last_value from synthetic_stock_attempts')).rows[0].last_value), 2, 'The real importer callback must execute twice');
          assert.equal(Number((await query('select count(*) as count from stock_import_logs')).rows[0].count), beforeLogs + 1);
          assert.equal(Number((await query('select count(*) as count from stock_import_mail_receipts where receipt_key=$1', ['synthetic-receipt-1'])).rows[0].count), 1);
          const duplicate = await stock([[first.article, 999]], 'receipt-replay', ['synthetic-receipt-1']);
          assert.equal(duplicate.alreadyApplied, true);
          assert.equal(duplicate.logId, result.logId);
          assert.equal(Number((await query('select count(*) as count from stock_import_logs')).rows[0].count), beforeLogs + 1);
        });
        const rows = await productRows();
        assert.deepEqual(rows.map(({ stock, wholesale_stock }) => [stock, wholesale_stock]), [[76, 76], [77, 77]]);
        assert.equal((await query('select model from catalog_products where id=$1', [first.id])).rows[0].model, 'Synthetic outside edit');
        assert.deepEqual(await prices(), originalPrices);
      } finally {
        await query('drop trigger synthetic_stock_deadlock on catalog_products');
        await query('drop function synthetic_stock_deadlock()');
        await query('drop sequence synthetic_stock_attempts');
      }
    });

    await t.test('transaction profiles set SQL deadlines locally and permit isolation selection before reads', async () => {
      const expectations = { interactive: ['30s', '5s', '30s'], import: ['3min', '15s', '1min'] } as const;
      for (const profile of ['interactive', 'import'] as const) {
        await withTransaction(async (client) => {
          await client.query('set transaction isolation level serializable');
          const result = await client.query(`select current_setting('statement_timeout') as statement,
            current_setting('lock_timeout') as lock,current_setting('idle_in_transaction_session_timeout') as idle`);
          assert.deepEqual(Object.values(result.rows[0]), expectations[profile]);
        }, { profile });
      }
      const result = await query(`select current_setting('statement_timeout') as statement,current_setting('lock_timeout') as lock`);
      assert.deepEqual(result.rows[0], { statement: '1min', lock: '10s' }, 'SET LOCAL does not leak the import profile to the pool');
      await withCatalogStockWrite(async (client) => {
        assert.equal((await client.query("select current_setting('lock_timeout') as timeout")).rows[0].timeout, '5s');
      });
    });

    await t.test('statement timeout rolls back earlier writes and returns a usable pooled connection without retry', async () => {
      await query('create table synthetic_deadline_rows(id integer primary key, value integer not null)');
      await query('insert into synthetic_deadline_rows values (1,0),(2,0)');
      let attempts = 0;
      let pid = 0;
      await assert.rejects(withTransaction(async (client) => {
        attempts++;
        pid = Number((await client.query('select pg_backend_pid() as pid')).rows[0].pid);
        await client.query('update synthetic_deadline_rows set value=1 where id=1');
        await client.query("set local statement_timeout='80ms'");
        await client.query('select pg_sleep(0.5)');
      }, { profile: 'interactive', retryOnConflict: true }), (error: unknown) => (error as { code?: string }).code === '57014');
      assert.equal(attempts, 1, 'SQL timeout is not safe-conflict retry');
      assert.equal((await query('select value from synthetic_deadline_rows where id=1')).rows[0].value, 0);
      const same = await acquirePooledPid(pid);
      try {
        assert.equal((await same.query('select 1 as value')).rows[0].value, 1);
        assert.equal((await same.query("select current_setting('statement_timeout') as timeout")).rows[0].timeout, '1min');
      } finally { same.release(); }
    });

    await t.test('lock timeout rolls back earlier writes and does not loop or leave the pool in aborted state', async () => {
      let attempts = 0;
      await connected(async (blocker) => {
        await blocker.query('begin');
        await blocker.query('update synthetic_deadline_rows set value=5 where id=2');
        await assert.rejects(withTransaction(async (client) => {
          attempts++;
          await client.query("set local lock_timeout='80ms'");
          await client.query('update synthetic_deadline_rows set value=7 where id=1');
          await client.query('update synthetic_deadline_rows set value=8 where id=2');
        }, { profile: 'interactive', retryOnConflict: true }), (error: unknown) => (error as { code?: string }).code === '55P03');
        await blocker.query('rollback');
      });
      assert.equal(attempts, 1);
      assert.deepEqual((await query('select value from synthetic_deadline_rows order by id')).rows.map(({ value }) => value), [0, 0]);
      assert.equal(await withTransaction(async (client) => (await client.query('select 9 as value')).rows[0].value), 9);
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});

async function acquirePooledPid(pid: number): Promise<PoolClient> {
  const pool = globalThis.__ktsPgPool;
  assert.ok(pool);
  const others: PoolClient[] = [];
  try {
    for (let index = 0; index < 8; index++) {
      const client = await pool.connect();
      if (Number((await client.query('select pg_backend_pid() as pid')).rows[0].pid) === pid) return client;
      others.push(client);
    }
    assert.fail('Expected rolled-back connection to remain reusable in the pool');
  } finally { others.forEach((client) => client.release()); }
}
