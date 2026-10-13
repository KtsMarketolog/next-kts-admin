import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { canReviewDashboardUsage } from '../src/shared/lib/dashboardUsageAccess';
import { isDashboardUsageAction, isDashboardUsageKey, parseDashboardUsageBatch } from '../src/shared/lib/dashboardUsage';
import type { AdminSession } from '../src/shared/lib/adminAuth';
import type { listDashboardUsageEmployees, listDashboardUsage } from '../src/shared/lib/db/dashboardUsageRepo';

function compile(path: string, dependencies: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(code, { exports, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency ${name}`);
    return dependencies[name];
  }, Response, URL, Buffer, console });
  return exports;
}

function employeeRow(index = 1, empty = false) {
  return { actor_key: `admin:${index}`, actor_name: `Сотрудник ${index}`, actor_role: 'top',
    last_opened_at: empty ? null : new Date('2026-10-12T06:00:00Z'),
    last_used_at: empty ? null : new Date('2026-10-12T08:00:00Z'),
    last_interaction_at: empty ? null : new Date('2026-10-12T07:00:00Z'),
    last_dashboard_key: empty ? null : 'currency-rates', last_dashboard_title: empty ? null : 'Курсы валют и медь',
    report_count: empty ? 0 : 2, interaction_count: empty ? '0' : '3', upload_count: empty ? '0' : '2', viewing_seconds: empty ? '0' : '35' };
}

function repoFixture(rows = [employeeRow(), employeeRow(2, true)]) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const run = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql.startsWith('select (')) return { rows: [{ period_start: new Date('2026-09-13T06:00:00Z'), generated_at: new Date('2026-10-13T06:00:00Z') }] };
    if (sql.startsWith('with employees')) return { rows };
    return { rows: [] };
  };
  const repo = compile('src/shared/lib/db/dashboardUsageRepo.ts', {
    '../adminAuth': {}, '../dashboardAccess': {}, '../currencyDashboardAccess': {},
    '../dashboardUsage': { parseDashboardUsageBatch },
    './schema': { ensureSiteSchema: async () => {} },
    './client': { query: run, withTransaction: async (callback: (client: { query: typeof run }) => Promise<unknown>) => callback({ query: run }) },
  });
  return { calls, summary: repo.listDashboardUsageEmployees as typeof listDashboardUsageEmployees, list: repo.listDashboardUsage as typeof listDashboardUsage };
}

test('employee summary includes employees with no use and distinguishes opening, received event and interaction', async () => {
  const { summary, calls } = repoFixture();
  const result = await summary();
  assert.equal(result.employees.length, 2);
  assert.equal(result.employees[0].lastOpenedAt, '2026-10-12T06:00:00.000Z');
  assert.equal(result.employees[0].lastInteractionAt, '2026-10-12T07:00:00.000Z');
  assert.equal(result.employees[0].lastUsedAt, '2026-10-12T08:00:00.000Z');
  assert.equal(result.employees[0].interactionCount, 3);
  assert.equal(result.employees[1].lastUsedAt, null);
  assert.equal(result.employees[1].lastInteractionAt, null);
  assert.equal(result.employees[1].reportCount, 0);
  assert.equal(result.nextCursor, null);
  assert.equal(result.periodStart, '2026-09-13T06:00:00.000Z');
  const sql = calls.find((call) => call.sql.startsWith('with employees'))!.sql;
  assert.match(sql, /from admin_users where is_active = true/);
  assert.match(sql, /from wholesale_managers where is_active = true/);
  assert.match(sql, /cross join lateral/);
  assert.match(sql, /event\.actor_key = page\.actor_key and not event\.is_preview and event\.created_at >= \$3::timestamptz/);
  assert.match(sql, /action in \('tab_changed','filter_changed','calculation_completed','export_started','file_uploaded'\)/);
  assert.match(sql, /group by metadata\.viewing_window_id/);
  assert.equal(result.employees[0].uploadCount, 2);
  assert.equal(result.employees[0].viewingSeconds, 35);
  assert.doesNotMatch(sql, /data_loaded|password|ciphertext|select \* from dashboard_usage_events/);
});

test('employee summary paginates at 50, parameterizes literal search, bounds runtime and validates cursors', async () => {
  const { summary, calls } = repoFixture(Array.from({ length: 51 }, (_, index) => employeeRow(index + 1)));
  const result = await summary({ after: 'admin:15', search: "  %_'; --  " });
  assert.equal(result.employees.length, 50);
  assert.equal(result.nextCursor, 'admin:50');
  assert.equal(calls[0].sql, "set local statement_timeout='5s'");
  const query = calls.find((call) => call.sql.startsWith('with employees'))!;
  assert.equal(query.params?.[0], 'admin:15');
  assert.equal(query.params?.[1], "%_'; --");
  assert.match(query.sql, /actor_key > \$1/);
  assert.match(query.sql, /position\(lower\(\$2\) in lower\(actor_name\)\)/);
  assert.match(query.sql, /order by actor_key limit 51/);
  assert.doesNotMatch(query.sql, /%_'; --/);
  for (const after of ['admin:primary', 'manager:0', 'admin:1;delete', 'admin:9999999999999999']) {
    await assert.rejects(summary({ after }), /Некорректный фильтр/);
  }
  await assert.rejects(summary({ search: 'x'.repeat(101) }), /Некорректный фильтр/);
});

test('summary on an empty roster still returns an authoritative server period', async () => {
  const result = await repoFixture([]).summary();
  assert.equal(result.employees.length, 0);
  assert.equal(result.nextCursor, null);
  assert.equal(result.generatedAt, '2026-10-13T06:00:00.000Z');
});

test('detailed history excludes previews by default and permits an explicit include flag', async () => {
  const { list, calls } = repoFixture();
  await list({ actorKey: 'admin:1' });
  await list({ actorKey: 'admin:1', includePreview: true });
  assert.equal(calls[0].params?.[4], false);
  assert.equal(calls[1].params?.[4], true);
  assert.match(calls[0].sql, /\(\$5::boolean or not event\.is_preview\)/);
});

function routeFixture(session: AdminSession | null, limited: Response | null = null) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const dependencies = {
    '@/shared/lib/adminAuth': { getAdminSession: async () => session },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => limited },
    '@/shared/lib/dashboardAccess': {}, '@/shared/lib/currencyDashboardAccess': {},
    '@/shared/lib/dashboardUsage': { isDashboardUsageAction, isDashboardUsageKey },
    '@/shared/lib/db/dashboardUsageRepo': {
      listDashboardUsageEmployees: async (input: unknown) => { calls.push({ method: 'summary', input }); return { employees: [] }; },
      listDashboardUsageEmployeeReports: async (input: unknown) => { calls.push({ method: 'employee', input }); return { reports: [] }; },
      listDashboardUsage: async (input: unknown) => { calls.push({ method: 'events', input }); return { events: [] }; },
    },
    '@/shared/lib/originProtection': {}, '@/shared/lib/dashboardUsageAccess': { canReviewDashboardUsage },
    '@/shared/lib/dashboardUsageDelivery': {},
  };
  const route = compile('src/app/api/admin/dashboard-usage/route.ts', dependencies);
  return { get: route.GET as (request: Request) => Promise<Response>, calls };
}
const admin: AdminSession = { role: 'admin', sessionId: 'session', adminUserId: 1 };

test('summary API keeps the exact admin/admintop/top gate, private caching and read limits', async () => {
  for (const role of ['admin', 'admintop', 'top', 'manager', 'support_manager', 'purchaser', 'wholesale_admin'] as const) {
    const { get, calls } = routeFixture({ ...admin, role, managerId: 3 });
    const response = await get(new Request('https://kts.test/api/admin/dashboard-usage?view=employees'));
    assert.equal(response.status, ['admin', 'admintop', 'top'].includes(role) ? 200 : 403);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(calls.length, response.status === 200 ? 1 : 0);
  }
  assert.equal((await routeFixture(null).get(new Request('https://kts.test/api/admin/dashboard-usage?view=employees'))).status, 401);
  const { get, calls } = routeFixture(admin, Response.json({}, { status: 429 }));
  assert.equal((await get(new Request('https://kts.test/api/admin/dashboard-usage?view=employees'))).status, 429);
  assert.equal(calls.length, 0);
});

test('summary API rejects duplicate/unknown filters and separates employee pagination from event pagination', async () => {
  const { get, calls } = routeFixture(admin);
  for (const params of ['view=employees&after=manager:0', 'view=employees&view=employees', 'view=employees&preview=1',
    'view=employees&search=' + 'a'.repeat(101), 'view=unknown', 'preview=true', 'preview=1&preview=1']) {
    assert.equal((await get(new Request(`https://kts.test/api/admin/dashboard-usage?${params}`))).status, 400, params);
  }
  assert.equal(calls.length, 0);
  assert.equal((await get(new Request('https://kts.test/api/admin/dashboard-usage?view=employees&after=manager:3&search=Имя'))).status, 200);
  assert.equal(calls[0].method, 'summary');
  assert.equal((calls[0].input as { after: string }).after, 'manager:3');
  await get(new Request('https://kts.test/api/admin/dashboard-usage?actor=manager:3&preview=1'));
  assert.equal((calls[1].input as { includePreview: boolean }).includePreview, true);
  await get(new Request('https://kts.test/api/admin/dashboard-usage?view=employee&actor=manager:3'));
  assert.equal(calls[2].method, 'employee');
  for (const params of ['view=employee', 'view=employee&actor=bad', 'view=employee&actor=admin:1&after=bad']) {
    assert.equal((await get(new Request(`https://kts.test/api/admin/dashboard-usage?${params}`))).status, 400);
  }
});

test('journal presents summary, no-activity state, server-time caveat and employee drilldown', () => {
  const source = readFileSync('src/features/admin/dashboard-usage/DashboardUsageJournal.tsx', 'utf8');
  assert.match(source, /Последняя активность сотрудников/);
  assert.match(source, /Нет зафиксированного использования/);
  assert.match(source, /регистрация события сервером/);
  assert.match(source, /onSelect\(employee\.actorKey, employee\.actorName\)/);
  assert.match(source, /Включить предпросмотры и архив/);
  assert.match(source, /controller\.signal\.aborted/);
});
