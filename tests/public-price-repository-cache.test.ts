import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import { createPriceReadCache } from '../src/shared/lib/priceReadCache';

type PublicPrice = NonNullable<Awaited<ReturnType<typeof import('../src/shared/lib/db/wholesaleRepo').getPublicWholesalePriceList>>>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  let activeId: number | null = 1;
  let itemBarrier: Promise<void> | undefined;
  let changeOnCacheHit: number | null | undefined;
  let itemLoads = 0;
  let analogBuilds = 0;
  let transactions = 0;
  const states: string[] = [];
  const statements: string[] = [];
  const itemReadStarted = deferred();
  const token = 'synthetic-token';

  const metadata = (id: number) => ({
    id: String(id), title: `Price ${id}`, token, client_name: `Client ${id}`,
    client_company_id: null, manager_id: null, manager_name: '', manager_phone: '', manager_email: '',
    support_manager_id: null, support_manager_name: '', support_manager_phone: '', support_manager_email: '',
    valid_until: null, updated_at: '2026-10-18T00:00:00.000Z',
    show_retail_prices: false, show_stock: true, show_stock_text: false,
  });
  const item = (id: number) => ({
    item_id: String(id * 1000), category_id: '10', category_title: 'Category',
    product_id: String(id * 100), product_title: `Product belonging only to price ${id}`,
    sku: `SKU-${id}`, model: 'MODEL', series_description: '', price_group: '',
    price_group_image_url: null, image_url: null, stock: '2', stock_volzhsk: '2', stock_moscow: '0',
    unit: 'piece', is_expected: false, group_show_stock_numbers: null, group_show_stock_text: null,
    stock_updated_at: null, variant_id: null, variant_title: '',
    retail_price: '120', retail_price_eur: null, retail_price_rub: '120', retail_price_cny: null,
    wholesale_price: '100', price_eur: null, price_rub: '100', price_cny: null,
  });

  async function queryFor(id: number | null, sql: string) {
    statements.push(sql);
    assert.ok(/^\s*(select|set transaction isolation level repeatable read read only)\b/i.test(sql), 'read paths must not write source data');
    if (sql.startsWith('set transaction')) return { rows: [] };
    if (sql === 'select synthetic_revision') return { rows: id === null ? [] : [{ revision: `revision-${id}` }] };
    if (sql.includes('join wholesale_price_list_items')) {
      itemLoads += 1;
      itemReadStarted.resolve();
      if (itemBarrier) await itemBarrier;
      return { rows: id === null ? [] : [item(id)] };
    }
    assert.match(sql, /left join wholesale_managers/);
    return { rows: id === null ? [] : [metadata(id)] };
  }

  const modules: Record<string, unknown> = {
    './client': {
      query: (sql: string) => queryFor(activeId, sql),
      withTransaction: async (work: (client: { query: (sql: string) => ReturnType<typeof queryFor> }) => Promise<unknown>) => {
        transactions += 1;
        const snapshotId = activeId;
        return work({ query: (sql: string) => queryFor(snapshotId, sql) });
      },
    },
    './schema': { ensureSiteSchema: async () => {} },
    '../analogs': { buildPriceListAnalogLinks: () => { analogBuilds += 1; return new Map(); } },
    '../wholesaleStockDisplay': { resolveWholesaleStockDisplayMode: () => 'numbers' },
    './wholesalePriceTelemetryRepo': { normalizePublicWholesalePriceToken: (value: string) => value === token ? token : null },
    './wholesalePriceRevision': {
      readPublicWholesalePriceRevision: async (_token: string, query: (sql: string) => Promise<{ rows: Array<{ revision: string }> }>) => {
        const response = await query('select synthetic_revision');
        return response.rows[0]?.revision ?? null;
      },
    },
    '../priceReadCache': {
      createPriceReadCache: (options: Parameters<typeof createPriceReadCache>[0]) => {
        const cache = createPriceReadCache(options);
        return {
          read(key: string, load: () => Promise<unknown>, onState?: (state: 'hit' | 'miss' | 'coalesced') => void) {
            return cache.read(key, load, (state) => {
              states.push(state);
              if (state === 'hit' && changeOnCacheHit !== undefined) {
                activeId = changeOnCacheHit;
                changeOnCacheHit = undefined;
              }
              onState?.(state);
            });
          },
        };
      },
    },
    '../pricePerformance': { createPricePerformanceTrace: () => ({
      measure: async <T,>(_stage: string, work: () => Promise<T>) => work(),
      measureSync: <T,>(_stage: string, work: () => T) => work(),
      finish: () => {},
    }) },
  };
  const exports = {};
  const code = ts.transpileModule(readFileSync('src/shared/lib/db/wholesaleRepo.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, {
    exports,
    require(name: string) { assert.ok(name in modules, name); return modules[name]; },
  });
  const repo = exports as { getPublicWholesalePriceList(token: string, options?: { includeAnalogs?: boolean }): Promise<PublicPrice | null> };
  return {
    read: (options?: { includeAnalogs?: boolean }) => repo.getPublicWholesalePriceList(token, options),
    blockItems: (barrier: Promise<void>) => { itemBarrier = barrier; },
    changeOwner: (id: number | null) => { activeId = id; },
    changeOnHit: (id: number | null) => { changeOnCacheHit = id; },
    itemReadStarted: itemReadStarted.promise,
    states, statements,
    counts: () => ({ itemLoads, analogBuilds, transactions }),
  };
}

