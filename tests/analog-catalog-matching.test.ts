import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as matching from '../src/shared/lib/analogCatalogMatching';
import { getAnalogStockMatches } from '../src/shared/lib/db/analogStockRepo';
import type { AnalogCatalogProduct } from '../src/shared/lib/db/analogCatalogRepo';

const { createAnalogCatalogIndex, matchAnalogCatalogProducts, findCatalogSearchProducts, normalizeAnalogBrand } = matching;
function product(id: number, patch: Partial<AnalogCatalogProduct> = {}): AnalogCatalogProduct {
  return { id, brand: 'Secop', model: '', title: 'Компрессор SC 18 CLX.2 104L2197 (117U6013, 117U5012, 118-1917, 103N9100, 103N9111)',
    sku: `SKU-${id}`, stock: 0, stockVolzhsk: 0, stockMoscow: 0, unit: 'шт.', isExpected: false, ...patch };
}

test('print-name model spacing and punctuation resolve without consuming the following product codes', () => {
  const matches = matchAnalogCatalogProducts({ brand: 'Secop', model: 'sc18 clx 2' }, createAnalogCatalogIndex([product(1)]));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].matchedBy, 'title');
  assert.equal(matches[0].matchKind, 'normalized-span');
});

test('model digits, attached suffixes and Cyrillic letters are not silently merged', () => {
  const products = [
    'Компрессор SC18CLX20', 'Компрессор XSC18CLX2', 'Компрессор SC18CLX2-A',
    'Компрессор SC18CLX2/3', 'Компрессор SС18CLX2', 'Компрессор SC18CLX2S',
  ].map((title, index) => product(index + 1, { title }));
  assert.deepEqual(matchAnalogCatalogProducts({ brand: 'Secop', model: 'SC18CLX2' }, createAnalogCatalogIndex(products)), []);
});

test('a shortened catalog model cannot override a longer print-title modification', () => {
  const index = createAnalogCatalogIndex([product(1, { brand: 'MaEr', model: 'YDWF102L35P4-570N-500', title: 'ВЕНТИЛЯТОР YDWF102L35P4-570N-500S' })]);
  assert.equal(matchAnalogCatalogProducts({ brand: 'MaEr', model: 'YDWF102L35P4-570N-500' }, index).length, 0);
  assert.equal(matchAnalogCatalogProducts({ brand: 'MaEr', model: 'YDWF102L35P4-570N-500S' }, index).length, 1);
});

test('a model mentioned as a parenthetical replacement is not the identity of the sold item', () => {
  const index = createAnalogCatalogIndex([product(1, { brand: 'Sanhua', model: 'NEW-123', title: 'Клапан NEW-123 (аналог OLD-456, 9001234)' })]);
  assert.equal(matchAnalogCatalogProducts({ brand: 'Sanhua', model: 'OLD-456' }, index).length, 0);
  assert.equal(matchAnalogCatalogProducts({ brand: 'Sanhua', model: 'NEW-123' }, index).length, 1);
  assert.equal(matchAnalogCatalogProducts({ brand: 'Sanhua', model: 'DOCUMENTED-789', aliases: ['9001234'] }, index).length, 1);
});

test('brands are part of identity, including when the model field matches exactly', () => {
  const index = createAnalogCatalogIndex([
    product(1, { model: 'SC18CLX2', brand: 'Competitor' }),
    product(2, { model: 'SC18CLX2', brand: '' }),
    product(3, { model: 'SC18CLX2' }),
  ]);
  assert.deepEqual(matchAnalogCatalogProducts({ brand: 'Secop', model: 'SC18CLX2' }, index).map(({ product }) => product.id), [3]);
});

test('known source brand labels resolve but unknown lookalikes are not globally transliterated', () => {
  assert.equal(normalizeAnalogBrand('Sanhua (новая)'), 'sanhua');
  assert.equal(normalizeAnalogBrand('Sanhua (старая)'), 'sanhua');
  assert.equal(normalizeAnalogBrand('Ридан'), normalizeAnalogBrand('Ridan'));
  assert.equal(normalizeAnalogBrand('Сopeland'), normalizeAnalogBrand('Copeland'));
  assert.notEqual(normalizeAnalogBrand('Sаnhua'), normalizeAnalogBrand('Sanhua')); // Cyrillic а is not a curated alias.
  const index = createAnalogCatalogIndex([product(1, { brand: 'Sanhua', model: 'AB-12' })]);
  assert.equal(matchAnalogCatalogProducts({ brand: 'Sanhua (новая)', model: 'AB12' }, index).length, 1);
});

test('multiple catalog SKUs remain distinct, including zero stock and expected stock', () => {
  const index = createAnalogCatalogIndex([
    product(1), product(2, { stock: 7, stockVolzhsk: 2, stockMoscow: 5 }), product(3, { isExpected: true }),
  ]);
  const matches = getAnalogStockMatches([{ id: 'source-1', brand: 'Secop', model: 'SC18CLX2' }], index).get('source-1')!;
  assert.deepEqual(matches.map((item) => [item.productId, item.stock]), [[1, 0], [2, 7], [3, 0]]);
  assert.equal(matches[2].isExpected, true);
  assert.equal(matches[1].stockVolzhsk, 2);
  assert.equal(matches[1].stockMoscow, 5);
});

test('catalog search resolves an exact SKU over incidental title mentions and does not truncate ambiguity', () => {
  const index = createAnalogCatalogIndex([
    product(1, { sku: 'ARTICLE', title: 'Our product' }), product(2, { title: 'Название ARTICLE детали' }),
  ]);
  assert.deepEqual(findCatalogSearchProducts('ARTICLE', index).map((item) => item.id), [1]);
  const many = createAnalogCatalogIndex(Array.from({ length: 30 }, (_, i) => product(i + 1)));
  assert.equal(findCatalogSearchProducts('SC18CLX2', many).length, 30);
});

test('source aliases can match catalog manufacturer codes, with the same brand check', () => {
  const index = createAnalogCatalogIndex([product(1, { brand: 'Danfoss', title: 'Valve', model: '068Z3209' })]);
  assert.equal(matchAnalogCatalogProducts({ brand: 'Danfoss', model: 'TE5', aliases: ['068Z3209'] }, index).length, 1);
  assert.equal(matchAnalogCatalogProducts({ brand: 'Sanhua', model: 'TE5', aliases: ['068Z3209'] }, index).length, 0);
});

test('catalog repository reads the active assortment once, no prices or per-model SQL regexes', async () => {
  const source = readFileSync(new URL('../src/shared/lib/db/analogCatalogRepo.ts', import.meta.url), 'utf8');
  const output = { exports: {} as { getActiveAnalogCatalog: () => Promise<matching.AnalogCatalogIndex<AnalogCatalogProduct>> } };
  const calls: string[] = [];
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (name === '@/shared/lib/analogCatalogMatching') return matching;
    assert.equal(name, './client');
    return { query: async (sql: string) => {
      calls.push(sql);
      return { rows: [{ id: '7', title: 'Valve', sku: 'ABC', model: 'AB-12', brand_title: 'Sanhua', stock: '0', stock_volzhsk: '0', stock_moscow: '0', unit: null, is_expected: true }] };
    } };
  }, output, output.exports);
  const result = await output.exports.getActiveAnalogCatalog();
  assert.equal(calls.length, 1);
  assert.match(calls[0], /where is_active = true/);
  assert.doesNotMatch(calls[0], /price|regexp|stock\s*>|limit\s+\d/i);
  assert.equal(result.entries[0].product.stock, 0);
  assert.equal(result.entries[0].product.isExpected, true);
});
