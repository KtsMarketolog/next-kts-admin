import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as access from '../src/shared/lib/dashboardAccess';
import * as permissions from '../src/shared/lib/dashboardPermissions';
import * as audiences from '../src/shared/lib/managerDashboardAudience';
import * as security from '../src/shared/lib/managerDashboardSecurity';
import * as origin from '../src/shared/lib/originProtection';

function compile<T>(filename: string, modules: Record<string, unknown>): T {
  const code = ts.transpileModule(readFileSync(new URL(filename, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} as T };
  new Function('require', 'module', 'exports', 'console', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, loaded, loaded.exports, { error: () => {} });
  return loaded.exports;
}

test('MR audience editor represents TOP inherited read access as checked and locked without granting MS', async () => {
  const queries: string[] = [];
  const db = { query: async (sql: string) => {
    queries.push(sql);
    if (sql.includes('pg_advisory_xact_lock_shared')) return { rows: [] };
    if (sql.includes('select mode,revision')) return { rows: [{ mode: 'individual', revision: '0' }] };
    if (sql.includes('from admin_users u')) return { rows: [{ source: 'admin', id: '3', name: 'Synthetic TOP', login: 'synthetic', role: 'top', is_active: true, can_manage_top_dashboard: false, granted: false }] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const repository = compile<typeof import('../src/shared/lib/db/dashboardAccessRepo')>('../src/shared/lib/db/dashboardAccessRepo.ts', {
    'node:crypto': crypto,
    '../dashboardAccess': access,
    '../dashboardPermissions': permissions,
    './client': { withTransaction: async (fn: (client: typeof db) => unknown) => fn(db) },
    './schema': { ensureSiteSchema: async () => {} },
  });
  const principal = { source: 'admin' as const, numericId: 3, role: 'top' as const };
  assert.equal(repository.dashboardGrantLocked(principal, 'manager:development'), true);
  assert.equal(repository.dashboardGrantEligible(principal, 'manager:development'), true);
  assert.equal(repository.dashboardGrantLocked(principal, 'manager:support'), false);
  assert.equal(repository.dashboardGrantEligible(principal, 'manager:support'), false);
  const mr = await repository.getDashboardAudience('manager:development');
  const ms = await repository.getDashboardAudience('manager:support');
  assert.deepEqual(mr.users.map(({ checked, locked, eligible }) => ({ checked, locked, eligible })), [{ checked: true, locked: true, eligible: true }]);
  assert.deepEqual(ms.users.map(({ checked, locked, eligible }) => ({ checked, locked, eligible })), [{ checked: false, locked: false, eligible: false }]);
  assert.ok(queries.length > 0);
});

test('TOP review rights cannot enter owner routes, import history or any personal mutation', async () => {
  const calls: string[] = [];
  const forbiddenIo = (name: string) => async () => { calls.push(name); throw new Error(`Unexpected IO: ${name}`); };
  const session = {
    role: 'top' as const,
    sessionId: 'synthetic-top',
    adminUserId: 3,
    managerId: 71,
    canManageTopDashboard: true,
    dashboardAccess: ['manager:development', 'manager:support'],
  };
  const shared = compile<typeof import('../src/app/api/admin/manager-dashboard/_shared')>('../src/app/api/admin/manager-dashboard/_shared.ts', {
    '@/shared/lib/adminAuth': { getAdminSession: async () => session },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: forbiddenIo('rate-limit') },
    '@/shared/lib/db/wholesaleAdminRepo/managerRepo': { getWholesaleManagerById: forbiddenIo('manager') },
    '@/shared/lib/managerDashboardSecurity': security,
    '@/shared/lib/originProtection': origin,
  });
  const repository = new Proxy({}, { get: (_target, property) => forbiddenIo(String(property)) });
  const common = {
    'node:crypto': crypto,
    '@/shared/lib/db/managerDashboardRepo': repository,
    '@/shared/lib/managerDashboardAudience': audiences,
    '@/shared/lib/managerDashboardSecurity': security,
    '@/shared/lib/managerDashboardHtml': {},
    '@/shared/lib/managerDashboardDomain': {},
    '@/shared/lib/managerDashboardImportPagination': {},
    '@/shared/lib/managerDashboardMail': { MANAGER_DASHBOARD_MAIL_DISABLED_MESSAGE: 'disabled' },
    '@/shared/lib/originProtection': origin,
    '../../top-dashboard/blocks/routeUtils': { readTopDashboardHtmlUpload: forbiddenIo('upload') },
    '../_shared': shared,
    './_shared': shared,
  };
  type Handler = (request: Request) => Promise<Response>;
  type Route = Partial<Record<'GET' | 'POST' | 'DELETE', Handler>>;
  const cases: Array<[string, 'GET' | 'POST' | 'DELETE', string]> = [
    ['', 'GET', ''],
    ['imports', 'GET', ''],
    ['frame', 'GET', '?version=11&audience=development'],
    ['frame', 'GET', '?version=22&audience=support&preview=1'],
    ['content', 'GET', '?version=11&audience=development'],
    ['snapshots', 'GET', '?snapshot=23'],
    ['snapshots', 'GET', '?snapshot=23&managerId=71'],
    ['html', 'POST', '?audience=development'],
    ['html', 'POST', '?audience=support'],
    ['html', 'DELETE', '?id=11&audience=development'],
    ['html', 'DELETE', '?id=22&audience=support'],
    ['publish', 'POST', ''],
    ['snapshots', 'POST', ''],
    ['check-email', 'POST', ''],
  ];
  for (const [path, method, query] of cases) {
    const route = compile<Route>(`../src/app/api/admin/manager-dashboard/${path ? `${path}/` : ''}route.ts`, common);
    const handler = route[method];
    assert.ok(handler);
    const request = new Request(`https://example.test/api/admin/manager-dashboard/${path}${query}`, {
      method,
      headers: { origin: 'https://example.test', 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ versionId: 11, audience: 'development', expectedActiveVersionId: null }) } : {}),
    });
    const response = await handler(request);
    assert.equal(response.status, 403, `${method} ${path}${query}`);
    assert.match(response.headers.get('Cache-Control') ?? '', /private, no-store/);
    assert.equal(request.bodyUsed, false, 'denial precedes body consumption');
    assert.deepEqual(calls, [], 'denial precedes account, storage, upload and rate-limit IO');
  }
});
