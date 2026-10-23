import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import ts from 'typescript';
import { loadAnalyticsModule } from './helpers/wholesaleAnalyticsHarness';

function guard() {
  assert.equal(process.env.KTS_ANALYTICS_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_analytics_integration'); assert.equal(url.username, 'analytics_app'); assert.equal(url.password, '');
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-analytics-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55491');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
}

const baseline = JSON.parse(readFileSync(new URL('./fixtures/wholesale-analytics-before-optimization.json', import.meta.url), 'utf8')) as Record<string, string>;
type Plan = { 'Execution Time': number; Plan: { 'Shared Hit Blocks': number; 'Shared Read Blocks': number } };

test('synthetic PostgreSQL analytics parity, measurements and atomic clear epoch', { timeout: 120_000 }, async (t) => {
  guard();
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    assert.equal((await db.query(`select to_regclass('public.wholesale_analytics_events') as existing`)).rows[0].existing, null);
    await db.query(`
      create table site_settings (key text primary key, value text not null, updated_at timestamptz not null default now());
      create table wholesale_managers (id bigint primary key, name text, login text, email text, phone text, role text, is_active boolean, updated_at timestamptz default now());
      create table wholesale_price_lists (id bigint primary key, title text, client_name text, token text, manager_id bigint, valid_until date, workflow_status text, is_active boolean, created_at timestamptz, updated_at timestamptz);
      create table wholesale_price_list_items (id bigint primary key, price_list_id bigint, visible boolean);
      create table wholesale_manager_login_logs (id bigint primary key, manager_id bigint, created_at timestamptz);
      create table wholesale_price_list_events (id bigint primary key, price_list_id bigint, manager_id bigint, owner_manager_id bigint, action text, actor_label text, actor_role text, title_snapshot text, details text, created_at timestamptz);
      create table wholesale_analytics_events (id bigint primary key, price_list_id bigint, manager_id bigint, client_id text, event_type text, actor_type text, session_id text, metadata jsonb, referer text, created_at timestamptz);
      create index on wholesale_analytics_events(manager_id, created_at desc);
      create index on wholesale_analytics_events(price_list_id, created_at desc);
      create index on wholesale_analytics_events(client_id, created_at desc);
      create index on wholesale_analytics_events(event_type, created_at desc);
      create index on wholesale_analytics_events(actor_type, created_at desc);
      create index on wholesale_analytics_events(session_id, created_at desc);
      create index on wholesale_price_list_items(price_list_id);
      create index on wholesale_price_list_events(price_list_id);
      insert into wholesale_managers select g, 'Synthetic ' || g, 'synthetic-' || g, 'test@example.invalid', '', case when g%2=0 then 'manager' else 'support_manager' end, g%3<>0, now() from generate_series(1,20) g;
      insert into wholesale_price_lists select g, case when g%17=0 then '' else 'Price ' || g end,
        case when g%19=0 then ' ' else 'Client ' || (g%13) end, 'test-' || g, case when g%23=0 then null else g%20+1 end,
        case when g%7=0 then null else current_date+(g%30)-15 end, 'sent', g%4<>0, now()-(g%70)*interval '1 day', now()-(g%20)*interval '1 day' from generate_series(1,400) g;
      insert into wholesale_price_list_items select g, g%400+1, g%3<>0 from generate_series(1,1200) g;
      insert into wholesale_price_list_events select g,g%400+1,g%20+1,g%20+1,'edit',case when g%2=0 then '' else 'Synthetic' end,'manager','','',now()-(g%50)*interval '1 day' from generate_series(1,400) g;
      insert into wholesale_analytics_events
        select g, case when g%199=0 then null else g%400+1 end, case when g%31=0 then null else g%20+1 end, 'client-' || (g%13),
        (array['public_price_opened','public_price_reopened','public_price_pdf_downloaded','public_price_excel_downloaded','public_price_request_sent','public_price_phone_clicked','price_updated','manager_login','public_price_product_opened','public_price_quantity_changed'])[(g/400)%10+1],
        case when g%11=0 then 'admin' when g%13=0 then 'manager' else 'client' end,
        case when g%9=0 then null when g%8=0 then '' else 'session-' || (g%27) end,
        '{"productTitle":"Synthetic product","items":[{"productTitle":"Synthetic product"}]}'::jsonb, '',
        now() - (((g/400)%80)-2)*interval '1 day' - (g%1440)*interval '1 minute'
        from generate_series(1,60000) g;
      analyze;
    `);
    // One snapshot fixes now() for all boundary/period comparisons.
    await db.query('begin isolation level repeatable read');
    const admin = loadAnalyticsModule<typeof import('../src/shared/lib/db/wholesaleAdminRepo/analytics/adminReads')>('analytics/adminReads', (sql, params) => db.query(sql, params));
    const manager = loadAnalyticsModule<typeof import('../src/shared/lib/db/wholesaleAdminRepo/analytics/managerExtendedReads')>('analytics/managerExtendedReads', (sql, params) => db.query(sql, params));
    const supplemental = loadAnalyticsModule<typeof import('../src/shared/lib/db/wholesaleAdminRepo/analytics/supplementalReads')>('analytics/supplementalReads', (sql, params) => db.query(sql, params));
    for (const timezone of ['UTC', 'Europe/Moscow']) {
      await db.query(`select set_config('TimeZone', $1, true)`, [timezone]);
      for (const interval of [null, '7 days', '30 days']) {
        await t.test(`old/new complete rows match: ${timezone}/${interval ?? 'all'}`, async () => {
          assert.deepEqual((await admin.readAdminPriceStats(interval)).rows, (await db.query(baseline.readAdminPriceStats, [interval])).rows);
          for (const id of [9, 20, 999]) {
            assert.deepEqual((await manager.readManagerExtendedPriceStats(id, interval)).rows, (await db.query(baseline.readManagerExtendedPriceStatsManager, [id, interval])).rows);
          }
          if (interval) {
            assert.deepEqual((await supplemental.readPeriodComparison(null, interval)).rows, (await db.query(baseline.readPeriodComparison, [interval])).rows);
            assert.deepEqual((await supplemental.readPeriodComparison(9, interval)).rows, (await db.query(baseline.readPeriodComparisonManager, [interval, 9])).rows);
          }
        });
      }
    }
    await t.test('query-level old/new EXPLAIN ANALYZE on identical synthetic events', async () => {
      const timings: Array<{ query: string; beforeMs: number; afterMs: number; beforeBlocks: number; afterBlocks: number }> = [];
      for (const [file, fn, args, fixture] of [
        ['analytics/adminReads', 'readAdminPriceStats', ['30 days'], 'readAdminPriceStats'],
        ['analytics/managerExtendedReads', 'readManagerExtendedPriceStats', [9, '30 days'], 'readManagerExtendedPriceStatsManager'],
        ['analytics/supplementalReads', 'readPeriodComparison', [null, '30 days'], 'readPeriodComparison'],
        ['analytics/supplementalReads', 'readPeriodComparison', [9, '30 days'], 'readPeriodComparisonManager'],
      ] as const) {
        let newSql = '', params: unknown[] = [];
        const loadedModule = loadAnalyticsModule<Record<string, (...args: unknown[]) => Promise<unknown>>>(file, async (sql, values) => { newSql = sql; params = values ?? []; return { rows: [] }; });
        await loadedModule[fn](...args);
        const before: Plan[] = [], after: Plan[] = [];
        for (let round = 0; round < 5; round++) {
          for (const [sql, plans] of round%2 ? [[newSql,after],[baseline[fixture],before]] as const : [[baseline[fixture],before],[newSql,after]] as const) {
            const plan = (await db.query(`explain (analyze, buffers, format json) ${sql}`, params)).rows[0]['QUERY PLAN'][0] as Plan;
            plans.push(plan);
          }
        }
        const median = (plans: Plan[]) => plans.map((p) => p['Execution Time']).sort((a,b)=>a-b)[2];
        const blocks = (plan: Plan) => plan.Plan['Shared Hit Blocks']+plan.Plan['Shared Read Blocks'];
        timings.push({ query: fixture, beforeMs: median(before), afterMs: median(after), beforeBlocks: blocks(before[2]), afterBlocks: blocks(after[2]) });
        // Plans/CPU vary by PostgreSQL version and host. Record evidence rather
        // than a flaky wall-time threshold; exact old/new rows are asserted above.
        assert.ok(Number.isFinite(median(before)) && Number.isFinite(median(after)));
      }
      console.info(JSON.stringify({ syntheticAnalyticsBenchmark: { prices: 400, events: 60000, rounds: 5, timings } }));
    });
    await db.query('rollback');
    await t.test('clear changes shared epoch atomically and failure rolls back deletion', async () => {
      const code = ts.transpileModule(readFileSync('src/shared/lib/db/analyticsRepo.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
      const loadedModule = { exports: {} as { clearWholesaleAnalyticsEvents(): Promise<number> } };
      const require = (name: string) => name === 'crypto' ? { randomUUID } : name === './client' ? { query: (sql: string, params: unknown[]) => db.query(sql, params) } : name === './schema' ? { ensureSiteSchema: async () => {} } : assert.fail(name);
      new Function('require','module','exports',code)(require,loadedModule,loadedModule.exports);
      const before = (await db.query('select count(*)::integer as n from wholesale_analytics_events')).rows[0].n;
      await db.query(`alter table site_settings add constraint reject_epoch check (key <> 'wholesale_analytics_cache_epoch')`);
      await assert.rejects(loadedModule.exports.clearWholesaleAnalyticsEvents(), /reject_epoch/);
      assert.equal((await db.query('select count(*)::integer as n from wholesale_analytics_events')).rows[0].n, before);
      await db.query('alter table site_settings drop constraint reject_epoch');
      assert.equal(await loadedModule.exports.clearWholesaleAnalyticsEvents(), before);
      const epoch = (await db.query('select value from site_settings where key=$1', ['wholesale_analytics_cache_epoch'])).rows[0].value;
      assert.match(epoch, /^[a-f0-9-]{36}$/);
      assert.equal(await loadedModule.exports.clearWholesaleAnalyticsEvents(), 0);
      assert.notEqual((await db.query('select value from site_settings where key=$1', ['wholesale_analytics_cache_epoch'])).rows[0].value, epoch);
    });
  } finally { await db.end(); }
});
