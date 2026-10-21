import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { loadCatalogAdminModule } from './helpers/catalogAdminModule';
import * as helpers from '../src/entities/catalog/api/catalogAdmin/helpers';
import { normalizeInput } from '../src/entities/catalog/api/catalogAdmin/productInput';
import { assertUnambiguousCatalogImportMatches, CatalogExistingArticleConflictError, catalogProductImportKey,
  getExistingCatalogProducts } from '../src/entities/catalog/api/catalogAdmin/importMatching';
import type { CatalogProductInput } from '../src/entities/catalog/api/catalogAdmin/types';

type StoredProduct = { id: string; article: string | null; title: string; sort_order: string };
function harness(stored: StoredProduct[] = []) {
  const effects: string[] = [];
  const transactionQueries: string[] = [];
  const core = loadCatalogAdminModule<typeof import('../src/entities/catalog/api/catalogAdmin/core')>({
    './helpers': helpers,
    '@/shared/lib/db': { ensureSiteSchema: async () => { effects.push('site schema'); } },
    '../catalogDb': { ensureCatalogSchema: async () => { effects.push('catalog schema'); } },
    '@/shared/lib/db/client': { query: async () => { throw new Error('Unexpected global DB query'); } },
    '@/shared/lib/db/catalogStockWrite': {
      withCatalogStockWrite: async (work: (client: { query: (sql: string) => Promise<unknown> }) => Promise<unknown>) => {
        effects.push('locked transaction');
        return work({ query: async (sql: string) => {
          transactionQueries.push(sql);
          if (sql.includes('from catalog_products p') && sql.includes('order by p.is_active')) return { rows: stored, rowCount: stored.length };
          throw new Error('Unexpected write after ambiguous matching');
        } });
      },
    },
    './productQueries': { getCatalogAdminProductById: async () => { throw new Error('Unexpected product read'); } },
  });
  return { core, effects, transactionQueries };
}
const product = (article: string): CatalogProductInput => ({ article, title: `Synthetic ${article}`, brand: 'Synthetic brand', priceRub: '100' });

test('duplicate import rejects the whole original batch before normalization, schema or transaction IO', async () => {
  const h = harness();
  await assert.rejects(h.core.replaceCatalogFromRows([
    product('FIRST'), product('SAME SKU'), { ...product(' same\u00a0sku '), priceRub: 'invalid price', brand: 'Different brand' },
  ]), (error: unknown) => (error as { code?: string }).code === 'CATALOG_DUPLICATE_ARTICLES');
  assert.deepEqual(h.effects, []); assert.deepEqual(h.transactionQueries, []);
});

test('existing duplicate encountered late rejects before writing even the valid prefix', async () => {
  const h = harness([
    { id: '4', article: 'FIRST', title: 'Existing first', sort_order: '0' },
    { id: '8', article: 'Conflict', title: 'Active product', sort_order: '1' },
    { id: '9', article: ' conflict ', title: 'Inactive product', sort_order: '2' },
  ]);
  await assert.rejects(h.core.replaceCatalogFromRows([product('FIRST'), product('CONFLICT')]), (error: unknown) => {
    assert.ok(error instanceof CatalogExistingArticleConflictError || (error as { code?: string }).code === 'CATALOG_EXISTING_DUPLICATE_ARTICLES');
    assert.deepEqual((error as CatalogExistingArticleConflictError).duplicates, [{ article: 'CONFLICT', productIds: [8, 9], totalProducts: 2 }]);
    return true;
  });
  assert.deepEqual(h.effects, ['catalog schema', 'site schema', 'locked transaction']);
  assert.equal(h.transactionQueries.length, 1);
  assert.match(h.transactionQueries[0], /from catalog_products p/);
  assert.doesNotMatch(h.transactionQueries.join('\n'), /\b(?:insert into|update\s|delete from)/i);
});

test('matching uses canonical SKU only, excludes blank legacy title fallback and deduplicates joined wholesale links', async () => {
  assert.equal(catalogProductImportKey({ article: ' Sku\t  1 ' }), 'sku 1');
  assert.equal(catalogProductImportKey({ article: '' }), '');
  assert.equal(catalogProductImportKey({ article: `${'X'.repeat(120)}-suffix` }), 'x'.repeat(120));
  const client = { query: async () => ({ rows: [
    { id: '1', article: null, title: 'NEW-SKU', sort_order: '0' },
    { id: '2', article: 'EXISTING', title: 'Existing name', sort_order: '1' },
    { id: '2', article: 'EXISTING', title: 'Existing name', sort_order: '2' },
  ] }) } as unknown as PoolClient;
  const matches = await getExistingCatalogProducts(client);
  assert.equal(matches.has('new-sku'), false);
  assert.deepEqual(matches.get('existing'), [{ id: 2, sortOrder: 1 }]);
  assert.doesNotThrow(() => assertUnambiguousCatalogImportMatches([normalizeInput(product('EXISTING'))], matches));
});

test('existing conflicts apply only to imported keys and diagnostics are bounded without losing total counts', () => {
  const existing = new Map(Array.from({ length: 30 }, (_, index) => [`key-${index}`,
    Array.from({ length: 40 }, (_, item) => ({ id: index * 100 + item + 1, sortOrder: item }))]));
  assert.doesNotThrow(() => assertUnambiguousCatalogImportMatches([normalizeInput(product('OTHER'))], existing));
  assert.throws(() => assertUnambiguousCatalogImportMatches(Array.from({ length: 30 }, (_, i) => normalizeInput(product(`key-${i}`))), existing), (error: unknown) => {
    assert.ok(error instanceof CatalogExistingArticleConflictError);
    assert.equal(error.duplicateCount, 30); assert.equal(error.duplicates.length, 25); assert.equal(error.truncated, true);
    assert.equal(error.duplicates[0].productIds.length, 20); assert.equal(error.duplicates[0].totalProducts, 40);
    assert.ok(error.message.length < 6000);
    return true;
  });
});
