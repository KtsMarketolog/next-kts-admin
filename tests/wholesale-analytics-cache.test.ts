import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { loadAnalyticsModule } from './helpers/wholesaleAnalyticsHarness';

type CacheModule = typeof import('../src/shared/lib/db/wholesaleAdminRepo/analytics/readCache');
const session = { role: 'admin', adminUserId: 1 } as const;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function cacheModule(query: (sql: string, params?: unknown[]) => Promise<unknown> = async () => ({ rows: [] })) {
  return loadAnalyticsModule<CacheModule>('analytics/readCache', query);
}

test('analytics cache coalesces identical work, isolates mutable responses and starts TTL on completion', async () => {
  let now = 0, calls = 0;
  const cache = cacheModule().createAnalyticsReadCache({ now: () => now, ttlMs: 10 });
  const gate = deferred<{ count: number }>();
  const load = () => { calls++; return gate.promise; };
  const first = cache.read('one', load), second = cache.read('one', load);
  await Promise.resolve(); now = 100; gate.resolve({ count: 7 });
  (await first).count = 99;
  assert.deepEqual(await second, { count: 7 }); assert.equal(calls, 1);
  now = 109; assert.deepEqual(await cache.read('one', load), { count: 7 }); assert.equal(calls, 1);
  now = 110; await cache.read('one', load); assert.equal(calls, 2);
});

test('analytics cache never remembers failures/null, bounds entry count, bytes and distinct pending work', async () => {
  const cache = cacheModule().createAnalyticsReadCache({ maxEntries: 1, maxBytes: 20, maxPending: 1 });
  let loads = 0;
  const load = async () => ++loads;
  await cache.read('a', load); await cache.read('b', load); await cache.read('a', load); assert.equal(loads, 3);
  await cache.read('huge', async () => 'x'.repeat(21)); await cache.read('huge', load); assert.equal(loads, 4);
  await cache.read('null', async () => null); await cache.read('null', load); assert.equal(loads, 5);
  await assert.rejects(cache.read('failure', async () => { throw new Error('synthetic'); }), /synthetic/);
  await cache.read('failure', load); assert.equal(loads, 6);
  const gate = deferred<number>(); const pending = cache.read('pending', () => gate.promise);
  await assert.rejects(cache.read('other', load), /Аналитика занята/);
  const same = cache.read('pending', load); gate.resolve(9);
  assert.equal(await pending, 9); assert.equal(await same, 9);
});

test('actor, role, period, target manager and target revision never share cached statistics', async () => {
  const loadedModule = cacheModule(); let loads = 0;
  const base = { session, kind: 'extended' as const, period: '7d', managerId: 9, targetRevision: 'v1' };
  const load = async () => ({ load: ++loads });
  assert.deepEqual(await loadedModule.readCachedAnalytics(base, load), await loadedModule.readCachedAnalytics(base, load));
  for (const input of [
    { ...base, session: { ...session, adminUserId: 2 } },
    { ...base, session: { ...session, role: 'wholesale_admin' as const } },
    { ...base, period: '30d' }, { ...base, managerId: 10 }, { ...base, targetRevision: 'v2' },
    { ...base, kind: 'admin' as const },
  ]) await loadedModule.readCachedAnalytics(input, load);
  assert.equal(loads, 7);
  await assert.rejects(loadedModule.readCachedAnalytics({ ...base, session: { role: 'manager', managerId: 9 } }, load), /Недостаточно прав/);
  assert.equal(loads, 7);
  await loadedModule.readCachedAnalytics({ ...base, session: { role: 'admin' } }, load);
  await loadedModule.readCachedAnalytics({ ...base, session: { role: 'admin' } }, load);
  assert.equal(loads, 9, 'A missing persisted actor identity must bypass, not share a cache');
});

