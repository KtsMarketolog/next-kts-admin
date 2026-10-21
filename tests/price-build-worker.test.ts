import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test, { before } from 'node:test';
import { deserialize } from 'node:v8';
import { Worker } from 'node:worker_threads';

import { buildPriceListAnalogLinks } from '../src/shared/lib/analogs';
import { assemblePriceBuild } from '../src/shared/lib/priceBuild/assemble';
import { buildPublicWholesalePriceInWorker, createPriceBuildWorkerClient, freezePrice } from '../src/shared/lib/priceBuild/client';
import { PriceBuildError, type PriceBuildErrorCode } from '../src/shared/lib/priceBuild/errors';
import type { PriceBuildInput, PriceItemRow, PublicWholesalePriceMetadata } from '../src/shared/lib/priceBuild/types';
import { loadLegacyPriceAssembly, priceBuildWorkload } from './helpers/priceBuildWorkload';

before(() => { execFileSync(process.execPath, ['scripts/build-price-worker.mjs'], { stdio: 'pipe' }); });

const metadata: PublicWholesalePriceMetadata = {
  id: 17, clientCompanyId: 7, title: 'Synthetic price', token: 'synthetic-worker-price', clientName: 'Synthetic client',
  managerId: 2, managerName: 'Synthetic manager', managerEmail: 'manager@example.test', managerPhone: '000',
  supportManagerId: null, supportManagerName: '', supportManagerEmail: '', supportManagerPhone: '',
  validUntil: null, updatedAt: '2026-10-22T10:00:00Z', showRetailPrices: true, showStock: true, showStockText: false,
};

function row(overrides: Partial<PriceItemRow> = {}): PriceItemRow {
  return { item_id: '101', category_id: null, category_title: null, product_id: '11', product_title: 'Synthetic product',
    sku: 'SYN-11', model: 'QR3-90A', series_description: 'Synthetic description', price_group: 'Group 1',
    price_group_image_url: '/synthetic-group.webp', image_url: '/synthetic.webp', stock: '8', stock_volzhsk: '3', stock_moscow: '5',
    unit: 'шт.', is_expected: true, group_show_stock_numbers: null, group_show_stock_text: true,
    stock_updated_at: '2026-10-22T09:00:00Z', variant_id: null, variant_title: null,
    retail_price: '99.99', retail_price_eur: '10.50', retail_price_rub: '1000.00', retail_price_cny: '80.00',
    wholesale_price: '88.00', price_eur: '9.00', price_rub: '900.00', price_cny: '70.00', ...overrides };
}

function input(includeAnalogs = true): PriceBuildInput {
  return { metadata, includeAnalogs, revision: 'synthetic-revision-23', rows: [
    row(),
    row({ item_id: '102', variant_id: '202', variant_title: 'Second variant', price_rub: null }),
    row({ item_id: '103', category_id: '4', category_title: 'Named category', product_id: '12', model: 'TAG4546Z-TU',
      sku: 'SYN-12', product_title: 'Second product', stock: null, stock_volzhsk: null, stock_moscow: null,
      unit: null, is_expected: null, group_show_stock_text: false, group_show_stock_numbers: true }),
  ] };
}

const code = (expected: PriceBuildErrorCode) => (error: unknown) => error instanceof PriceBuildError && error.code === expected;

