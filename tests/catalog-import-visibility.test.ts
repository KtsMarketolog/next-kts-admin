import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { loadCatalogAdminModule } from './helpers/catalogAdminModule';
import * as helpers from '../src/entities/catalog/api/catalogAdmin/helpers';
import type { NormalizedCatalogProductInput } from '../src/entities/catalog/api/catalogAdmin/productInput';
import type { CatalogProductInput } from '../src/entities/catalog/api/catalogAdmin/types';

const product = (article: string): CatalogProductInput => ({ article, title: article, priceRub: '100' });

test('catalog replacement never writes saved price selections, including an absent and returning SKU', async () => {
  const products = [
    { id: 1, article: 'STAYS', active: true, wholesaleActive: true },
    { id: 2, article: 'RETURNS', active: true, wholesaleActive: true },
  ];
  const statements: string[] = [];
  const core = loadCatalogAdminModule<typeof import('../src/entities/catalog/api/catalogAdmin/core')>({
    './helpers': helpers,
    '@/shared/lib/db': { ensureSiteSchema: async () => {} },
    '../catalogDb': { ensureCatalogSchema: async () => {} },
    '@/shared/lib/db/client': { query: async () => { throw new Error('Unexpected global DB query'); } },
    './productQueries': {},
    './stats': { getCatalogAdminStats: async () => ({ products: products.length, activeProducts: products.filter(row => row.active).length }) },
    './productRowWrites': {
      updateCatalogProductFromImport: async (_client: unknown, _cache: unknown, id: number, row: NormalizedCatalogProductInput) => {
        const stored = products.find(item => item.id === id)!;
        stored.active = row.isActive;
        stored.wholesaleActive = row.isActive;
      },
      insertCatalogProduct: async () => { throw new Error('Returning SKU must reuse its existing identity'); },
    },
    '@/shared/lib/db/catalogStockWrite': {
      withCatalogStockWrite: async (work: (client: PoolClient) => Promise<unknown>) => work({
        query: async (sql: string, values?: unknown[]) => {
          statements.push(sql);
          assert.doesNotMatch(sql, /\b(?:update|insert\s+into|delete\s+from)\s+wholesale_price_list_items\b/i,
            'Catalog import must not overwrite the manager selection or settings of saved price positions');
          if (sql.includes('from catalog_products p') && sql.includes('order by p.is_active')) {
            return { rows: products.map(row => ({ id: String(row.id), article: row.article, title: row.article, sort_order: '0' })) };
          }
          if (/update\s+(catalog_products|wholesale_products)\s+set is_active = false/.test(sql)) {
            for (const row of products) {
              if ((values?.[0] as number[]).includes(row.id)) continue;
              if (sql.includes('update catalog_products')) row.active = false;
              else row.wholesaleActive = false;
            }
          }
          return { rows: [] };
        },
      } as unknown as PoolClient),
    },
  });

  await core.replaceCatalogFromRows([product('STAYS'), product('RETURNS')]);
  await core.replaceCatalogFromRows([product('STAYS')]);
  assert.deepEqual(products.map(({ active, wholesaleActive }) => [active, wholesaleActive]), [[true, true], [false, false]]);
  await core.replaceCatalogFromRows([product('STAYS'), product('RETURNS')]);
  assert.deepEqual(products.map(({ active, wholesaleActive }) => [active, wholesaleActive]), [[true, true], [true, true]]);
  assert.equal(products.length, 2);
  assert.doesNotMatch(statements.join('\n'), /wholesale_price_list_items/,
    'Availability changes need neither saved-position writes nor parent-price locks');
});
