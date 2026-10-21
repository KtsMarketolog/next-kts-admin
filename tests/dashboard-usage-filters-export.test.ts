import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as XLSX from 'xlsx';
import * as filters from '../src/shared/lib/dashboardUsageFilters';
import { acquireDashboardUsageExportSlot, buildDashboardUsageWorkbook } from '../src/shared/lib/dashboardUsageExport';
import { canReviewDashboardUsage } from '../src/shared/lib/dashboardUsageAccess';
import type { AdminSession } from '../src/shared/lib/adminAuth';
import type { DashboardUsageRow } from '../src/shared/lib/db/dashboardUsageRepo';

test('journal date range uses strict real Moscow calendar days and exclusive next midnight', () => {
  assert.deepEqual(filters.dashboardUsageDateBounds({ from: '2024-02-29', to: '2024-02-29' }), {
    fromInclusive: '2024-02-28T21:00:00.000Z', toExclusive: '2024-02-29T21:00:00.000Z',
  });
  assert.deepEqual(filters.dashboardUsageDateBounds({ to: '2026-12-31' }), { fromInclusive: null, toExclusive: '2026-12-31T21:00:00.000Z' });
  assert.deepEqual(filters.dashboardUsageDateBounds({}), { fromInclusive: null, toExclusive: null });
  for (const value of ['2026-02-29', '2026-04-31', '2026-00-10', '2026-10-00', '2026-1-01', '2026-01-01T00:00:00Z', '', 'bad', '9999-12-31']) {
    assert.throws(() => filters.dashboardUsageDateBounds({ from: value }), filters.DashboardUsageFilterError, value);
  }
  assert.throws(() => filters.dashboardUsageDateBounds({ from: '2026-10-03', to: '2026-10-02' }), /позже/);
});

test('one strict parser binds exact identity and period consistently, disallows duplicate and cross-view params', () => {
  for (const view of ['events', 'employees', 'employee'] as const) {
    const params = new URLSearchParams({ view, actor: 'admin:primary', from: '2026-10-01', to: '2026-10-02' });
    assert.equal(filters.parseDashboardUsageFilters(params, view).actorKey, 'admin:primary');
    assert.equal(filters.parseDashboardUsageFilters(params, view).from, '2026-10-01');
    assert.equal(filters.parseDashboardUsageFilters(params, view).to, '2026-10-02');
  }
  for (const query of ['actor=manager:primary', 'actor=manager:0', 'actor=admin:1%27;DROP', 'from=2026-10-01&from=2026-10-02', 'to=bad', 'limit=100000', 'actor=', 'view=events&after=admin:1']) {
    assert.throws(() => filters.parseDashboardUsageFilters(new URLSearchParams(query), 'events'), filters.DashboardUsageFilterError);
  }
  for (const query of ['view=employees&preview=1', 'view=employees&action=report_open', 'view=employees&dashboard=top:1', 'view=employees&before=9']) {
    assert.throws(() => filters.parseDashboardUsageFilters(new URLSearchParams(query), 'employees'), filters.DashboardUsageFilterError);
  }
  for (const query of ['view=events&before=99', 'view=employees&after=admin:99']) {
    assert.throws(() => filters.parseDashboardUsageFilters(new URLSearchParams(query), query.includes('events') ? 'events' : 'employees', true), filters.DashboardUsageFilterError);
  }
});

const event: DashboardUsageRow = { id: '9007199254740993', actorKey: 'manager:1', actorName: '=HYPERLINK("https://invalid.test")', actorRole: 'manager',
  dashboardKey: 'top:4', dashboardTitle: '+SUM(1,2)', action: 'data_loaded', preview: false, versionId: 4,
  createdAt: '2026-10-01T21:00:00.000Z', hasProfitabilityDetails: true, upload: { name: '@fake.xlsx', size: 33 }, uploadType: null, durationSeconds: null };
test('XLSX contains the whole supplied result and literal strings, no formulas, links or document details', () => {
  const bytes = buildDashboardUsageWorkbook({ view: 'events', rows: Array.from({ length: 121 }, (_, index) => ({ ...event, id: String(1000 - index) })) }, { from: '2026-10-01', to: '2026-10-02', actorKey: 'manager:1' });
  const workbook = XLSX.read(bytes, { type: 'buffer', cellFormula: true });
  const sheet = workbook.Sheets['События'];
  assert.equal(XLSX.utils.sheet_to_json(sheet).length, 121, 'not just a 50-row UI page');
  assert.equal(sheet.D2.t, 's'); assert.equal(sheet.D2.v, event.actorName); assert.equal(sheet.D2.f, undefined); assert.equal(sheet.D2.l, undefined);
  assert.equal(sheet.G2.t, 's'); assert.equal(sheet.G2.v, event.dashboardTitle); assert.equal(sheet.K2.v, event.upload!.name);
  assert.match(String(sheet.B2.v), /02\.10\.2026.*00:00:00/);
  for (const row of Object.values(sheet)) if (row && typeof row === 'object') assert.equal('f' in row, false);
  assert.match(JSON.stringify(XLSX.utils.sheet_to_json(workbook.Sheets['Параметры'])), /2026-10-02/);
  assert.doesNotMatch(JSON.stringify(workbook), /invoiceNumber|nomenclature|password|ciphertext/);
  const exact = XLSX.read(buildDashboardUsageWorkbook({ view: 'events', rows: [event] }, {}), { type: 'buffer' });
  assert.equal(exact.Sheets['События'].A2.v, '9007199254740993');
});