test('pure assembly preserves category/order/variant/stock/price semantics and exact analog formulas', () => {
  const source = input(false);
  const beforeInput = structuredClone(source);
  const result = assemblePriceBuild(source);
  assert.deepEqual(source, beforeInput, 'source snapshot is never changed');
  assert.deepEqual(result.price, {
    ...metadata, cacheRevision: source.revision, categories: [
      { id: 0, title: 'Без категории', products: [{
        id: 11, title: 'Synthetic product', sku: 'SYN-11', model: 'QR3-90A', description: 'Synthetic description',
        priceGroup: 'Group 1', priceGroupImageUrl: '/synthetic-group.webp', imageUrl: '/synthetic.webp',
        stock: 8, stockVolzhsk: 3, stockMoscow: 5, unit: 'шт.', isExpected: true, stockDisplayMode: 'text',
        stockUpdatedAt: '2026-10-22T09:00:00Z', analogs: [], variants: [
          { priceItemId: 101, id: null, title: 'Цена', retailPrice: '99.99', retailPriceEur: '10.50', retailPriceRub: '1000.00',
            retailPriceCny: '80.00', wholesalePrice: '88.00', priceEur: '9.00', priceRub: '900.00', priceCny: '70.00' },
          { priceItemId: 102, id: 202, title: 'Second variant', retailPrice: '99.99', retailPriceEur: '10.50', retailPriceRub: '1000.00',
            retailPriceCny: '80.00', wholesalePrice: '88.00', priceEur: '9.00', priceRub: null, priceCny: '70.00' },
        ],
      }] },
      { id: 4, title: 'Named category', products: [{
        id: 12, title: 'Second product', sku: 'SYN-12', model: 'TAG4546Z-TU', description: 'Synthetic description',
        priceGroup: 'Group 1', priceGroupImageUrl: '/synthetic-group.webp', imageUrl: '/synthetic.webp',
        stock: 0, stockVolzhsk: 0, stockMoscow: 0, unit: null, isExpected: false, stockDisplayMode: 'number',
        stockUpdatedAt: '2026-10-22T09:00:00Z', analogs: [], variants: [
          { priceItemId: 103, id: null, title: 'Цена', retailPrice: '99.99', retailPriceEur: '10.50', retailPriceRub: '1000.00',
            retailPriceCny: '80.00', wholesalePrice: '88.00', priceEur: '9.00', priceRub: '900.00', priceCny: '70.00' },
        ],
      }] },
    ],
  });
  assert.equal(result.timings.analogsMs, 0, 'exports do not calculate analogs');
  const products = result.price.categories.flatMap(category => category.products);
  const expectedLinks = buildPriceListAnalogLinks(products);
  const withAnalogs = assemblePriceBuild(input(true));
  assert.ok(expectedLinks.get(11)?.some(link => link.productId === 12), 'fixture actually exercises known analog matching');
  for (const product of withAnalogs.price.categories.flatMap(category => category.products)) {
    assert.deepEqual(product.analogs, expectedLinks.get(product.id) ?? []);
  }
});

test('real bundled worker preserves pure results and transfers an exact private-cache serialization', async () => {
  for (const includeAnalogs of [true, false]) {
    const source = input(includeAnalogs);
    const expected = assemblePriceBuild(source);
    const built = await buildPublicWholesalePriceInWorker(source);
    assert.deepEqual(built.price, expected.price);
    assert.deepEqual(deserialize(built.serialized), expected.price);
    assert.equal(built.cacheBytes, built.serialized.byteLength);
    assert.ok(built.cacheBytes > 0);
    for (const duration of Object.values(built.timings)) assert.ok(Number.isFinite(duration) && duration >= 0);
    if (!includeAnalogs) assert.equal(built.timings.analogsMs, 0);
  }
});

test('worker matches frozen pre-refactor assembly across real analog models, nulls, variants, currencies and stock modes', async () => {
  const legacy = loadLegacyPriceAssembly();
  for (const includeAnalogs of [true, false]) {
    for (const [showStock, showStockText] of [[true, false], [false, true], [false, false], [true, true]]) {
      const source = priceBuildWorkload(91, includeAnalogs);
      source.metadata.showStock = showStock; source.metadata.showStockText = showStockText;
      const built = await buildPublicWholesalePriceInWorker(source);
      assert.deepEqual(built.price, legacy(source));
      assert.ok(built.mainThreadTimings!.inputTransferMs >= 0);
      assert.ok(built.mainThreadTimings!.deserializationMs >= 0);
    }
  }
});

