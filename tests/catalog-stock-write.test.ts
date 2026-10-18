import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as helpers from '../src/entities/catalog/api/catalogAdmin/helpers';
import { loadCatalogAdminModule } from './helpers/catalogAdminModule';

function load<T>(filename: string, dependencies: Record<string, unknown>): T {
  const code = ts.transpileModule(readFileSync(new URL(filename, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in dependencies, `Unexpected IO dependency: ${name}`);
    return dependencies[name];
  }, loaded, loaded.exports);
  return loaded.exports as T;
}

function harness(repeatImport = false) {
  const attempts: string[][] = [];
  const policies: unknown[] = [];
  let transactionStatements: string[] | undefined;
  const query = async (sql: string, params: unknown[] = []) => {
    if (transactionStatements) {
      transactionStatements.push(sql);
      if (transactionStatements.length === 1) {
        assert.match(sql, /pg_advisory_xact_lock/);
        assert.deepEqual(params, ['kts-catalog-stock-write']);
      }
    }
    if (/^\s*select 1 from/.test(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes('from catalog_products p') && sql.includes('order by p.is_active')) {
      return { rows: [{ id: '1', title: 'Synthetic product', article: 'SYN', sort_order: '0' }], rowCount: 1 };
    }
    return { rows: [{ id: '1', count: '1', sort_order: '0' }], rowCount: 1 };
  };
  const database = {
    query,
    async withTransaction<T>(callback: (client: { query: typeof query }) => Promise<T>, options: { profile: string }) {
      policies.push(options);
      let result!: T;
      const count = repeatImport && options.profile === 'import' ? 2 : 1;
      for (let attempt = 0; attempt < count; attempt += 1) {
        transactionStatements = [];
        attempts.push(transactionStatements);
        try { result = await callback({ query }); }
        finally { transactionStatements = undefined; }
      }
      return result;
    },
  };
  const gate = load<typeof import('../src/shared/lib/db/catalogStockWrite')>('../src/shared/lib/db/catalogStockWrite.ts', {
    '@/shared/lib/db/client': database,
  });
  const core = loadCatalogAdminModule<typeof import('../src/entities/catalog/api/catalogAdmin/core')>({
    '@/shared/lib/db/client': database,
    '@/shared/lib/db/catalogStockWrite': gate,
    '@/shared/lib/db': { ensureSiteSchema: async () => {} },
    '../catalogDb': { ensureCatalogSchema: async () => {} },
    './helpers': helpers,
    './productQueries': { getCatalogAdminProductById: async (id: number) => ({ id }) },
  });
  return { attempts, policies, core, gate };
}

const product = { title: 'Synthetic product', article: 'SYN', category: 'Synthetic category', brand: 'Synthetic brand', subcategory: 'Synthetic subcategory' };

for (const action of ['create', 'edit', 'delete', 'import'] as const) {
  test(`catalog ${action} joins the common gate before any transactional reads or writes`, async () => {
    const h = harness();
    if (action === 'create') await h.core.createCatalogAdminProduct(product);
    if (action === 'edit') await h.core.updateCatalogAdminProduct(1, product);
    if (action === 'delete') await h.core.deleteCatalogAdminProduct(1);
    if (action === 'import') await h.core.replaceCatalogFromRows([product]);
    assert.equal(h.attempts.length, 1);
    assert.deepEqual(h.policies, [{ profile: action === 'import' ? 'import' : 'interactive', retryOnConflict: true, trackCommitOutcome: true }]);
    const statements = h.attempts[0];
    const catalogWrite = statements.findIndex((sql) => /(?:insert into|update|delete from) catalog_products\b/.test(sql));
    const wholesaleWrite = statements.findIndex((sql) => /(?:insert into|update) wholesale_products\b/.test(sql));
    assert.ok(catalogWrite > 0 && wholesaleWrite > catalogWrite, 'catalog product is always written before wholesale product');
    assert.ok(!statements.some((sql) => /delete from wholesale_(?:products|price_list_items|price_lists)/.test(sql)), 'price-list items and settings are not removed');
  });
}

test('retrying a catalog import rebuilds entity caches and matches existing products anew', async () => {
  const h = harness(true);
  await h.core.replaceCatalogFromRows([product]);
  assert.equal(h.attempts.length, 2);
  assert.deepEqual(h.attempts[1], h.attempts[0], 'each attempt must repeat entity lookup/update SQL, not reuse rolled-back cache IDs');
});

test('catalog schema uses the same gate and retries initialization after failure', async () => {
  const saved = globalThis.__ktsCatalogSchemaReady;
  delete globalThis.__ktsCatalogSchemaReady;
  const profiles: string[] = [];
  let calls = 0;
  const schema = load<typeof import('../src/entities/catalog/api/catalogDb')>('../src/entities/catalog/api/catalogDb.ts', {
    '@/shared/lib/db/catalogStockWrite': {
      async withCatalogStockWrite(callback: (client: { query: (sql: string) => Promise<void> }) => Promise<void>, profile: string) {
        profiles.push(profile);
        return callback({ query: async (sql) => {
          assert.match(sql, /create table if not exists catalog_categories/);
          calls += 1;
          if (calls === 1) throw new Error('synthetic schema conflict');
        } });
      },
    },
  });
  try {
    await assert.rejects(schema.ensureCatalogSchema(), /synthetic schema conflict/);
    await Promise.all([schema.ensureCatalogSchema(), schema.ensureCatalogSchema()]);
    await schema.ensureCatalogSchema();
    assert.equal(calls, 2, 'successful DDL runs once per worker, not once per import/read');
    assert.deepEqual(profiles, ['schema', 'schema']);
  } finally { globalThis.__ktsCatalogSchemaReady = saved; }
});
