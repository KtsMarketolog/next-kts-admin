import assert from 'node:assert/strict';
import test from 'node:test';

import { getSanhuaKnowledgeCandidates } from '../src/shared/lib/analogs';
import {
  filterSanhuaCandidates,
  getSanhuaEligibleCandidates,
  getSanhuaTableOptions,
  SANHUA_INCOMPLETE_BLOCKS,
  sanhuaSpecificationKey,
  type SanhuaSelectionCandidate,
} from '../src/shared/lib/sanhuaSelection';

function candidate(overrides: Partial<SanhuaSelectionCandidate> = {}): SanhuaSelectionCandidate {
  return {
    id: 'sight-137', brand: 'Sanhua (новая)', model: 'SYJ06H51', category: 'Смотровые стекла', sourceFlagged: false,
    technicalSpecifications: [
      { label: 'Размер (дюймы)', value: '1/4', unit: 'дюйм' },
      { label: 'Соединение / исполнение', value: 'Мама-мама' },
    ],
    sourceLabel: 'Sanhua', sourceFileName: 'CROSS SANHUA 19_08_2026 (1).xls', sourceSheet: 'Лист1', sourceRow: 137, note: null,
    catalogMatches: [{ productId: 12, title: 'SYJ06H51 Стекло смотровое', sku: 'ЦБ-00001990', model: 'SYJ06H51', stock: 0, stockMoscow: 0, stockVolzhsk: 0, unit: 'шт.', isExpected: false }],
    ...overrides,
  };
}

test('guided reference accepts documented rows in our catalogue even at zero stock', () => {
  const item = candidate();
  assert.deepEqual(getSanhuaEligibleCandidates([item]), [item]);
});

test('guided reference excludes competitor, conflicting, missing-size and missing-execution rows', () => {
  assert.equal(getSanhuaEligibleCandidates([
    candidate({ brand: 'Becool' }), candidate({ sourceFlagged: true }), candidate({ catalogMatches: [] }),
    candidate({ technicalSpecifications: [{ label: 'Соединение / исполнение', value: 'Мама-мама' }] }),
    candidate({ technicalSpecifications: [{ label: 'Размер (дюймы)', value: '1/4', unit: 'дюйм' }] }),
    candidate({ technicalSpecifications: [{ label: 'Размер (дюймы)', value: 'не указано' }, { label: 'Соединение / исполнение', value: '—' }] }),
  ]).length, 0);
});

test('model text never supplies missing parameters or overrides a conflicting row', () => {
  const item = candidate({ model: 'SYJ06H51 1/4 Мама-мама', technicalSpecifications: [] });
  assert.deepEqual(filterSanhuaCandidates([item], { familyId: 'sight-glasses', query: 'SYJ06H51' }), []);
  const conflicting = candidate({ technicalSpecifications: [...candidate().technicalSpecifications, { label: 'Размер (дюймы)', value: '3/8', unit: 'дюйм' }] });
  assert.equal(getSanhuaEligibleCandidates([conflicting]).length, 0);
});

test('inch and metric filters are explicit and never converted into equivalent dimensions', () => {
  const imperial = candidate();
  const metric = candidate({ id: 'metric', technicalSpecifications: [
    { label: 'Размер (метрика)', value: '6', unit: 'мм' }, { label: 'Соединение / исполнение', value: 'Мама-мама' },
  ] });
  const options = getSanhuaTableOptions([imperial, metric], 'sight-glasses');
  assert.equal(options.sizes.length, 2);
  assert.deepEqual(filterSanhuaCandidates([imperial, metric], { familyId: 'sight-glasses', size: sanhuaSpecificationKey(imperial.technicalSpecifications[0]) }), [imperial]);
  assert.deepEqual(filterSanhuaCandidates([imperial, metric], { familyId: 'sight-glasses', size: 'unknown' }), []);
});

test('known-model lookup supports catalog article and spacing, but keeps execution exact', () => {
  const item = candidate();
  assert.deepEqual(filterSanhuaCandidates([item], { familyId: 'sight-glasses', query: 'SYJ 06 H51' }), [item]);
  assert.deepEqual(filterSanhuaCandidates([item], { familyId: 'sight-glasses', query: 'ЦБ 00001990' }), [item]);
  assert.deepEqual(filterSanhuaCandidates([item], { familyId: 'sight-glasses', execution: 'Папа-папа' }), []);
});

test('incomplete methodology families do not become parameter selection candidates', () => {
  assert.equal(getSanhuaEligibleCandidates([candidate({ category: 'ТРВ' }), candidate({ category: 'Фильтры разборные' })]).length, 0);
  assert.deepEqual(filterSanhuaCandidates([candidate()], { familyId: '' }), []);
  assert.deepEqual(SANHUA_INCOMPLETE_BLOCKS.map((entry) => entry.category), ['Фильтры разборные', 'ТРВ']);
});

test('contradictory duplicate source rows cannot present the same model with two dimensions', () => {
  const first = candidate();
  const second = candidate({ id: 'sight-other', brand: 'Sanhua (старая)', model: 'SYJ 06 H51', sourceRow: 138,
    technicalSpecifications: [
      { label: 'Размер (дюймы)', value: '3/8', unit: 'дюйм' },
      { label: 'Соединение / исполнение', value: 'Мама-мама' },
    ],
  });
  assert.deepEqual(getSanhuaEligibleCandidates([first, second]), []);
  assert.deepEqual(getSanhuaTableOptions([first, second], 'sight-glasses').sizes, []);
});

test('an incomplete duplicate does not hide contradictory explicit information from eligibility checks', () => {
  const complete = candidate();
  const incomplete = candidate({ id: 'incomplete', technicalSpecifications: [
    { label: 'Размер (дюймы)', value: '3/8', unit: 'дюйм' },
  ] });
  assert.deepEqual(getSanhuaEligibleCandidates([complete, incomplete]), []);
  const matchingIncomplete = candidate({ id: 'same-partial', technicalSpecifications: [complete.technicalSpecifications[0]] });
  assert.deepEqual(getSanhuaEligibleCandidates([complete, matchingIncomplete]), [complete]);
});

test('current source data never falls back to incomplete legacy Sanhua rows in the wizard', () => {
  // A synthetic catalogue match isolates source eligibility; no live catalogue or database is read.
  const sourceRows = getSanhuaKnowledgeCandidates().map((row) => ({ ...row, catalogMatches: candidate().catalogMatches }));
  const eligible = getSanhuaEligibleCandidates(sourceRows);
  assert.ok(eligible.length > 0);
  const eligibleIds = new Set(eligible.map((row) => row.id));
  assert.ok(sourceRows.filter((row) => eligibleIds.has(row.id)).every((row) => row.sourceId === 'sanhua_202608'));
  assert.ok(!eligible.some((row) => row.model === 'YCVSH3H02' && row.sourceRow === 9));
});