test('shared clear epoch invalidates two process caches and pre-clear inflight computations', async () => {
  let epoch = 'before', loads = 0;
  const query = async () => ({ rows: [{ value: epoch }] });
  const firstProcess = cacheModule(query), secondProcess = cacheModule(query);
  const input = { session, kind: 'admin' as const, period: '30d' };
  const load = async () => ({ epoch, load: ++loads });
  await firstProcess.readCachedAnalytics(input, load); await secondProcess.readCachedAnalytics(input, load);
  epoch = 'cleared';
  assert.equal((await firstProcess.readCachedAnalytics(input, load)).epoch, 'cleared');
  assert.equal((await secondProcess.readCachedAnalytics(input, load)).epoch, 'cleared');
  const gate = deferred<{ epoch: string; load: number }>();
  const pending = firstProcess.readCachedAnalytics({ ...input, period: '7d' }, () => epoch === 'cleared' ? gate.promise : load());
  await new Promise((resolve) => setImmediate(resolve)); epoch = 'cleared-again'; gate.resolve({ epoch: 'cleared', load: -1 });
  assert.equal((await pending).epoch, 'cleared-again');
  assert.equal((await firstProcess.readCachedAnalytics({ ...input, period: '7d' }, load)).epoch, 'cleared-again');
});

test('failed epoch read and repeatedly changing epochs never return stale statistics', async () => {
  const failed = cacheModule(async () => { throw new Error('database unavailable'); });
  await assert.rejects(failed.readCachedAnalytics({ session, kind: 'admin', period: '30d' }, async () => 'stale'), /database unavailable/);
  let epoch = 0, loads = 0;
  const changing = cacheModule(async () => ({ rows: [{ value: String(++epoch) }] }));
  await assert.rejects(changing.readCachedAnalytics({ session, kind: 'admin', period: '30d' }, async () => ++loads), /Журнал изменился/);
  assert.equal(loads, 3);
});

test('manager existence and metadata are checked afresh before cached analytics', async () => {
  let present = true, revision = 'one', reportQueries = 0;
  const repo = loadAnalyticsModule<typeof import('../src/shared/lib/db/wholesaleAdminRepo/managerAnalyticsRepo')>('managerAnalyticsRepo', async (sql) => {
    if (sql.includes('analytics_revision')) return { rows: present ? [{ id: '9', name: 'Synthetic', role: 'manager', analytics_revision: revision }] : [] };
    if (sql.includes('select value from site_settings')) return { rows: [] };
    reportQueries++; return { rows: [] };
  });
  await repo.getWholesaleManagerAnalytics(9, '30d', session); const initial = reportQueries;
  await repo.getWholesaleManagerAnalytics(9, '30d', session); assert.equal(reportQueries, initial);
  revision = 'two'; await repo.getWholesaleManagerAnalytics(9, '30d', session); assert.ok(reportQueries > initial);
  present = false; assert.equal(await repo.getWholesaleManagerAnalytics(9, '30d', session), null);
});

test('HTTP analytics authenticates every call before reaching even a cached repository', async () => {
  const file = 'src/app/api/admin/wholesale/analytics/route.ts';
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const loadedModule = { exports: {} as { GET: (request: Request) => Promise<Response> } }; let allowed = true, reads = 0, auth = 0;
  const require = (name: string) => {
    if (name.endsWith('analytics/availability')) return loadAnalyticsModule('analytics/availability', async () => ({ rows: [] }));
    if (name.endsWith('adminAuth')) return { requireWholesaleAdminSession: async () => { auth++; return allowed ? { denied: null, session } : { denied: new Response(null, { status: 403 }) }; } };
    if (name.endsWith('/db')) return { getWholesaleAdminAnalytics: async (_period: string, actor: unknown) => { assert.deepEqual(actor, session); reads++; return {}; } };
    if (name.endsWith('originProtection')) return {};
    throw new Error(name);
  };
  new Function('require', 'module', 'exports', code)(require,loadedModule, loadedModule.exports);
  const request = new Request('https://example.invalid/api/admin/wholesale/analytics');
  assert.equal((await loadedModule.exports.GET(request)).headers.get('Cache-Control'), 'private, no-store');
  allowed = false; assert.equal((await loadedModule.exports.GET(request)).status, 403);
  assert.equal(auth, 2); assert.equal(reads, 1);
});

test('only temporary analytics capacity/epoch failures become a retryable 503', async () => {
  const available = loadAnalyticsModule<typeof import('../src/shared/lib/db/wholesaleAdminRepo/analytics/availability')>('analytics/availability', async () => ({ rows: [] }));
  const response = available.analyticsUnavailableResponse(new available.AnalyticsUnavailableError());
  assert.equal(response.status, 503); assert.equal(response.headers.get('Retry-After'), '2');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.match((await response.json()).error, /Аналитика занята/);
  const internal = new Error('sensitive database diagnostics');
  assert.throws(() => available.analyticsUnavailableResponse(internal), (error) => error === internal);
});

