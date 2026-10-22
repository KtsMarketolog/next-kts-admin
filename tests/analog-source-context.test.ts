import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as catalogMatching from '../src/shared/lib/analogCatalogMatching';

function item(brand: string, model: string, row: number, voltage = '') {
  return { brand, model, displayName: `${brand} ${model}`, aliases: [model], sourceRow: row, sourceFlagged: false,
    metadata: { technicalSpecifications: voltage ? [{ label: 'Напряжение', value: voltage, unit: 'В' }] : [] } };
}
function engine(groups: unknown[]) {
  const source = readFileSync(new URL('../src/shared/lib/analogs.ts', import.meta.url), 'utf8');
  const knowledge = { sources: [{ id: 'test', label: 'Source', fileName: 'source.xlsx', kind: 'direct' }, { id: 'sanhua', label: 'Legacy', fileName: 'old.xls', kind: 'direct' }], directGroups: groups,
    compressorSeries: [], stats: {}, version: 1, generatedAt: 'test' };
  const output = { exports: {} as typeof import('../src/shared/lib/analogs') };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (name === './analogCatalogMatching') return catalogMatching;
    assert.equal(name, '@/shared/data/analogs.generated.json'); return knowledge;
  }, output, output.exports);
  return output.exports;
}
function group(id: string, items: unknown[]) {
  return { id, sourceId: 'test', sourceSheet: 'Sheet1', category: 'Fixture', kind: 'direct', items };
}

test('all source rows are retained before catalog filtering, including rows after the twentieth', () => {
  const api = engine(Array.from({ length: 31 }, (_, row) => group(`row-${row}`, [
    item('Input', 'INPUT-12', row + 1), item('Our brand', `OUTPUT-${row}`, row + 1),
  ])));
  const response = api.searchAnalogs('INPUT-12');
  assert.equal(response.requiresModelSelection, false);
  assert.equal(response.results.length, 31);
  assert.ok(response.results.some((result) => result.model === 'OUTPUT-30'));
  assert.equal(response.matches.length, 31);
});

test('same model label in different brands is not deduplicated', () => {
  const api = engine([group('row-1', [item('Input', 'INPUT-12', 1), item('Brand A', 'SAME-12', 1), item('Brand B', 'SAME-12', 1)])]);
  const response = api.searchAnalogs('INPUT-12');
  assert.deepEqual(response.results.map((result) => result.brand), ['Brand A', 'Brand B']);
});

test('same model in different source rows retains specifications and row attribution', () => {
  const api = engine([
    group('row-1', [item('Input', 'INPUT-12', 1, '220'), item('Our brand', 'SAME-12', 1, '220')]),
    group('row-2', [item('Input', 'INPUT-12', 2, '380'), item('Our brand', 'SAME-12', 2, '380')]),
  ]);
  const response = api.searchAnalogs('INPUT-12');
  assert.deepEqual(response.results.map((result) => [result.sourceRow, result.technicalSpecifications[0].value]), [[1, '220'], [2, '380']]);
  assert.deepEqual(response.matches.map((match) => [match.sourceRow, match.technicalSpecifications![0].value]), [[1, '220'], [2, '380']]);
});

test('same source model in different brands asks for brand, and the chosen brand resolves selection', () => {
  const api = engine([
    group('a', [item('Danfoss', 'SAME-12', 1), item('Our', 'OUR-A12', 1)]),
    group('b', [item('Ридан', 'SAME-12', 2), item('Our', 'OUR-B12', 2)]),
  ]);
  const ambiguous = api.searchAnalogs('SAME-12');
  assert.equal(ambiguous.requiresModelSelection, true);
  assert.deepEqual(ambiguous.results, []);
  const selected = api.searchAnalogs('SAME-12', undefined, 'Ridan');
  assert.equal(selected.requiresModelSelection, false);
  assert.deepEqual(selected.matches.map((match) => match.brand), ['Ридан']);
  assert.deepEqual(selected.results.map((result) => result.model), ['OUR-B12']);
  assert.equal(api.searchAnalogs('SAME-12', undefined, 'unknown').total, 0);
});

test('catalog SKU resolution respects the product brand', () => {
  const api = engine([
    group('a', [item('Danfoss', 'SAME-12', 1), item('Our', 'OUR-A12', 1)]),
    group('b', [item('Ридан', 'SAME-12', 2), item('Our', 'OUR-B12', 2)]),
  ]);
  const selected = api.searchAnalogsForCatalogProduct('SKU-1', { title: 'Valve SAME-12', model: 'SAME-12', sku: 'SKU-1', brand: 'Danfoss' });
  assert.equal(selected.requiresModelSelection, false);
  assert.deepEqual(selected.results.map((result) => result.model), ['OUR-A12']);
});

test('demonstrably generic legacy labels are not interpreted as a unique component model', () => {
  const api = engine([{ ...group('generic', [item('Danfoss', 'Клап. узел', 1), item('Sanhua', 'REAL-12', 1)]), sourceId: 'sanhua' }]);
  assert.equal(api.searchAnalogs('Клап. узел').total, 0);
  assert.equal(api.searchAnalogs('REAL-12').results.some((result) => result.model === 'Клап. узел'), false);
});