test('worker cancellation/deadline/crash/bad-message paths terminate before releasing their local admission slot', async () => {
  const workers: Worker[] = [];
  const build = createPriceBuildWorkerClient({ maxActiveWorkers: 1, spawn: () => {
    const worker = new Worker('setInterval(() => {}, 1000)', { eval: true, execArgv: [] });
    workers.push(worker); return worker;
  } });
  const cancel = new AbortController();
  const cancelled = assert.rejects(build(input(), { signal: cancel.signal }), code('PRICE_BUILD_ABORTED'));
  await assert.rejects(build(input()), code('PRICE_BUILD_BUSY'));
  cancel.abort();
  await cancelled;
  assert.equal(workers[0].threadId, -1);
  await assert.rejects(build(input(), { timeoutMs: 15 }), code('PRICE_BUILD_TIMEOUT'));
  assert.equal(workers[1].threadId, -1);
  await assert.rejects(build(input(), { deadlineAt: Date.now() + 15 }), code('PRICE_BUILD_TIMEOUT'));
  assert.equal(workers[2].threadId, -1);
  await assert.rejects(build(input(), { signal: AbortSignal.abort() }), code('PRICE_BUILD_ABORTED'));
  await assert.rejects(build(input(), { deadlineAt: Date.now() - 1 }), code('PRICE_BUILD_TIMEOUT'));
  assert.equal(workers.length, 3, 'already aborted/expired jobs never spawn');

  for (const script of [
    'throw new Error("Synthetic worker failure")',
    'process.exit(0)',
    'require("node:worker_threads").parentPort.postMessage({ok:true,result:{}}); setInterval(() => {},1000)',
  ]) {
    let worker: Worker | undefined;
    const failing = createPriceBuildWorkerClient({ spawn: () => (worker = new Worker(script, { eval: true, execArgv: [] })) });
    await assert.rejects(failing(input()), code('PRICE_BUILD_FAILED'));
    assert.equal(worker?.threadId, -1);
  }
  const constructorFailure = createPriceBuildWorkerClient({ spawn: () => { throw new Error('Synthetic start failure'); } });
  for (let index = 0; index < 3; index += 1) await assert.rejects(constructorFailure(input()), code('PRICE_BUILD_FAILED'));
});

test('real worker leaves the request thread responsive during a cold analog calculation', async () => {
  let online = false;
  let ticksDuringWorker = 0;
  const build = createPriceBuildWorkerClient({ spawn: (source) => {
    const worker = new Worker(path.resolve('.runtime-build/price-build-worker.cjs'), { workerData: source, execArgv: [] });
    worker.once('online', () => { online = true; });
    return worker;
  } });
  const source = input();
  source.rows = Array.from({ length: 800 }, (_, index) => row({ item_id: String(index + 1), product_id: String(index + 1),
    sku: `SYN-WORKER-${index}`, model: `SYN-MODEL-${index}`, product_title: `Synthetic ${index}` }));
  const timer = setInterval(() => { if (online) ticksDuringWorker += 1; }, 2);
  try {
    const built = await build(source);
    assert.equal(built.price.categories[0].products.length, 800);
    assert.ok(built.timings.analogsMs > 0);
    assert.ok(ticksDuringWorker >= 2, `request thread timer must run while worker computes: ${ticksDuringWorker}`);
  } finally { clearInterval(timer); }
});

test('cooperative deep freezing preserves identities, shared references and nested immutability without blocking timers', async () => {
  const common = { value: 42 };
  const value = { rows: Array.from({ length: 10_000 }, () => ({ common, values: [1, 2, 3] })) };
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 0);
  assert.equal(await freezePrice(value), value);
  clearTimeout(timer);
  assert.equal(ticked, true);
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.rows)); assert.ok(Object.isFrozen(common));
  for (const item of value.rows) { assert.ok(Object.isFrozen(item)); assert.ok(Object.isFrozen(item.values)); }
  const controller = new AbortController();
  const cancelTimer = setTimeout(() => controller.abort(), 0);
  try {
    await assert.rejects(freezePrice({ rows: Array.from({ length: 50_000 }, () => ({})) }, { signal: controller.signal }), code('PRICE_BUILD_ABORTED'));
  } finally { clearTimeout(cancelTimer); }
});