for (const [file, method] of [
  ['src/app/api/admin/wholesale/analytics/route.ts', 'GET'],
  ['src/app/api/admin/wholesale/managers/[id]/analytics/route.ts', 'GET'],
  ['src/app/api/admin/wholesale/analytics/export/route.ts', 'GET'],
  ['src/app/api/admin/wholesale/analytics/export/route.ts', 'POST'],
] as const) test(`${file}/${method}: live authorization and retryable capacity handling`, async () => {
  const availability = loadAnalyticsModule<typeof import('../src/shared/lib/db/wholesaleAdminRepo/analytics/availability')>('analytics/availability', async () => ({ rows: [] }));
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const loadedModule = { exports: {} as Record<string, (request: Request, context: unknown) => Promise<Response>> };
  let allowed = false, loads = 0;
  const require = (name: string) => {
    if (name.endsWith('analytics/availability')) return availability;
    if (name.endsWith('adminAuth')) return { requireWholesaleAdminSession: async () => allowed ? { session, denied: null } : { denied: new Response(null, { status: 403 }) } };
    if (name.endsWith('/db')) return Object.fromEntries(['getWholesaleAdminAnalytics', 'getWholesaleManagerAnalyticsExtended'].map((key) => [key, async () => { loads++; throw new availability.AnalyticsUnavailableError(); }]));
    if (name.endsWith('adminSecurity')) return { enforceAdminActionRateLimit: async () => null };
    if (name.endsWith('originProtection')) return { enforceSameOriginRequest: () => null };
    if (name.endsWith('wholesaleSecurity')) return { normalizeTextField: (value: string) => value };
    if (name.endsWith('mailer') || name.endsWith('wholesaleAnalyticsExport')) return {};
    throw new Error(name);
  };
  new Function('require', 'module', 'exports', code)(require, loadedModule, loadedModule.exports);
  const request = () => new Request('https://example.invalid/api/admin/wholesale/analytics', method === 'POST'
    ? { method, body: JSON.stringify({ email: 'synthetic@example.invalid' }), headers: { 'content-type': 'application/json' } } : undefined);
  const context = { params: Promise.resolve({ id: '9' }) };
  assert.equal((await loadedModule.exports[method](request(), context)).status, 403); assert.equal(loads, 0);
  allowed = true;
  const busy = await loadedModule.exports[method](request(), context);
  assert.equal(busy.status, 503); assert.equal(busy.headers.get('Retry-After'), '2'); assert.equal(loads, 1);
  assert.match((await busy.json()).error, /Аналитика занята/);
});

test('query/stage measurements contain no SQL, parameters, session or response data', async () => {
  const logs: string[] = [];
  const info = console.info, flag = process.env.WHOLESALE_ANALYTICS_PERFORMANCE_LOG;
  const metrics = loadAnalyticsModule<typeof import('../src/shared/lib/db/wholesaleAdminRepo/analytics/performance')>('analytics/performance', async () => ({ rows: [{ secret: 'response-secret' }] }));
  process.env.WHOLESALE_ANALYTICS_PERFORMANCE_LOG = '1'; console.info = (line: string) => logs.push(line);
  try {
    await metrics.traceAnalytics('admin', () => metrics.analyticsQuery('readAdminPriceStats', 'select private_sql_secret', ['parameter-secret']));
  } finally { console.info = info; if (flag === undefined) delete process.env.WHOLESALE_ANALYTICS_PERFORMANCE_LOG; else process.env.WHOLESALE_ANALYTICS_PERFORMANCE_LOG = flag; }
  assert.equal(logs.length, 1);
  const record = JSON.parse(logs[0]);
  assert.equal(record.event, 'wholesale_analytics_performance'); assert.equal(record.operation, 'admin');
  assert.equal(record.stages[0].stage, 'readAdminPriceStats'); assert.ok(record.stages[0].wallMs >= 0);
  assert.equal(record.cpuScope, 'process_interval_includes_concurrent_work');
  assert.doesNotMatch(logs[0], /secret|parameter|select|session|sql/i);
});
