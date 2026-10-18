import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import ts from 'typescript';

type SeedModule = typeof import('../src/shared/lib/db/schemaSeeds');
type State = 'pending' | 'complete' | undefined;

function harness(options: {
  relations?: string[];
  state?: State;
  hasContent?: boolean;
  schema?: string | null;
  failInsert?: string;
  missingBrandCategory?: boolean;
} = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const transactionOptions: unknown[] = [];
  let state = options.state;
  let commits = 0;
  let rollbacks = 0;
  let poolCalls = 0;
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql === 'select current_schema() as schema') return { rows: [{ schema: options.schema === undefined ? 'public' : options.schema }] };
      if (sql.includes('from pg_class')) return { rows: (options.relations ?? []).map((relname) => ({ relname })) };
      if (sql.startsWith('select state from')) return { rows: state ? [{ state }] : [] };
      if (sql.includes('create table') && sql.includes('site_content_bootstrap')) state = 'pending';
      if (sql.includes('as has_content')) return { rows: [{ has_content: options.hasContent ?? false }] };
      if (sql === 'select id, key from brand_categories') return { rows: options.missingBrandCategory ? [] : [{ id: '75', key: 'category' }] };
      if (options.failInsert && sql.includes(`insert into ${options.failInsert}`)) throw new Error('injected insert failure');
      if (sql.startsWith('update ') && sql.includes('site_content_bootstrap')) state = 'complete';
      return { rows: [] };
    },
  };
  const modules: Record<string, unknown> = {
    '@/entities/site/model/defaultBrands': {
      DEFAULT_BRAND_CATEGORIES: [{ key: 'category', title: 'Category', sortOrder: 1, isActive: true }],
      DEFAULT_BRAND_ITEMS: [{ categoryKey: 'category', name: 'Brand', imageUrl: '/brand.png', iconKey: '', sortOrder: 1, isActive: true }],
    },
    '@/entities/site/model/defaultGroupCompanies': {
      DEFAULT_GROUP_COMPANIES: [{ imageUrl: '/company.png', linkUrl: '/company', sortOrder: 1, isActive: true }],
    },
    '@/entities/site/model/defaultSlides': {
      DEFAULT_HERO_SLIDES: [{ title: 'Slide', imageUrl: '/slide.png', sortOrder: 1, isActive: true }],
    },
    '@/entities/site/model/defaultNews': {
      DEFAULT_NEWS: [{ title: 'News', date: '01.01.2026', imageUrl: '/news.png', linkUrl: '/news', sortOrder: 1, isActive: true }],
    },
    '../phone': { DEFAULT_PHONE: 'phone', DEFAULT_EMAIL: 'email', DEFAULT_ADDRESS: 'address' },
    './client': {
      async query(sql: string, values: unknown[]) { poolCalls += 1; return client.query(sql, values); },
      async withTransaction(callback: (db: typeof client) => Promise<unknown>, policy: unknown) {
        transactionOptions.push(policy);
        const previousState = state;
        try {
          const result = await callback(client);
          commits += 1;
          return result;
        } catch (error) {
          state = previousState;
          rollbacks += 1;
          throw error;
        }
      },
    },
  };
  const compiled = ts.transpileModule(readFileSync('src/shared/lib/db/schemaSeeds.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  return {
    seeds: loaded.exports as SeedModule,
    calls,
    transactionOptions,
    state: () => state,
    commits: () => commits,
    rollbacks: () => rollbacks,
    poolCalls: () => poolCalls,
  };
}

