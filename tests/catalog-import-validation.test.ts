import assert from 'node:assert/strict';
import test from 'node:test';

import type { CatalogProductInput } from '../src/entities/catalog/api/catalogAdmin/types';
import {
  assertUniqueCatalogArticles,
  CatalogImportDuplicateError,
  setCatalogImportSourceRow,
} from '../src/entities/catalog/api/catalogImportValidation';

function product(article?: string | null, brand = 'Synthetic'): CatalogProductInput {
  return { article, title: 'Synthetic product', brand };
}

function duplicateError(rows: CatalogProductInput[]) {
  try {
    assertUniqueCatalogArticles(rows);
    assert.fail('Expected duplicate article rejection');
  } catch (error) {
    assert.ok(error instanceof CatalogImportDuplicateError);
    assert.equal(error.code, 'CATALOG_DUPLICATE_ARTICLES');
    assert.match(error.message, /Каталог не изменён/);
    return error;
  }
}

test('catalog duplicate keys use persisted normalization, case and whitespace, not brand or row identity', () => {
  for (const rows of [
    [product('ABC'), product('ABC')],
    [product('ABC', 'First brand'), product('abc', 'Other brand')],
    [product(' AB\t\u00a0C '), product('ab c')],
    [product(`${'A'.repeat(120)}first`), product(`${'a'.repeat(120)}second`)],
    [product(`${'A'.repeat(119)} x`), product('a'.repeat(119))],
  ]) {
    const error = duplicateError(rows);
    assert.equal(error.duplicateCount, 1);
    assert.deepEqual(error.duplicates[0].rows, [1, 2]);
    assert.equal(error.duplicates[0].totalRows, 2);
    assert.equal(error.truncated, false);
  }
  const repeatedReference = product('SAME');
  assert.equal(duplicateError([repeatedReference, repeatedReference]).duplicateCount, 1);
});

test('catalog unique articles retain leading zeroes and blank article inputs do not collide', () => {
  assert.doesNotThrow(() => assertUniqueCatalogArticles([
    product('0012'), product('12'), product('00012'), product('A B'), product('AB'),
    product(''), product(' \t\n'), product(null), product(),
  ]));
});

test('catalog worksheet source rows survive filtering without adding product properties', () => {
  const first = product('ABC');
  const second = product('abc');
  const before = { ...first };
  assert.equal(setCatalogImportSourceRow(first, 15), first);
  setCatalogImportSourceRow(second, 48);
  assert.deepEqual(first, before);
  assert.equal(JSON.stringify(first), JSON.stringify(before));
  const error = duplicateError([first, second]);
  assert.deepEqual(error.duplicates, [{ article: 'ABC', rows: [15, 48], totalRows: 2 }]);
  assert.match(error.message, /строках 15 и 48/);
});

test('catalog duplicate detail caps never truncate validation or total duplicate counts', () => {
  const rows = Array.from({ length: 102 }, (_, group) =>
    Array.from({ length: group === 0 ? 105 : 2 }, () => product(`GROUP-${group}`)),
  ).flat();
  const error = duplicateError(rows);
  assert.equal(error.duplicateCount, 102);
  assert.equal(error.duplicates.length, 100);
  assert.equal(error.duplicates[0].rows.length, 100);
  assert.equal(error.duplicates[0].totalRows, 105);
  assert.equal(error.duplicates.at(-1)?.article, 'GROUP-99');
  assert.equal(error.truncated, true);
});

test('catalog row detail truncation is reported even for a single conflicting article', () => {
  const error = duplicateError(Array.from({ length: 101 }, () => product('SINGLE')));
  assert.equal(error.duplicateCount, 1);
  assert.equal(error.duplicates[0].totalRows, 101);
  assert.equal(error.duplicates[0].rows.length, 100);
  assert.equal(error.truncated, true);
});

test('catalog duplicates remain detectable after many distinct articles and bounded detail limits', () => {
  const rows = Array.from({ length: 2_000 }, (_, index) => product(`UNIQUE-${index}`));
  rows.push(product('UNIQUE-1999'));
  const error = duplicateError(rows);
  assert.deepEqual(error.duplicates, [{ article: 'UNIQUE-1999', rows: [2000, 2001], totalRows: 2 }]);
  assert.equal(error.duplicateCount, 1);
  assert.equal(error.truncated, false);
});
