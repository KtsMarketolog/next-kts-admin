import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import { createAnalogCatalogIndex } from '../src/shared/lib/analogCatalogMatching';
import { getAnalogStockMatches } from '../src/shared/lib/db/analogStockRepo';

function harness(options: { denied?: boolean; limited?: boolean; unavailable?: boolean } = {}) {
  let reads = 0;
  const rows = [
    { id: 'own', brand: 'Sanhua', model: 'YCVS2H01', catalogAliases: ['OUR-1'] },
    { id: 'absent', brand: 'Sanhua', model: 'ABSENT-42', catalogAliases: [] },
  ];
  const dependencies: Record<string, unknown> = {
    '@/shared/lib/adminAuth': { requireEmployee: async () => ({ session: { role: 'manager', managerId: 9 }, denied: options.denied ? Response.json({}, { status: 401 }) : null }) },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => options.limited ? Response.json({}, { status: 429, headers: { 'Retry-After': '12' } }) : null },
    '@/shared/lib/analogs': { getSanhuaKnowledgeCandidates: () => rows },
    '@/shared/lib/db/analogCatalogRepo': { getActiveAnalogCatalog: async () => {
      reads++;
      if (options.unavailable) throw new Error('Synthetic failure');
      return createAnalogCatalogIndex([{ id: 1, brand: 'Sanhua', model: 'YCVS2H01', title: 'Обратный клапан YCVS2H01', sku: 'OUR-1', stock: 0, stockMoscow: 0, stockVolzhsk: 0, unit: 'шт.', isExpected: false }]);
    } },
    '@/shared/lib/db/analogStockRepo': { getAnalogStockMatches },
  };
  const source = readFileSync(new URL('../src/app/api/analogs/sanhua/route.ts', import.meta.url), 'utf8');
  const output = { exports: {} as { GET: () => Promise<Response> } };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', 'console', compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name];
  }, output, output.exports, { error() {} });
  return { run: () => output.exports.GET(), reads: () => reads };
}

test('Sanhua reference only returns active catalogue candidates including zero stock', async () => {
  const h = harness();
  const response = await h.run();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.candidates.map((row: { id: string }) => row.id), ['own']);
  assert.equal(body.candidates[0].catalogMatches[0].stock, 0);
  assert.equal(h.reads(), 1);
  assert.match(response.headers.get('cache-control')!, /private.*no-store/);
});

test('Sanhua authorization and per-employee limit run before catalogue reads', async () => {
  for (const [options, status] of [[{ denied: true }, 401], [{ limited: true }, 429]] as const) {
    const h = harness(options);
    const response = await h.run();
    assert.equal(response.status, status);
    assert.equal(h.reads(), 0);
    if (status === 429) assert.equal(response.headers.get('retry-after'), '12');
  }
});

test('Sanhua catalogue failure is explicit and does not claim empty stock', async () => {
  const response = await harness({ unavailable: true }).run();
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.match(body.error, /каталог/);
  assert.equal(body.candidates, undefined);
  assert.doesNotMatch(JSON.stringify(body), /Synthetic/);
});