test('initial content reserves a durable pending marker only in a schema with no relations', async () => {
  const h = harness();
  assert.equal(await h.seeds.reserveInitialSiteContentBootstrap(), 'pending');
  assert.equal(h.state(), 'pending');
  assert.equal(h.commits(), 1);
  assert.equal(h.poolCalls(), 0);
  assert.ok(h.calls[1].sql.includes('pg_advisory_xact_lock'));
  assert.ok(h.calls[2].sql.includes('from pg_class'));
  assert.match(h.calls.at(-1)!.sql, /create table "public"\."site_content_bootstrap"/);
  assert.equal(h.calls.some(({ sql }) => /insert into (hero_slides|news_items|brand_items|group_companies)/.test(sql)), false);
  assert.deepEqual(h.transactionOptions, [{ profile: 'schema', trackCommitOutcome: true, retryOnConflict: true }]);
});

test('existing schema is rejected even if content tables contain no rows', async () => {
  for (const relation of ['hero_slides', 'news_items', 'brand_categories', 'brand_items', 'group_companies', 'site_settings', 'schema_migrations', 'unrelated_table']) {
    const h = harness({ relations: [relation] });
    await assert.rejects(h.seeds.reserveInitialSiteContentBootstrap(), /База уже инициализирована/);
    assert.equal(h.calls.some(({ sql }) => /create table|insert into|update /.test(sql)), false, relation);
    assert.equal(h.rollbacks(), 1);
  }
});

test('pending marker resumes without inferring an installation from content counts', async () => {
  const h = harness({ relations: ['site_content_bootstrap', 'hero_slides'], state: 'pending' });
  assert.equal(await h.seeds.reserveInitialSiteContentBootstrap(), 'pending');
  assert.equal(h.calls.some(({ sql }) => /insert into|create table/.test(sql)), false);
});

test('completed marker makes reservation and completion no-ops after content was deleted', async () => {
  const h = harness({ relations: ['site_content_bootstrap', 'hero_slides'], state: 'complete', hasContent: false });
  assert.equal(await h.seeds.reserveInitialSiteContentBootstrap(), 'complete');
  assert.equal(await h.seeds.completeInitialSiteContentBootstrap(), 'already-complete');
  assert.equal(h.calls.some(({ sql }) => /insert into|create table|update |lock table/.test(sql)), false);
  assert.equal(h.state(), 'complete');
});

test('missing durable authorization cannot seed content', async () => {
  const reserve = harness({ relations: ['site_content_bootstrap'] });
  await assert.rejects(reserve.seeds.reserveInitialSiteContentBootstrap(), /Не найдена сохранённая заявка/);
  const complete = harness();
  await assert.rejects(complete.seeds.completeInitialSiteContentBootstrap(), /не было явно разрешено/);
  assert.equal(complete.calls.some(({ sql }) => /insert into|update |lock table/.test(sql)), false);
});

test('bootstrap refuses a missing current schema before taking locks or writing', async () => {
  const h = harness({ schema: null });
  await assert.rejects(h.seeds.reserveInitialSiteContentBootstrap(), /Не найдена рабочая схема/);
  assert.equal(h.calls.length, 1);
});

test('marker and locks use the current schema as a quoted identifier, not interpolated SQL', async () => {
  const h = harness({ schema: 'new"schema', state: 'pending' });
  assert.equal(await h.seeds.completeInitialSiteContentBootstrap(), 'seeded');
  assert.equal(h.calls[1].values[0], 'kts_initial_site_content:new"schema');
  assert.match(h.calls[2].sql, /"new""schema"\."site_content_bootstrap"/);
  const lock = h.calls.find(({ sql }) => sql.startsWith('lock table'))!;
  for (const table of ['hero_slides', 'news_items', 'brand_categories', 'brand_items', 'group_companies']) {
    assert.ok(lock.sql.includes(`"new""schema"."${table}"`));
  }
});

test('reservation looks up mixed-case and quoted schema names as exact namespace text', async () => {
  for (const schema of ['MixedCase', 'new"schema']) {
    const h = harness({ schema });
    assert.equal(await h.seeds.reserveInitialSiteContentBootstrap(), 'pending');
    const lookup = h.calls.find(({ sql }) => sql.includes('from pg_class'))!;
    assert.match(lookup.sql, /select oid from pg_namespace where nspname = \$1/);
    assert.doesNotMatch(lookup.sql, /regnamespace/);
    assert.deepEqual(lookup.values, [schema]);
  }
});

