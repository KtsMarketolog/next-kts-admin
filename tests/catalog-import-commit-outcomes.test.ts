import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { loadCatalogAdminModule } from './helpers/catalogAdminModule';
import * as helpers from '../src/entities/catalog/api/catalogAdmin/helpers';
import { TransactionCommitUnknownError } from '../src/shared/lib/db/transactionOutcome';

/** Actual import repository with every IO boundary substituted; no production DB. */
function harness(options: { statsFailure?: boolean; transactionFailure?: Error } = {}) {
  const calls: string[] = [];
  let committed = false;
  const stats = { products: 9, activeProducts: 1, categories: 2, subcategories: 3, brands: 4 };
  const core = loadCatalogAdminModule<typeof import('../src/entities/catalog/api/catalogAdmin/core')>({
    './helpers': helpers,
    '@/shared/lib/db': { ensureSiteSchema: async () => { calls.push('site-schema'); } },
    '../catalogDb': { ensureCatalogSchema: async () => { calls.push('catalog-schema'); } },
    '@/shared/lib/db/client': { query: async () => { throw new Error('Unexpected global DB query'); } },
    './productQueries': {},
    './stats': { getCatalogAdminStats: async () => {
      calls.push('stats'); assert.equal(committed, true, 'statistics run only after confirmed commit');
      if (options.statsFailure) throw new Error('Synthetic secret SQL details');
      return stats;
    } },
    './productRowWrites': {
      updateCatalogProductFromImport: async () => { throw new Error('No existing product in fixture'); },
      insertCatalogProduct: async () => { calls.push('insert'); return 13; },
    },
    '@/shared/lib/db/catalogStockWrite': {
      withCatalogStockWrite: async (work: (client: PoolClient) => Promise<unknown>) => {
        calls.push('transaction');
        const result = await work({ query: async () => ({ rows: [] }) } as unknown as PoolClient);
        if (options.transactionFailure) throw options.transactionFailure;
        committed = true; calls.push('commit');
        return result;
      },
    },
  });
  return { core, calls, stats, wasCommitted: () => committed };
}

test('catalog import returns confirmed counts and stats when postcommit read succeeds', async () => {
  const h = harness();
  const result = await h.core.replaceCatalogFromRows([{ article: 'SYN', title: 'Synthetic product' }]);
  assert.deepEqual(result, { saved: true, ...h.stats, importedProducts: 1, syncedWholesaleProducts: 1, warnings: [] });
  assert.deepEqual(h.calls, ['catalog-schema', 'site-schema', 'transaction', 'insert', 'commit', 'stats']);
});

test('catalog stats failure cannot roll back, replay or misreport the committed import as failure', async () => {
  const h = harness({ statsFailure: true });
  const result = await h.core.replaceCatalogFromRows([{ article: 'SYN', title: 'Synthetic product' }]);
  assert.equal(h.wasCommitted(), true); assert.equal(result.saved, true);
  assert.equal(result.importedProducts, 1); assert.equal(result.syncedWholesaleProducts, 1);
  for (const field of ['products', 'activeProducts', 'categories', 'subcategories', 'brands'] as const) {
    assert.equal(result[field], null, `${field}: unavailable statistics must not be fabricated as zero`);
  }
  assert.equal(result.warnings.length, 1); assert.equal(result.warnings[0].code, 'CATALOG_IMPORT_STATS_UNAVAILABLE');
  assert.match(result.warnings[0].message, /сохранён.*статистика.*повторно загружать Excel не нужно/);
  assert.doesNotMatch(JSON.stringify(result), /Synthetic secret/);
  assert.deepEqual(h.calls, ['catalog-schema', 'site-schema', 'transaction', 'insert', 'commit', 'stats']);
});

test('catalog failed or unconfirmed transaction is propagated unchanged without statistics or invented success', async () => {
  for (const failure of [new Error('Synthetic rollback'), new TransactionCommitUnknownError()]) {
    const h = harness({ transactionFailure: failure });
    await assert.rejects(h.core.replaceCatalogFromRows([{ article: 'SYN', title: 'Synthetic product' }]), error => error === failure);
    assert.equal(h.wasCommitted(), false);
    assert.deepEqual(h.calls, ['catalog-schema', 'site-schema', 'transaction', 'insert']);
  }
});
