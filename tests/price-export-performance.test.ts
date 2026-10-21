import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import PDFDocument from 'pdfkit';
import ts from 'typescript';

import * as exportCache from '../src/shared/lib/priceExportCache';
import * as buildErrors from '../src/shared/lib/priceBuild/errors';

type Format = 'pdf' | 'excel';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(format: Format) {
  const calls: string[] = [];
  const finished: number[] = [];
  const events: Array<Record<string, unknown>> = [];
  let active = true;
  let revision = 'revision-1';
  let builtRevision: string | undefined;
  let denied: 'actor' | 'global' | null = null;
  let rows = 2;
  let failProducts = false;
  let buildError: Error | undefined;
  let blockProducts: Promise<void> | undefined;
  let revokeDuringProducts = false;
  let pdfBuilds = 0;
  let productId = 7;
  let metadataReads = 0;
  let deliveryIdentity: number | null | undefined;
  const metadata = {
    id: 7, title: 'Synthetic price', clientName: 'Synthetic client', token: 'synthetic-token',
    managerId: 3, managerName: 'Synthetic manager', managerEmail: 'synthetic@example.test',
    managerPhone: '', supportManagerName: '', supportManagerEmail: '', supportManagerPhone: '',
    validUntil: '2000-01-01', showRetailPrices: true,
  };
  const pdfCache = exportCache.createPriceExportMemoryCache(24, 32 * 1024 * 1024);
  class CountedPdf extends PDFDocument {
    constructor(options: PDFKit.PDFDocumentOptions) {
      super(options);
      pdfBuilds += 1;
    }
  }
  const modules: Record<string, unknown> = {
    fs: { existsSync: () => false },
    pdfkit: CountedPdf,
    '@/shared/lib/adminAuth': { getAdminSession: async () => null, isManagerSessionRole: () => false },
    '@/shared/lib/db': {
      getPublicWholesalePriceListMetadata: async () => {
        calls.push('metadata');
        metadataReads += 1;
        if (!active || (metadataReads > 1 && deliveryIdentity === null)) return null;
        return { ...metadata, id: metadataReads > 1 && deliveryIdentity !== undefined ? deliveryIdentity : metadata.id };
      },
      getPublicWholesalePriceListRevision: async () => { calls.push('revision'); return active ? revision : null; },
      getPublicWholesalePriceList: async (_token: string, options: { includeAnalogs: boolean }) => {
        calls.push('products');
        assert.equal(options.includeAnalogs, false);
        if (blockProducts) await blockProducts;
        if (failProducts) throw new Error('Synthetic product lookup failure');
        if (buildError) throw buildError;
        if (revokeDuringProducts) active = false;
        return {
          ...metadata, id: productId, cacheRevision: builtRevision ?? revision,
          categories: [{ products: [{
            title: 'Synthetic product', priceGroup: 'Group', model: 'MODEL', sku: 'SKU', description: 'Description',
            stockDisplayMode: 'none', stock: 0, unit: 'piece', variants: Array.from({ length: rows }, () => ({
              priceRub: '99', wholesalePrice: '99', retailPriceRub: '120',
            })),
          }] }],
        };
      },
      trackAnalyticsEvent: async (event: Record<string, unknown>) => { events.push(event); },
    },
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async () => {} },
    '@/shared/lib/priceExportCache': exportCache,
    '@/shared/lib/priceBuild/errors': buildErrors,
    '@/shared/lib/pricePdfCache': {
      readPricePdfCache: async (key: exportCache.PriceExportCacheKey) => { calls.push('cache_read'); return pdfCache.read(key); },
      writePricePdfCache: async (key: exportCache.PriceExportCacheKey, value: Buffer) => { calls.push('cache_write'); await pdfCache.write(key, value); },
    },
    '@/shared/lib/pricePerformance': { createPricePerformanceTrace: () => ({
      measure: async <T,>(_stage: string, work: () => Promise<T>) => work(),
      measureSync: <T,>(_stage: string, work: () => T) => work(),
      header: () => 'synthetic;dur=1', finish: (status: number) => { finished.push(status); },
    }) },
    '@/shared/lib/publicSession': {
      PUBLIC_PRICE_SESSION_COOKIE: 'price-cookie',
      getOrCreateSessionCookie: () => ({ sessionId: 'synthetic-session' }),
      applySessionCookie: (headers: Headers) => { headers.set('Set-Cookie', 'synthetic-cookie'); },
    },
    '@/shared/lib/rateLimit': { checkDbRateLimit: async (key: string) => {
      const stage = key.endsWith(':global') ? 'global' : 'actor';
      calls.push(`limit_${stage}`);
      return { allowed: denied !== stage, retryAfter: 17 };
    } },
    '@/shared/lib/wholesaleStockDisplay': { formatWholesaleStockLabel: () => '', hasVisibleWholesaleStock: () => false },
  };
  const exports: { GET?: (request: Request, context: { params: Promise<{ token: string }> }) => Promise<Response> } = {};
  const code = ts.transpileModule(readFileSync(`src/app/api/price/[token]/${format}/route.ts`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  runInNewContext(code, {
    exports, Buffer, Response, Headers, TextEncoder, ArrayBuffer, Uint8Array,
    require(name: string) { assert.ok(name in modules, name); return modules[name]; },
  });
  return {
    calls, finished, events,
    get: () => exports.GET!(new Request(`https://example.test/api/price/synthetic-token/${format}`), { params: Promise.resolve({ token: 'synthetic-token' }) }),
    setActive(value: boolean) { active = value; },
    setRevision(value: string) { revision = value; },
    setBuiltRevision(value: string) { builtRevision = value; },
    deny(value: typeof denied) { denied = value; },
    setRows(value: number) { rows = value; },
    setFailProducts(value: boolean) { failProducts = value; },
    setBuildError(value?: Error) { buildError = value; },
    setProductBlock(value: Promise<void>) { blockProducts = value; },
    revokeDuringProducts() { revokeDuringProducts = true; },
    setProductIdentity(value: number) { productId = value; },
    changeDeliveryIdentity(value: number | null) { deliveryIdentity = value; metadataReads = 0; },
    pdfBuilds: () => pdfBuilds,
  };
}

for (const format of ['pdf', 'excel'] as const) {
  test(`${format}: rejected access does not consume limits, resolve revisions or build products`, async () => {
    const h = harness(format);
    h.setActive(false);
    assert.equal((await h.get()).status, 404);
    assert.deepEqual(h.calls, ['metadata']);
    assert.deepEqual(h.finished, [404]);
  });

  test(`${format}: rejected actor does not consume global quota or execute export work`, async () => {
    const h = harness(format);
    h.deny('actor');
    const response = await h.get();
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('Retry-After'), '17');
    assert.equal(response.headers.get('Set-Cookie'), 'synthetic-cookie');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(h.calls, ['metadata', 'limit_actor']);
  });

  test(`${format}: rejected global limit precedes revision, cache and product work`, async () => {
    const h = harness(format);
    h.deny('global');
    assert.equal((await h.get()).status, 429);
    assert.deepEqual(h.calls, ['metadata', 'limit_actor', 'limit_global']);
  });

  test(`${format}: cold export omits analogs, hot export skips full products and expired date remains informational`, async () => {
    const h = harness(format);
    const first = await h.get();
    assert.equal(first.status, 200);
    const firstBytes = Buffer.from(await first.arrayBuffer());
    assert.ok(firstBytes.byteLength > 100);
    assert.equal(first.headers.get('X-Price-Export-Cache'), 'miss');
    h.calls.length = 0;
    const second = await h.get();
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('X-Price-Export-Cache'), 'hit');
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), firstBytes);
    assert.ok(!h.calls.includes('products'));
    assert.equal(h.events.length, 2);
    assert.equal(second.headers.get('Server-Timing'), 'synthetic;dur=1');
    if (format === 'pdf') assert.equal(h.pdfBuilds(), 1);
    else {
      const xml = firstBytes.toString('utf8');
      assert.equal(xml.split('Synthetic product').length - 1, 2);
      assert.match(xml, /99 RUB/);
      assert.match(xml, /120 RUB/);
    }
  });

  test(`${format}: revision changes invalidate download cache without changing source data`, async () => {
    const h = harness(format);
    assert.equal((await h.get()).status, 200);
    h.setRevision('revision-2');
    h.calls.length = 0;
    const response = await h.get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Price-Export-Cache'), 'miss');
    assert.equal(h.calls.filter((call) => call === 'products').length, 1);
  });

  test(`${format}: revoked token cannot retrieve a previously cached download`, async () => {
    const h = harness(format);
    assert.equal((await h.get()).status, 200);
    h.calls.length = 0;
    h.setActive(false);
    assert.equal((await h.get()).status, 404);
    assert.deepEqual(h.calls, ['metadata']);
  });

  test(`${format}: long-running generation rechecks access before returning a file`, async () => {
    const h = harness(format);
    h.revokeDuringProducts();
    assert.equal((await h.get()).status, 404);
    assert.equal(h.events.length, 0);
    assert.ok(!h.calls.includes('cache_write'));
  });

  test(`${format}: token reassignment during product loading never exports another price`, async () => {
    const h = harness(format);
    h.setProductIdentity(8);
    assert.equal((await h.get()).status, 404);
    assert.equal(h.events.length, 0);
    assert.equal(h.pdfBuilds(), 0);
    assert.ok(!h.calls.includes('cache_write'));
  });

  test(`${format}: cache hits recheck access immediately before delivery`, async () => {
    const h = harness(format);
    assert.equal((await h.get()).status, 200);
    h.calls.length = 0;
    h.changeDeliveryIdentity(null);
    assert.equal((await h.get()).status, 404);
    assert.ok(!h.calls.includes('products'));
    assert.equal(h.events.length, 1);
  });

  test(`${format}: token reassignment after a cache hit cannot expose the former price`, async () => {
    const h = harness(format);
    assert.equal((await h.get()).status, 200);
    h.calls.length = 0;
    h.changeDeliveryIdentity(8);
    assert.equal((await h.get()).status, 404);
    assert.ok(!h.calls.includes('products'));
    assert.equal(h.events.length, 1);
  });

  test(`${format}: simultaneous requests share one cold build`, async () => {
    const h = harness(format);
    const blocked = deferred();
    h.setProductBlock(blocked.promise);
    const requests = Array.from({ length: 12 }, () => h.get());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.calls.filter((call) => call === 'products').length, 1);
    blocked.resolve();
    const responses = await Promise.all(requests);
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal(h.calls.filter((call) => call === 'products').length, 1);
    assert.equal(responses.filter((response) => response.headers.get('X-Price-Export-Cache') === 'shared').length, 11);
  });

  test(`${format}: failed product loading releases the generation slot and does not cache failure`, async () => {
    const h = harness(format);
    h.setFailProducts(true);
    await assert.rejects(h.get(), /Synthetic product lookup failure/);
    h.setFailProducts(false);
    assert.equal((await h.get()).status, 200);
    assert.deepEqual(h.finished, [500, 200]);
  });

  for (const code of ['PRICE_BUILD_BUSY', 'PRICE_BUILD_TIMEOUT', 'PRICE_BUILD_UNAVAILABLE', 'PRICE_BUILD_ABORTED', 'PRICE_BUILD_FAILED'] as const) {
    test(`${format}: ${code} returns retryable 503, preserves cache/source and allows a successful retry`, async () => {
      const h = harness(format);
      h.setBuildError(new buildErrors.PriceBuildError(code));
      const response = await h.get();
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('Retry-After'), '3');
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      assert.equal(response.headers.get('Server-Timing'), 'synthetic;dur=1');
      assert.equal(response.headers.get('Set-Cookie'), 'synthetic-cookie', 'retry keeps the same session used by the rate limit');
      assert.equal(response.headers.get('Content-Disposition'), null, 'error is not an empty download');
      const body = await response.json();
      assert.equal(body.code, code);
      assert.equal(body.retryable, true);
      assert.match(body.error, /Данные сохранены/);
      assert.equal(h.events.length, 0, 'a failed build is not a successful download');
      assert.ok(!h.calls.includes('cache_write'));
      assert.equal(h.pdfBuilds(), 0);

      h.setBuildError();
      const retry = await h.get();
      assert.equal(retry.status, 200);
      assert.equal(retry.headers.get('X-Price-Export-Cache'), 'miss', 'failed build did not poison cache');
      assert.ok((await retry.arrayBuffer()).byteLength > 100);
      assert.deepEqual(h.finished, [503, 200]);
    });
  }

  test(`${format}: export limit returns an error rather than a truncated file`, async () => {
    const h = harness(format);
    h.setRows(15_001);
    assert.equal((await h.get()).status, 413);
    assert.equal(h.events.length, 0);
    assert.equal(h.pdfBuilds(), 0);
    assert.ok(!h.calls.includes('cache_write'));
  });

  test(`${format}: a concurrently changed built revision is not cached under an older key`, async () => {
    const h = harness(format);
    h.setBuiltRevision('revision-newer');
    assert.equal((await h.get()).status, 200);
    assert.equal((await h.get()).status, 200);
    assert.equal(h.calls.filter((call) => call === 'products').length, 2);
    assert.ok(!h.calls.includes('cache_write'));
  });
}

