import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { canReviewDashboardUsage } from '../src/shared/lib/dashboardUsageAccess';
import { DASHBOARD_USAGE_LABELS, isDashboardUsageAction, isDashboardUsageKey, parseDashboardUsageBatch } from '../src/shared/lib/dashboardUsage';
import * as usageFilters from '../src/shared/lib/dashboardUsageFilters';
import type { AdminSession } from '../src/shared/lib/adminAuth';
import type { listDashboardUsageEmployees, listDashboardUsageEmployeeReports, listDashboardUsage } from '../src/shared/lib/db/dashboardUsageRepo';

function compile(path: string, dependencies: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(code, { exports, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency ${name}`);
    return dependencies[name];
  }, Response, URL, URLSearchParams, Buffer, console });
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

function eventRow(index = 1) {
  return { id: String(index), actor_key: 'admin:1', actor_name: 'Сотрудник', actor_role: 'top',
    dashboard_key: 'top:4', dashboard_title: 'Отчёт', action: 'report_open', is_preview: false,
    html_version_id: '7', created_at: new Date('2026-10-12T06:00:00Z'), has_profitability_details: false,
    upload_name: null, upload_size: null, upload_type: null, duration_seconds: null };
}

function reportRow(index = 1) {
  return { dashboard_key: `top:${index}`, dashboard_title: `Отчёт ${index}`,
    last_opened_at: new Date('2026-10-12T06:00:00Z'), last_used_at: new Date('2026-10-12T07:00:00Z'),
    open_count: '2', interaction_count: '3', upload_count: '1', viewing_seconds: '120' };
}

function repoFixture(rows = [employeeRow(), employeeRow(2, true)], details: {
  events?: ReturnType<typeof eventRow>[]; reports?: ReturnType<typeof reportRow>[];
} = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const run = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql.startsWith('select greatest(')) return { rows: [{ period_start: new Date('2026-09-13T06:00:00Z'), period_end: new Date('2026-10-13T06:00:00Z'), generated_at: new Date('2026-10-13T06:00:00Z') }] };
    if (sql.startsWith('with employees')) return { rows };
    if (sql.startsWith('select event.id::text')) return { rows: details.events ?? [] };
    if (sql.startsWith('with events as materialized')) return { rows: details.reports ?? [] };
    return { rows: [] };
  };
  const repo = compile('src/shared/lib/db/dashboardUsageRepo.ts', {
    '../adminAuth': {}, '../dashboardAccess': {}, '../currencyDashboardAccess': {},
    '../dashboardUsage': { parseDashboardUsageBatch },
    '../dashboardUsageFilters': usageFilters,
    './schema': { ensureSiteSchema: async () => {} },
    './client': { query: run, withTransaction: async (callback: (client: { query: typeof run }) => Promise<unknown>) => callback({ query: run }) },
  });
  return { calls, summary: repo.listDashboardUsageEmployees as typeof listDashboardUsageEmployees,
    reports: repo.listDashboardUsageEmployeeReports as typeof listDashboardUsageEmployeeReports,
    list: repo.listDashboardUsage as typeof listDashboardUsage };
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
  for (const after of ['manager:primary', 'manager:0', 'admin:1;delete', 'admin:9999999999999999']) {
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
  const reads = calls.filter(call => call.sql.startsWith('select event.id::text'));
  assert.equal(reads[0].params?.[4], false);
  assert.equal(reads[1].params?.[4], true);
  assert.match(reads[0].sql, /\(\$5::boolean or not event\.is_preview\)/);
});

test('all three read models return independent pages of at most 50 with a correct last-row cursor', async () => {
  for (const size of [0, 1, 49, 50, 51]) {
    const employees = Array.from({ length: size }, (_, index) => employeeRow(index + 1));
    const events = Array.from({ length: size }, (_, index) => eventRow(1000 - index));
    const reports = Array.from({ length: size }, (_, index) => reportRow(index + 1));
    const fixture = repoFixture(employees, { events, reports });
    const summaryPage = await fixture.summary();
    const reportsPage = await fixture.reports({ actorKey: 'admin:1' });
    const eventsPage = await fixture.list({});
    assert.equal(summaryPage.employees.length, Math.min(50, size));
    assert.equal(reportsPage.reports.length, Math.min(50, size));
    assert.equal(eventsPage.events.length, Math.min(50, size));
    assert.equal(summaryPage.nextCursor, size > 50 ? 'admin:50' : null);
    assert.equal(reportsPage.nextCursor, size > 50 ? 'top:50' : null);
    assert.equal(eventsPage.nextCursor, size > 50 ? '951' : null);
    // A repeated page request is a replacement page, never an accumulated response.
    assert.deepEqual(await fixture.summary(), summaryPage);
    assert.deepEqual(await fixture.reports({ actorKey: 'admin:1' }), reportsPage);
    assert.deepEqual(await fixture.list({}), eventsPage);
  }
});

test('page cursors use the same strict keyset order as SQL, remain opaque and carry filters independently', async () => {
  const fixture = repoFixture([], { events: [eventRow()], reports: [reportRow()] });
  await fixture.summary({ after: 'manager:12', search: 'Имя' });
  await fixture.reports({ actorKey: 'manager:12', after: 'top:9' });
  await fixture.list({ before: '9007199254740993', dashboardKey: 'top:9', actorKey: 'manager:12', action: 'data_loaded', includePreview: true });
  const employeeQuery = fixture.calls.find(call => call.sql.startsWith('with employees'))!;
  const reportsQuery = fixture.calls.find(call => call.sql.startsWith('with events as materialized'))!;
  const eventsQuery = fixture.calls.find(call => call.sql.startsWith('select event.id::text'))!;
  assert.match(employeeQuery.sql, /actor_key > \$1/);
  assert.match(employeeQuery.sql, /order by actor_key limit 51/);
  assert.equal(employeeQuery.params?.[0], 'manager:12');
  assert.equal(employeeQuery.params?.[1], 'Имя');
  assert.match(reportsQuery.sql, /event\.actor_key = \$1 and not event\.is_preview/);
  assert.match(reportsQuery.sql, /event\.dashboard_key > \$2/);
  assert.match(reportsQuery.sql, /group by dashboard_key order by dashboard_key limit 51/);
  assert.match(reportsQuery.sql, /order by activity\.dashboard_key/);
  assert.equal(reportsQuery.params?.[0], 'manager:12');
  assert.equal(reportsQuery.params?.[1], 'top:9');
  assert.equal(fixture.calls.filter(call => call.sql === "set local statement_timeout='5s'").length, 3);
  assert.match(eventsQuery.sql, /event\.id < \$1::bigint/);
  assert.match(eventsQuery.sql, /order by event\.id desc limit 51/);
  assert.equal(eventsQuery.params?.[0], '9007199254740993', 'Event IDs are never rounded through JavaScript Number');
  assert.deepEqual(Array.from(eventsQuery.params ?? []), ['9007199254740993', 'top:9', 'manager:12', 'data_loaded', true, null, null, '']);
  for (const { sql } of [employeeQuery, reportsQuery, eventsQuery]) assert.doesNotMatch(sql, /\boffset\b/i);
  assert.equal((await fixture.list({})).events.length, 1);
  assert.deepEqual(Array.from(fixture.calls.at(-1)!.params ?? []), [null, null, null, null, false, null, null, ''], 'No previous cursor or filter leaks into a new request');
});

function routeFixture(session: AdminSession | null, limited: Response | null = null) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const dependencies = {
    '@/shared/lib/adminAuth': { getAdminSession: async () => session },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => limited },
    '@/shared/lib/dashboardAccess': {}, '@/shared/lib/currencyDashboardAccess': {},
    '@/shared/lib/dashboardUsage': { isDashboardUsageAction, isDashboardUsageKey },
    '@/shared/lib/dashboardUsageFilters': usageFilters,
    '@/shared/lib/db/dashboardUsageRepo': {
      listDashboardUsageEmployees: async (input: unknown) => { calls.push({ method: 'summary', input }); return { employees: [] }; },
      listDashboardUsageEmployeeReports: async (input: unknown) => { calls.push({ method: 'employee', input }); return { reports: [] }; },
      listDashboardUsage: async (input: unknown) => { calls.push({ method: 'events', input }); return { events: [] }; },
      listDashboardUsageActors: async (input: unknown) => { calls.push({ method: 'actors', input }); return { actors: [] }; },
    },
    '@/shared/lib/originProtection': {}, '@/shared/lib/dashboardUsageAccess': { canReviewDashboardUsage },
    '@/shared/lib/dashboardUsageDelivery': {},
  };
  const route = compile('src/app/api/admin/dashboard-usage/route.ts', dependencies);
  return { get: route.GET as (request: Request) => Promise<Response>, calls };
}
const admin: AdminSession = { role: 'admin', sessionId: 'session', adminUserId: 1 };

test('all journal read views keep the exact admin/admintop/top gate, private caching and read limits', async () => {
  for (const params of ['view=employees', 'view=employee&actor=manager:3', 'actor=manager:3', 'view=actors&search=Имя']) {
    const request = () => new Request(`https://kts.test/api/admin/dashboard-usage?${params}`);
    for (const role of ['admin', 'admintop', 'top', 'manager', 'support_manager', 'purchaser', 'wholesale_admin'] as const) {
      const { get, calls } = routeFixture({ ...admin, role, managerId: 3 });
      const response = await get(request());
      assert.equal(response.status, ['admin', 'admintop', 'top'].includes(role) ? 200 : 403);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
      assert.equal(calls.length, response.status === 200 ? 1 : 0);
    }
    for (const session of [null, { role: 'top' as const, adminUserId: 1 }, { role: 'admintop' as const, sessionId: 'session' }]) {
      const { get, calls } = routeFixture(session);
      assert.equal((await get(request())).status, session ? 403 : 401);
      assert.equal(calls.length, 0);
    }
    const { get, calls } = routeFixture(admin, Response.json({}, { status: 429 }));
    assert.equal((await get(request())).status, 429);
    assert.equal(calls.length, 0);
  }
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

test('each GET loads exactly one selected view and rejects page-size or cross-view cursor overrides', async () => {
  const { get, calls } = routeFixture(admin);
  for (const [params, method, input] of [
    ['view=employees&after=admin:42&search=Имя', 'summary', { after: 'admin:42', search: 'Имя' }],
    ['view=employee&actor=admin:42&after=top:9', 'employee', { actorKey: 'admin:42', after: 'top:9' }],
    ['before=9007199254740993&actor=admin:42&dashboard=top:9&action=data_loaded&preview=1', 'events',
      { before: '9007199254740993', actorKey: 'admin:42', dashboardKey: 'top:9', action: 'data_loaded', includePreview: true }],
  ] as const) {
    const before = calls.length;
    assert.equal((await get(new Request(`https://kts.test/api/admin/dashboard-usage?${params}`))).status, 200);
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1)!.method, method);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1)!.input)), input);
  }
  const before = calls.length;
  for (const params of ['view=employees&before=12', 'view=employees&after=admin:1&after=admin:2',
    'view=employee&actor=admin:42&before=12', 'view=employee&actor=admin:42&actor=admin:43',
    'after=admin:42', 'before=12&before=13', 'before=9007199254740993000',
    'limit=500', 'view=employees&limit=500', 'view=employee&actor=admin:42&limit=500',
    'view=employees&page=2', 'page=2', 'view=employee&actor=admin:42&after=top:0']) {
    assert.equal((await get(new Request(`https://kts.test/api/admin/dashboard-usage?${params}`))).status, 400, params);
  }
  assert.equal(calls.length, before, 'Invalid page requests do not touch a read model');
});

