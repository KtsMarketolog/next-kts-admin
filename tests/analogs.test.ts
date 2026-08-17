import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANALOG_KNOWLEDGE_STATS,
  buildPriceListAnalogLinks,
  normalizeAnalogTerm,
  searchAnalogs,
  searchAnalogsForCatalogProduct,
} from '../src/shared/lib/analogs';

test('knowledge base contains all five imported source families', () => {
  assert.ok(ANALOG_KNOWLEDGE_STATS.directGroups > 300);
  assert.ok(ANALOG_KNOWLEDGE_STATS.directItems > 1_000);
  assert.equal(ANALOG_KNOWLEDGE_STATS.compressorSeries, 13);
  assert.ok(ANALOG_KNOWLEDGE_STATS.compressorItems > 1_000);
});

test('normalization ignores punctuation, case and visually equivalent separators', () => {
  assert.equal(normalizeAnalogTerm(' YWF.A4S-350S-5DIA00 '), normalizeAnalogTerm('ywf a4s 350s 5dia00'));
});

test('direct axial fan lookup returns models from the same group and its source', () => {
  const response = searchAnalogs('YWF.A2S-200S-5DIA00');
  assert.ok(response.results.some((result) => result.model === 'YWF2E-200S-92/15-G'));
  assert.ok(response.results.every((result) => result.sourceId === 'axial'));
});

test('catalog article resolves to the canonical full model before analog lookup', () => {
  const product = {
    title: 'ВЕНТИЛЯТОР ОСЕВОЙ YDWF102L35P4-570N-500S',
    model: 'YDWF102L35P4-570N-500',
    sku: 'ЦБ-Ц0052206',
  };
  const response = searchAnalogsForCatalogProduct(product.sku, product);

  assert.equal(response.query, product.sku);
  assert.deepEqual(response.matches.map((match) => match.model), ['YDWF102L35P4-570N-500S']);
  assert.deepEqual(
    response.results.map((result) => result.model).sort(),
    ['YWF.A4S-500S-5DIA00', 'YWF4E-500S-137/35-G'].sort(),
  );
});

test('catalog product prevents a shortened model from merging S and B variants', () => {
  const product = {
    title: 'ВЕНТИЛЯТОР ОСЕВОЙ YDWF102L35P4-570N-500S',
    model: 'YDWF102L35P4-570N-500',
    sku: 'ЦБ-Ц0052206',
  };
  const response = searchAnalogsForCatalogProduct(product.model, product);

  assert.equal(response.total, 2);
  assert.deepEqual(response.matches.map((match) => match.model), ['YDWF102L35P4-570N-500S']);
});

test('fan cross-reference always returns the mandatory source notice', () => {
  const response = searchAnalogs('S4E350AN1943');
  assert.ok(response.results.some((result) => result.model === 'YWF.A4S-350S-5DIA00'));
  assert.ok(response.notices.some((notice) => notice.includes('не являются абсолютно взамозаменяемыми')));
});

test('ambiguous compressor model asks for refrigerant before capacity matching', () => {
  const response = searchAnalogs('NEK6210Z');
  assert.equal(response.requiresRefrigerant, true);
  assert.deepEqual(response.availableRefrigerants, ['R134a', 'R290']);
  assert.equal(response.results.length, 0);

  const selected = searchAnalogs('NEK6210Z', 'R290');
  assert.equal(selected.requiresRefrigerant, false);
  assert.ok(selected.results.length > 0);
  assert.ok(selected.results.every((result) => result.refrigerant === 'R290'));
  assert.ok(selected.results.every((result) => Math.abs(result.capacityDifferencePercent ?? 0) <= 10));
});

test('scroll compressor matching keeps the five-percent tolerance', () => {
  const response = searchAnalogs('YH95C1-100');
  const scrollResults = response.results.filter((result) => result.sourceId === 'scroll');
  assert.ok(scrollResults.length > 0);
  assert.ok(scrollResults.every((result) => Math.abs(result.capacityDifferencePercent ?? 0) <= 5));
});

test('price-list analog links point only to products present in the same price list', () => {
  const links = buildPriceListAnalogLinks([
    { id: 1, title: 'Dunli fan', sku: '', model: 'YWF.A2S-200S-5DIA00', priceGroup: 'Вентиляторы' },
    { id: 2, title: 'Weiguang fan', sku: '', model: 'YWF2E-200S-92/15-G', priceGroup: 'Вентиляторы' },
    { id: 3, title: 'Unrelated', sku: 'UNKNOWN', model: '', priceGroup: 'Другое' },
  ]);

  assert.deepEqual(links.get(1)?.map((link) => link.productId), [2]);
  assert.deepEqual(links.get(2)?.map((link) => link.productId), [1]);
  assert.equal(links.has(3), false);
});

test('price-list analog links include compressor models that occur with several refrigerants', () => {
  const r290 = searchAnalogs('NEK6210Z', 'R290');
  const analog = r290.results[0];
  assert.ok(analog);

  const links = buildPriceListAnalogLinks([
    { id: 10, title: 'Embraco NEK6210Z', sku: '', model: 'NEK6210Z', priceGroup: 'Компрессоры' },
    { id: 11, title: analog.displayName, sku: '', model: analog.model, priceGroup: 'Компрессоры' },
  ]);

  assert.ok(links.get(10)?.some((link) => link.productId === 11));
});