for (const nextOwner of [null, 2] as const) {
  const transition = nextOwner === null ? 'revocation' : 'reassignment from price A to B';
  test(`public price repository: ${transition} during a pending snapshot never delivers price A`, async () => {
    const h = harness();
    const barrier = deferred();
    h.blockItems(barrier.promise);
    const request = h.read();
    await h.itemReadStarted;
    h.changeOwner(nextOwner);
    barrier.resolve();
    assert.equal(await request, null);
    assert.equal(h.counts().itemLoads, 1);
    if (nextOwner !== null) {
      const current = await h.read();
      assert.equal(current?.id, 2);
      assert.equal(current?.categories[0].products[0].id, 200);
    }
  });

  test(`public price repository: ${transition} while coalesced readers wait rejects every old result`, async () => {
    const h = harness();
    const barrier = deferred();
    h.blockItems(barrier.promise);
    const first = h.read();
    await h.itemReadStarted;
    const joined = Array.from({ length: 20 }, () => h.read());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.states.filter((state) => state === 'coalesced').length, 20);
    assert.equal(h.counts().itemLoads, 1);
    h.changeOwner(nextOwner);
    barrier.resolve();
    assert.deepEqual(await Promise.all([first, ...joined]), Array.from({ length: 21 }, () => null));
    assert.deepEqual(h.counts(), { itemLoads: 1, analogBuilds: 1, transactions: 1 });
  });

  test(`public price repository: ${transition} after a cache hit is detected before delivery`, async () => {
    const h = harness();
    assert.equal((await h.read())?.id, 1);
    h.changeOnHit(nextOwner);
    assert.equal(await h.read(), null);
    assert.deepEqual(h.states, ['miss', 'hit']);
    assert.deepEqual(h.counts(), { itemLoads: 1, analogBuilds: 1, transactions: 1 });
  });
}

test('public price repository: warm repeated reads and simultaneous first readers calculate analogs once', async () => {
  const h = harness();
  const barrier = deferred();
  h.blockItems(barrier.promise);
  const first = h.read();
  await h.itemReadStarted;
  const joined = Array.from({ length: 12 }, () => h.read());
  await new Promise((resolve) => setImmediate(resolve));
  barrier.resolve();
  const results = await Promise.all([first, ...joined]);
  assert.ok(results.every((result) => result?.id === 1));
  for (let index = 0; index < 20; index += 1) assert.equal(await h.read(), results[0]);
  assert.deepEqual(h.counts(), { itemLoads: 1, analogBuilds: 1, transactions: 1 });
  assert.equal(h.states.filter((state) => state === 'hit').length, 20);
  assert.ok(Object.isFrozen(results[0]));
  assert.ok(Object.isFrozen(results[0]?.categories[0].products[0]));
});

test('public price repository: export reads omit analog calculation and do not poison the page cache', async () => {
  const h = harness();
  const exportPrice = await h.read({ includeAnalogs: false });
  assert.equal(exportPrice?.categories[0].products[0].variants[0].wholesalePrice, '100');
  assert.equal(await h.read({ includeAnalogs: false }), exportPrice);
  assert.deepEqual(h.counts(), { itemLoads: 1, analogBuilds: 0, transactions: 1 });
  const pagePrice = await h.read();
  assert.equal(pagePrice?.id, exportPrice?.id);
  assert.equal(pagePrice?.categories[0].products[0].variants[0].wholesalePrice, '100');
  assert.equal(await h.read(), pagePrice);
  assert.deepEqual(h.counts(), { itemLoads: 2, analogBuilds: 1, transactions: 2 });
});