test('export refuses count/cell/text-volume overflow without a partial workbook; exact limit succeeds', () => {
  assert.throws(() => buildDashboardUsageWorkbook({ view: 'events', rows: Array(5001).fill(event) }, {}), filters.DashboardUsageExportLimitError);
  assert.throws(() => buildDashboardUsageWorkbook({ view: 'events', rows: [{ ...event, actorName: 'x'.repeat(32768) }] }, {}), filters.DashboardUsageExportLimitError);
  assert.throws(() => buildDashboardUsageWorkbook({ view: 'events', rows: Array(100).fill({ ...event, actorName: 'x'.repeat(30000) }) }, {}), filters.DashboardUsageExportLimitError);
  const workbook = XLSX.read(buildDashboardUsageWorkbook({ view: 'events', rows: Array(5000).fill(event) }, {}), { type: 'buffer' });
  assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['События']).length, 5000);
});

function routeFixture(role: string | null = 'admin', options: { fail?: Error; limited?: boolean; hold?: Promise<void> } = {}) {
  let reads = 0, builds = 0, locks = 0, releases = 0;
  const dependencies: Record<string, unknown> = {
    '@/shared/lib/adminAuth': { getAdminSession: async () => role ? { role, adminUserId: 1, managerId: 1, sessionId: 'synthetic-session' } as AdminSession : null },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => options.limited ? Response.json({}, { status: 429 }) : null },
    '@/shared/lib/dashboardUsageAccess': { canReviewDashboardUsage },
    '@/shared/lib/dashboardUsageFilters': filters,
    '@/shared/lib/dashboardUsageExport': {
      acquireDashboardUsageExportSlot: () => { locks++; return () => { releases++; }; },
      buildDashboardUsageWorkbook: (data: Parameters<typeof buildDashboardUsageWorkbook>[0], input: filters.DashboardUsageFilters) => { builds++; return buildDashboardUsageWorkbook(data, input); },
    },
    '@/shared/lib/db/dashboardUsageRepo': { exportDashboardUsage: async () => { reads++; await options.hold; if (options.fail) throw options.fail; return { view: 'events', rows: [event] }; } },
  };
  const code = ts.transpileModule(readFileSync('src/app/api/admin/dashboard-usage/export/route.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: { GET?: (request: Request) => Promise<Response> } = {};
  vm.runInNewContext(code, { exports, Response, URL, Uint8Array, console: { error() {} }, require(name: string) { assert.ok(name in dependencies, name); return dependencies[name]; } });
  return { get: exports.GET!, state: () => ({ reads, builds, locks, releases }) };
}
test('export route keeps exact role gate before DB/workbook, no-store, strict filters and rate limits', async () => {
  for (const role of [null, 'manager', 'support_manager', 'purchaser', 'wholesale_admin', 'admin', 'admintop', 'top']) {
    const f = routeFixture(role), response = await f.get(new Request('https://test.invalid/api/admin/dashboard-usage/export?view=events'));
    assert.equal(response.status, role && ['admin', 'admintop', 'top'].includes(role) ? 200 : role ? 403 : 401);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(f.state().reads, response.ok ? 1 : 0); assert.equal(f.state().builds, response.ok ? 1 : 0);
    if (response.ok) assert.equal(XLSX.utils.sheet_to_json(XLSX.read(await response.arrayBuffer()).Sheets['События']).length, 1);
  }
  const f = routeFixture();
  for (const query of ['view=employee', 'view=events&before=99', 'view=events&from=2026-02-30', 'view=employees&preview=1', 'view=events&view=events']) {
    assert.equal((await f.get(new Request(`https://test.invalid/api/admin/dashboard-usage/export?${query}`))).status, 400);
  }
  assert.equal(f.state().reads, 0);
  const limited = routeFixture('admin', { limited: true });
  assert.equal((await limited.get(new Request('https://test.invalid/api/admin/dashboard-usage/export?view=events'))).status, 429);
  assert.equal(limited.state().locks, 0);
});
test('overflow, DB failure and cancellation never return Excel and always release export slot', async () => {
  for (const fail of [new filters.DashboardUsageExportLimitError(), new Error('synthetic SQL timeout')]) {
    const f = routeFixture('top', { fail }), response = await f.get(new Request('https://test.invalid/api/admin/dashboard-usage/export?view=events'));
    assert.equal(response.status, fail instanceof filters.DashboardUsageExportLimitError ? 413 : 503);
    assert.equal(f.state().builds, 0); assert.equal(f.state().releases, 1); assert.equal(response.headers.get('content-disposition'), null);
  }
  const abort = new AbortController(); abort.abort(); const f = routeFixture();
  assert.equal((await f.get(new Request('https://test.invalid/api/admin/dashboard-usage/export?view=events', { signal: abort.signal }))).status, 408);
  assert.equal(f.state().releases, 1); assert.equal(f.state().builds, 0);
  const release = acquireDashboardUsageExportSlot(); assert.ok(release);
  assert.equal(acquireDashboardUsageExportSlot(), null); release();
  const again = acquireDashboardUsageExportSlot(); assert.ok(again); again();
});
