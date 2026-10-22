import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import * as helpers from '../src/entities/catalog/api/catalogAdmin/helpers';
import { assertCatalogArticleAvailable, CatalogArticleConflictError } from '../src/entities/catalog/api/catalogAdmin/articleUniqueness';
import { catalogProductImportKey } from '../src/entities/catalog/api/catalogAdmin/importMatching';
import { normalizeInput } from '../src/entities/catalog/api/catalogAdmin/productInput';
import { assertUniqueCatalogArticles } from '../src/entities/catalog/api/catalogImportValidation';
import { loadCatalogAdminModule } from './helpers/catalogAdminModule';

const collisions = [
  ['SYN-A', 'syn-a'], ['SYN  CODE', ' syn\tcode '], ['SYN\u00a0CODE', 'SYN CODE'],
  ['СИН-А', 'син-а'], [`${'X'.repeat(120)}A`, `${'x'.repeat(120)}B`],
];

test('manual writes, Excel duplicate validation and import matching use the same persisted SKU identity', () => {
  for (const [existing, candidate] of collisions) {
    assert.equal(helpers.catalogArticleKey(existing), helpers.catalogArticleKey(candidate));
    assert.equal(catalogProductImportKey({ article: existing }), helpers.catalogArticleKey(candidate));
    assert.equal(helpers.catalogArticleKey(normalizeInput({ article: candidate, title: 'Synthetic' }).article), helpers.catalogArticleKey(existing));
    assert.throws(() => assertUniqueCatalogArticles([{ article: existing, title: 'Synthetic' }, { article: candidate, title: 'Synthetic' }]),
      (error: unknown) => (error as { code?: string }).code === 'CATALOG_DUPLICATE_ARTICLES');
  }
  for (const [first, second] of [['0012', '12'], ['A-B', 'AB']]) {
    assert.notEqual(helpers.catalogArticleKey(first), helpers.catalogArticleKey(second));
    assert.doesNotThrow(() => assertUniqueCatalogArticles([{ article: first, title: 'Synthetic' }, { article: second, title: 'Synthetic' }]));
  }
});

function clientFor(articles: Array<{ id: string; article: string | null }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = { query: async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return { rows: articles.filter(row => Number(row.id) !== params[0]) };
  } } as unknown as PoolClient;
  return { client, calls };
}

test('availability includes inactive/legacy articles, excludes only the edited record and never writes', async () => {
  for (const [existing, candidate] of collisions) {
    const { client, calls } = clientFor([{ id: '7', article: existing }]);
    await assert.rejects(assertCatalogArticleAvailable(client, candidate), CatalogArticleConflictError);
    assert.deepEqual(calls[0].params, [null]);
    assert.doesNotMatch(calls[0].sql, /is_active|brand|wholesale|\b(update|insert|delete)\b/i);
    await assert.doesNotReject(assertCatalogArticleAvailable(client, candidate, 7));
    assert.deepEqual(calls[1].params, [7]);
    const duplicate = clientFor([{ id: '7', article: candidate }, { id: '8', article: existing }]);
    await assert.rejects(assertCatalogArticleAvailable(duplicate.client, candidate, 7), CatalogArticleConflictError);
  }
  const { client, calls } = clientFor([]);
  await assert.rejects(assertCatalogArticleAvailable(client, '  '), /Артикул товара обязателен/);
  assert.equal(calls.length, 0);
});

for (const action of ['create', 'update'] as const) {
  test(`${action} checks duplicate identity inside the writer lock before product or related entity mutations`, async () => {
    let locked = false;
    const reads: string[] = [];
    const core = loadCatalogAdminModule<typeof import('../src/entities/catalog/api/catalogAdmin/core')>({
      './helpers': helpers,
      '@/shared/lib/db': { ensureSiteSchema: async () => {} },
      '../catalogDb': { ensureCatalogSchema: async () => {} },
      '@/shared/lib/db/client': { query: async () => { throw new Error('Unexpected global query'); } },
      './productQueries': { getCatalogAdminProductById: async () => { throw new Error('Conflict cannot report saved product'); } },
      '@/shared/lib/db/catalogStockWrite': {
        withCatalogStockWrite: async (run: (client: PoolClient) => Promise<unknown>) => {
          locked = true;
          try {
            return await run({ query: async (sql: string, params: unknown[]) => {
              assert.equal(locked, true);
              assert.doesNotMatch(sql, /\b(update|insert|delete)\b/i, 'Conflicts must reject before any write');
              reads.push(sql);
              if (sql.includes('select id::text, article from catalog_products')) {
                assert.deepEqual(params, [action === 'update' ? 7 : null]);
                return { rows: [{ id: '8', article: 'SYN-A' }] };
              }
              if (action === 'update' && sql.includes('as sort_order')) return { rows: [{ id: '7', sort_order: '0' }] };
              throw new Error('Unexpected query before conflict check');
            } } as unknown as PoolClient);
          } finally { locked = false; }
        },
      },
    });
    const input = { article: ' syn-a ', title: 'Do not write', category: 'Do not create', brand: 'Different brand' };
    await assert.rejects(action === 'create' ? core.createCatalogAdminProduct(input) : core.updateCatalogAdminProduct(7, input),
      (error: unknown) => (error as { code?: string }).code === 'CATALOG_ARTICLE_CONFLICT');
    assert.equal(locked, false);
    assert.equal(reads.length, action === 'create' ? 1 : 2);
  });
}
