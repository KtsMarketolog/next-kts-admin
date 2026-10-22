import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as matching from '../src/shared/lib/analogCatalogMatching';
import { getAnalogStockMatches } from '../src/shared/lib/db/analogStockRepo';

function harness(options: { denied?: boolean; unavailable?: boolean; multiple?: boolean; limited?: boolean; sourceBrand?: string; ambiguous?: boolean; catalogSkuInput?: boolean } = {}) {
  let reads = 0;
  let catalogResolutions = 0;
  const requestedBrands: Array<string | undefined> = [];
  const candidates = [{ id: 'our', brand: 'Secop', model: 'SC18CLX2' }, { id: 'rival', brand: 'Becool', model: 'COMPETITOR-12' }];
  const products = [{ id: 1, brand: 'Secop', model: '', title: 'Компрессор SC 18 CLX.2 104L2197', sku: 'OUR-1', stock: 0, stockMoscow: 0, stockVolzhsk: 0, unit: 'шт.', isExpected: false }];
  if (options.ambiguous) products[0].model = 'COMPETITOR-INPUT';
  if (options.catalogSkuInput) products[0].sku = 'COMPETITOR-INPUT';
  if (options.multiple) products.push({ ...products[0], id: 2, sku: 'OUR-2', stock: 9 });
  const search = { query: 'COMPETITOR-INPUT', normalizedQuery: 'competitorinput', results: candidates, total: candidates.length, requiresModelSelection: !!options.ambiguous, matches: [{ brand: 'Becool', model: 'COMPETITOR-INPUT' }] };
  const deps: Record<string, unknown> = {
    '@/shared/lib/adminAuth': { requireEmployee: async () => ({ session: { role: 'manager', managerId: 7 }, denied: options.denied ? Response.json({}, { status: 401 }) : null }) },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => options.limited ? Response.json({}, { status: 429, headers: { 'Retry-After': '17' } }) : null },
    '@/shared/lib/analogs': {
      normalizeAnalogTerm: (value: string) => value.toLowerCase().replace(/[^a-zа-я0-9]+/g, ''),
      searchAnalogs: (_query: string, _refrigerant: string, sourceBrand?: string) => { requestedBrands.push(sourceBrand); return search; },
      searchAnalogsForCatalogProduct: () => { catalogResolutions++; return search; }, ANALOG_KNOWLEDGE_GENERATED_AT: 'test', ANALOG_KNOWLEDGE_STATS: {},
    },
    '@/shared/lib/db/analogCatalogRepo': {
      getActiveAnalogCatalog: async () => { reads++; if (options.unavailable) throw new Error('Synthetic catalog failure'); return matching.createAnalogCatalogIndex(products); },
      findAnalogCatalogProducts: matching.findCatalogSearchProducts,
    },
    '@/shared/lib/db/analogStockRepo': { getAnalogStockMatches },
  };
  const source = readFileSync(new URL('../src/app/api/analogs/search/route.ts', import.meta.url), 'utf8');
  const output = { exports: {} as { GET: (request: Request) => Promise<Response> } };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', 'console', compiled)((name: string) => {
    assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name];
  }, output, output.exports, { error() {} });
  return { run: () => output.exports.GET(new Request(`https://test.invalid/api/analogs/search?q=COMPETITOR-INPUT&sourceBrand=${encodeURIComponent(options.sourceBrand ?? '')}`)), reads: () => reads, requestedBrands, catalogResolutions: () => catalogResolutions };
}

test('competitor query retains source identity but only own active-catalog results are returned', async () => {
  const h = harness();
  const response = await h.run();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(h.reads(), 1);
  assert.equal(body.matches[0].brand, 'Becool');
  assert.deepEqual(body.results.map((item: { id: string }) => item.id), ['our']);
  assert.equal(body.total, 1);
  assert.equal(body.results[0].stock.stock, 0);
  assert.equal(body.results[0].catalogMatches.length, 1);
  assert.match(response.headers.get('cache-control')!, /private.*no-store/);
});

test('multiple SKUs do not silently pick the one with highest stock', async () => {
  const body = await (await harness({ multiple: true }).run()).json();
  assert.equal(body.results[0].stock, null);
  assert.deepEqual(body.results[0].catalogMatches.map((item: { stock: number }) => item.stock), [0, 9]);
});

test('catalog failure fails closed and never returns rivals or false zero stock', async () => {
  const response = await harness({ unavailable: true }).run();
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.error, /каталог/);
  assert.equal(body.results, undefined);
  assert.doesNotMatch(JSON.stringify(body), /Synthetic|COMPETITOR|Becool/);
});

test('authentication is checked before reading the catalog', async () => {
  const h = harness({ denied: true });
  assert.equal((await h.run()).status, 401);
  assert.equal(h.reads(), 0);
});

test('per-employee search limit rejects work before reading the catalog', async () => {
  const h = harness({ limited: true });
  const response = await h.run();
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '17');
  assert.equal(h.reads(), 0);
});

test('source brand selection is passed to the engine instead of re-merging identical model names', async () => {
  const h = harness({ sourceBrand: 'Ридан' });
  assert.equal((await h.run()).status, 200);
  assert.deepEqual(h.requestedBrands, ['Ридан']);
});

test('one stocked brand does not decide an ambiguous model-only source query', async () => {
  const h = harness({ ambiguous: true });
  assert.equal((await h.run()).status, 200);
  assert.equal(h.catalogResolutions(), 0);
  const ownSku = harness({ ambiguous: true, catalogSkuInput: true });
  assert.equal((await ownSku.run()).status, 200);
  assert.equal(ownSku.catalogResolutions(), 1);
});