test('completion inserts every content family and marks complete in one transaction', async () => {
  const h = harness({ state: 'pending' });
  assert.equal(await h.seeds.completeInitialSiteContentBootstrap(), 'seeded');
  assert.equal(h.commits(), 1);
  assert.equal(h.poolCalls(), 0);
  const lockIndex = h.calls.findIndex(({ sql }) => sql.startsWith('lock table'));
  const guardIndex = h.calls.findIndex(({ sql }) => sql.includes('as has_content'));
  const inserts = h.calls.map(({ sql }, index) => ({ sql, index })).filter(({ sql }) => sql.includes('insert into'));
  assert.equal(inserts.length, 5);
  assert.ok(lockIndex >= 0 && lockIndex < guardIndex && inserts.every(({ index }) => index > guardIndex));
  assert.match(h.calls.at(-1)!.sql, /update "public"\."site_content_bootstrap" set state = 'complete'/);
  const brandInsert = h.calls.find(({ sql }) => sql.includes('insert into brand_items'))!;
  assert.equal(brandInsert.values[0], 75);
  assert.equal(h.state(), 'complete');
});

test('pending bootstrap refuses any existing content without inserts or marker completion', async () => {
  const h = harness({ state: 'pending', hasContent: true });
  await assert.rejects(h.seeds.completeInitialSiteContentBootstrap(), /уже есть контент/);
  assert.equal(h.calls.some(({ sql }) => /insert into|update /.test(sql)), false);
  assert.equal(h.state(), 'pending');
  assert.equal(h.rollbacks(), 1);
});

test('insert failure rejects the whole transaction and leaves authorization pending for safe retry', async () => {
  for (const failInsert of ['hero_slides', 'news_items', 'brand_categories', 'brand_items', 'group_companies']) {
    const h = harness({ state: 'pending', failInsert });
    await assert.rejects(h.seeds.completeInitialSiteContentBootstrap(), /injected insert failure/);
    assert.equal(h.commits(), 0);
    assert.equal(h.rollbacks(), 1);
    assert.equal(h.state(), 'pending');
    assert.equal(h.calls.some(({ sql }) => sql.startsWith('update ')), false);
  }
});

test('missing seeded category aborts instead of silently omitting brands', async () => {
  const h = harness({ state: 'pending', missingBrandCategory: true });
  await assert.rejects(h.seeds.completeInitialSiteContentBootstrap(), /Не найдена категория/);
  assert.equal(h.rollbacks(), 1);
  assert.equal(h.state(), 'pending');
});

test('normal settings seed stays insert-if-missing and cannot recreate content', async () => {
  const h = harness();
  await h.seeds.seedSiteSettings();
  assert.equal(h.poolCalls(), 2);
  assert.equal(h.transactionOptions.length, 0);
  assert.ok(h.calls.every(({ sql }) => sql.includes('insert into site_settings') && sql.includes('on conflict (key) do nothing')));
  assert.deepEqual(Object.keys(h.seeds).sort(), ['completeInitialSiteContentBootstrap', 'reserveInitialSiteContentBootstrap', 'seedSiteSettings']);
});

test('bootstrap CLI refuses missing or extra confirmation flags before contacting DATABASE_URL', () => {
  for (const args of [[], ['--confirm-initial-content', '--force'], ['--force']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed-site-content.ts', ...args], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: 'postgres://invalid:invalid@127.0.0.1:1/never_connect' }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Только для новой установки/);
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|postgres:\/\//);
  }
});

test('bootstrap CLI requires an explicitly selected database instead of loading local environment files', () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed-site-content.ts', '--confirm-initial-content'], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Укажите DATABASE_URL новой пустой БД явно/);
});