test('split journal builds API-compatible cursor pages without accumulating data or mutating prior navigation', async () => {
  const shared = compile('src/features/admin/dashboard-usage/usage-journal-shared.ts', {
    '@/shared/lib/dashboardUsage': { DASHBOARD_USAGE_LABELS },
  });
  const firstPage = shared.firstPage as () => string[];
  const usageUrl = shared.usageUrl as (params: Record<string, string>, pages: string[], cursorKey?: string) => string;
  assert.deepEqual(Array.from(firstPage()), ['']);
  assert.notEqual(firstPage(), firstPage(), 'Each tab owns an independent cursor stack');
  const { get, calls } = routeFixture(admin);
  const cases: Array<{ params: Record<string, string>; pages: string[]; cursorKey?: string; method: string; cursor: string }> = [
    { params: { view: 'employees', search: 'Имя & отдел' }, pages: ['', 'admin:50'], method: 'summary', cursor: 'admin:50' },
    { params: { view: 'employee', actor: 'manager:3' }, pages: ['', 'top:50'], method: 'employee', cursor: 'top:50' },
    { params: { actor: 'manager:3', dashboard: '', action: 'data_loaded', preview: '' },
      pages: ['', '9007199254740993'], cursorKey: 'before', method: 'events', cursor: '9007199254740993' },
  ];
  for (const item of cases) {
    const saved = JSON.stringify(item);
    const url = new URL(usageUrl(item.params, item.pages, item.cursorKey), 'https://kts.test');
    assert.equal(url.searchParams.get(item.cursorKey ?? 'after'), item.cursor);
    assert.equal([...url.searchParams.values()].some(value => value === ''), false);
    assert.equal((await get(new Request(url))).status, 200);
    assert.equal(calls.at(-1)!.method, item.method);
    const back = new URL(usageUrl(item.params, item.pages.slice(0, -1), item.cursorKey), 'https://kts.test');
    assert.equal(back.searchParams.has('after') || back.searchParams.has('before'), false);
    assert.equal((await get(new Request(back))).status, 200);
    assert.equal(calls.at(-1)!.method, item.method);
    assert.equal(JSON.stringify(item), saved, 'Building next/back URLs preserves other tab state');
  }
});

