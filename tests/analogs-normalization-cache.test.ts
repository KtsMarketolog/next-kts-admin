import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

type AnalogModule = typeof import('../src/shared/lib/analogs');
type KnowledgeFixture = {
  directGroups: Array<{ kind: string; items: Array<{ model: string; aliases: string[] }> }>;
  compressorSeries: Array<{ products: Array<{ model: string; aliases: string[] }> }>;
};

const source = readFileSync(new URL('../src/shared/lib/analogs.ts', import.meta.url), 'utf8');
const knowledge = JSON.parse(readFileSync(new URL('../src/shared/data/analogs.generated.json', import.meta.url), 'utf8')) as KnowledgeFixture;

function load(useLegacyNormalization = false) {
  let normalizationCalls = 0;
  let code = source;
  if (useLegacyNormalization) {
    // Restore exactly the pre-optimization expression while retaining all other
    // current lookup/ranking code. This compares the real implementation, not a
    // second approximation of the analog algorithm or a changed fixture.
    code = code.replace('const normalizedAliases = normalizedAliasesFor(aliases);',
      'const normalizedAliases = aliases.map(normalizeAnalogTerm).filter(Boolean);');
    assert.notEqual(code, source, 'The baseline must bypass the normalization cache');
  }
  code = code.replace('export function normalizeAnalogTerm(value: string) {',
    'export function normalizeAnalogTerm(value: string) { __normalizationProbe();');
  const output = { exports: {} };
  vm.runInNewContext(ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    module: output, exports: output.exports,
    __normalizationProbe: () => { normalizationCalls++; },
    require: (name: string) => {
      assert.equal(name, '@/shared/data/analogs.generated.json');
      return knowledge;
    },
  });
  return { api: output.exports as AnalogModule, calls: () => normalizationCalls };
}

function representativeModels() {
  const byKind = new Map<string, string[]>();
  for (const group of knowledge.directGroups) {
    const models = byKind.get(group.kind) ?? [];
    if (models.length < 24) models.push(...group.items.slice(0, 3).map((item) => item.model));
    byKind.set(group.kind, models);
  }
  return [...new Set([
    ...[...byKind.values()].flat(),
    ...knowledge.compressorSeries.flatMap((series) => [series.products[0], series.products.at(-1)]
      .filter((product) => product !== undefined).map((product) => product.model)),
    '', 'A', 'AE', 'UNKNOWN-MODEL', 'NEK6210Z', 'YDWF102L35P4-570N-500',
    '  ywf a2s 200s 5dia00  ', 'ＹＷＦ．Ａ２Ｓ－２００Ｓ－５ＤＩＡ００', 'Ёж-ЕЖ',
  ])];
}

test('cached alias normalization is byte-for-byte equivalent across all source families and refrigerants', () => {
  const baseline = load(true).api;
  const optimized = load().api;
  for (const model of representativeModels()) {
    for (const refrigerant of [undefined, 'R22', 'r290', 'R134a']) {
      const expected = JSON.stringify(baseline.searchAnalogs(model, refrigerant));
      assert.equal(JSON.stringify(optimized.searchAnalogs(model, refrigerant)), expected, `${model} / ${refrigerant ?? 'auto'}`);
      assert.equal(JSON.stringify(optimized.searchAnalogs(model, refrigerant)), expected, 'A warm lookup must retain ordering and all metadata');
    }
  }
});

test('catalogue disambiguation and per-price links retain baseline results and product membership', () => {
  const baseline = load(true).api;
  const optimized = load().api;
  const catalogProducts = [
    { title: 'ВЕНТИЛЯТОР ОСЕВОЙ YDWF102L35P4-570N-500S', model: 'YDWF102L35P4-570N-500', sku: 'ЦБ-Ц0052206' },
    { title: 'Вентилятор осевой YDWF102L45P4-522N-450B', model: '', sku: 'ЦБ-Ц0051592' },
    { title: 'Synthetic compressor NEK6210Z', model: 'NEK6210Z', sku: 'SYNTHETIC-ARTICLE' },
  ];
  for (const product of catalogProducts) {
    for (const term of [product.sku, product.model, product.title]) {
      assert.equal(JSON.stringify(optimized.searchAnalogsForCatalogProduct(term, product)),
        JSON.stringify(baseline.searchAnalogsForCatalogProduct(term, product)));
    }
  }
  const products = representativeModels().filter(Boolean).map((model, index) => ({
    id: index + 1, title: `Synthetic product ${model}`, model,
    sku: index % 3 === 0 ? model : '', priceGroup: index % 2 === 0 ? 'Group A' : 'Group B',
  }));
  const expected = JSON.stringify([...baseline.buildPriceListAnalogLinks(products)]);
  assert.equal(JSON.stringify([...optimized.buildPriceListAnalogLinks(products)]), expected);
  assert.equal(JSON.stringify([...optimized.buildPriceListAnalogLinks(products)]), expected);
  const changedMembership = products.slice(0, Math.floor(products.length / 2));
  assert.equal(JSON.stringify([...optimized.buildPriceListAnalogLinks(changedMembership)]),
    JSON.stringify([...baseline.buildPriceListAnalogLinks(changedMembership)]), 'Only immutable aliases, not price-list membership, are cached');
});

test('warm lookups reuse immutable aliases instead of normalizing the whole knowledge base again', () => {
  const baseline = load(true);
  const optimized = load();
  const query = 'SYNTHETIC-UNMATCHED-CATALOGUE-MODEL';
  const expected = JSON.stringify(baseline.api.searchAnalogs(query));
  assert.equal(JSON.stringify(optimized.api.searchAnalogs(query)), expected);
  const firstCalls = optimized.calls();
  const baselineBefore = baseline.calls();
  const optimizedBefore = optimized.calls();
  assert.equal(JSON.stringify(optimized.api.searchAnalogs(query)), JSON.stringify(baseline.api.searchAnalogs(query)));
  const legacyRepeatCalls = baseline.calls() - baselineBefore;
  const optimizedRepeatCalls = optimized.calls() - optimizedBefore;
  assert.ok(firstCalls > 1000, 'Cold lookup must initialize the real knowledge-base aliases');
  assert.ok(legacyRepeatCalls > 1000, 'The old path re-normalized aliases on every search');
  assert.ok(optimizedRepeatCalls < 20, `Warm lookup must not re-normalize ${legacyRepeatCalls} immutable aliases`);
});