test('export coordinator: busy requests never start loading data, and same revision can join at capacity', async () => {
  const blocked = deferred();
  const memory = exportCache.createPriceExportMemoryCache(4, 1000);
  const run = exportCache.createPriceExportCoordinator({ maxConcurrent: 1, ...memory });
  let loads = 0;
  const build = async () => { loads += 1; await blocked.promise; return { kind: 'ready' as const, bytes: Buffer.from('download') }; };
  const first = run({ priceListId: 1, revision: 'a' }, build);
  await new Promise((resolve) => setImmediate(resolve));
  const joined = run({ priceListId: 1, revision: 'a' }, build);
  assert.deepEqual(await run({ priceListId: 2, revision: 'a' }, build), { kind: 'busy' });
  assert.equal(loads, 1);
  blocked.resolve();
  assert.equal((await first).kind, 'ready');
  assert.deepEqual(await joined, { kind: 'ready', bytes: Buffer.from('download'), cache: 'shared' });
  assert.equal(loads, 1);
});

test('export memory cache: entry and byte budgets evict derived downloads only', async () => {
  const cache = exportCache.createPriceExportMemoryCache(2, 5);
  const key = (priceListId: number) => ({ priceListId, revision: 'a' });
  await cache.write(key(1), Buffer.from('aa'));
  await cache.write(key(2), Buffer.from('bb'));
  await cache.read(key(1));
  await cache.write(key(3), Buffer.from('cc'));
  assert.equal(await cache.read(key(2)), null);
  assert.deepEqual(await cache.read(key(1)), Buffer.from('aa'));
  await cache.write(key(4), Buffer.from('dddd'));
  assert.equal(await cache.read(key(1)), null);
  assert.equal(await cache.read(key(3)), null);
  await cache.write(key(5), Buffer.from('oversized'));
  assert.equal(await cache.read(key(5)), null);
  assert.deepEqual(await cache.read(key(4)), Buffer.from('dddd'));
});