test('split journal preserves summary, no-activity state, server-time caveat and employee drilldown', () => {
  const source = (file: string) => readFileSync(`src/features/admin/dashboard-usage/${file}`, 'utf8');
  const journal = source('DashboardUsageJournal.tsx');
  const activity = source('UsageActivityTab.tsx');
  const events = source('UsageEventsTab.tsx');
  const drawer = source('UsageDetailsDrawer.tsx');
  assert.match(journal, /Активность сотрудников/);
  assert.match(journal, /регистрация события сервером/);
  assert.match(journal, /а не оценка работы сотрудника/);
  assert.match(journal, /один календарный месяц/);
  assert.match(activity, /Последняя активность сотрудников/);
  assert.match(activity, /Нет зафиксированного использования/);
  assert.match(activity, /onSelect\(employee\)/);
  assert.match(events, /Включить предпросмотры и архив/);
  assert.match(drawer, /view: 'employee', actor: person\.actorKey/);
});

test('split journal only mounts selected readers, keeps cursor navigation and cancels stale page requests', () => {
  const source = (file: string) => readFileSync(`src/features/admin/dashboard-usage/${file}`, 'utf8');
  const journal = source('DashboardUsageJournal.tsx');
  const drawer = source('UsageDetailsDrawer.tsx');
  const page = source('useUsagePage.ts');
  const pagination = source('UsagePagination.tsx');
  assert.match(journal, /tab === 'activity' && <UsageActivityTab/);
  assert.match(journal, /tab === 'events' && <UsageEventsTab/);
  assert.match(journal, /selection && <UsageDetailsDrawer/);
  assert.doesNotMatch(journal, /\bfetch\(|\buseUsagePage\(/);
  assert.match(drawer, /invoiceOpen && <InvoiceData/);
  assert.match(pagination, /pages\.slice\(0, -1\)/);
  assert.match(pagination, /\[\.\.\.pages, nextCursor\]/);
  assert.match(page, /controller\.signal\.aborted/);
  assert.match(page, /if \(!cancelled\) setResult/);
  assert.match(page, /cancelled = true/);
  assert.match(page, /result\?\.key === key \? result : null/);
  assert.match(page, /cache: 'no-store', credentials: 'same-origin'/);
});
