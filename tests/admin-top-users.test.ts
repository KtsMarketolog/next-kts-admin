import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import type { AdminSession, AdminSessionRole } from '../src/shared/lib/adminAuth';
import { isAdminManagementSession, isTopDashboardManagementSession } from '../src/shared/lib/adminAuth';
import { canAssignDashboardAccess } from '../src/shared/lib/dashboardPermissions';
import * as management from '../src/shared/lib/accessUserManagement';
import * as dashboards from '../src/shared/lib/dashboardAccess';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';
import { roleOptionsForTab, USER_TABS } from '../src/features/admin/users/AdminUsersConfig';
import { defaultDashboardAccess, readDashboardOptions } from '../src/features/admin/users/AdminUsersDashboardAccess';

test('delegated user management is Admin TOP only, not any dashboard manager or site admin authority', () => {
  const base = { sessionId: 'stored', adminUserId: 4, managerId: 5, canManageTopDashboard: true };
  for (const role of ['admin', 'admintop', 'top', 'manager', 'support_manager', 'purchaser', 'wholesale_admin'] as const) {
    const session = { ...base, role };
    assert.equal(canAssignDashboardAccess(session), role === 'admin' || role === 'admintop');
    assert.equal(isAdminManagementSession(session), role === 'admin', 'site management is unchanged');
    if (role === 'top' || role === 'manager') assert.equal(isTopDashboardManagementSession(session), true);
  }
  assert.equal(canAssignDashboardAccess({ role: 'admintop', adminUserId: 2 }), false);
  assert.equal(canAssignDashboardAccess({ role: 'admintop', sessionId: 'stored' }), false);
  assert.equal(canAssignDashboardAccess(null), false);
  assert.equal(USER_TABS.flatMap(({ value }) => roleOptionsForTab(value, false)).some(({ value }) => value === 'admin'), false);
  assert.equal(roleOptionsForTab('admin', true).some(({ value }) => value === 'admin'), true);
});

test('all-mode initial grants seed only the correct personal group and preserve parser metadata', () => {
  const options = readDashboardOptions([
    { key: 'top:7', title: 'Shared', defaultGranted: true },
    { key: 'manager:development', title: 'MR', defaultGranted: true },
    { key: 'manager:support', title: 'MS', defaultGranted: true },
    { key: 'currency-rates', title: 'Individual', defaultGranted: false },
  ])!;
  assert.deepEqual(defaultDashboardAccess(options, 'manager'), ['top:7', 'manager:development']);
  assert.deepEqual(defaultDashboardAccess(options, 'support_manager'), ['top:7', 'manager:support']);
  assert.deepEqual(defaultDashboardAccess(options, 'purchaser'), ['top:7']);
});

type Route = {
  GET(): Promise<Response>;
  POST(request: Request): Promise<Response>;
  PUT(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response>;
  DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response>;
};

function api(session: AdminSession | null) {
  const writes: unknown[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const readScopes: unknown[] = [];
  const users = [
    { id: 'admin:1', numericId: 1, source: 'admin', role: 'admin', name: 'Protected administrator', login: 'private-admin', isActive: true, dashboardAccess: [] },
    { id: 'admin:4', numericId: 4, source: 'admin', role: 'admintop', name: 'Delegated', login: 'delegated', isActive: true, dashboardAccess: [] },
    { id: 'manager:5', numericId: 5, source: 'manager', role: 'manager', name: 'Employee', login: 'employee', email: '', isActive: true, canManageTopDashboard: false, supportManagerId: null, dashboardAccess: [] },
  ];
  const modules: Record<string, unknown> = {
    '@/shared/lib/adminAuth': {
      requireDashboardAccessManagementSession: async () => canAssignDashboardAccess(session) ? { denied: null, session } : { denied: new Response(null, { status: session ? 403 : 401 }), session: null },
      hashPassword: () => 'hash-not-for-response',
    },
    '@/shared/lib/accessUserManagement': management,
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => null },
    '@/shared/lib/dashboardAccess': dashboards,
    '@/shared/lib/db/dashboardAccessRepo': { getDashboardGrantOptions: async () => [{ key: 'top:7', title: 'Shared' }], dashboardGrantOptionsVersion: () => 'a'.repeat(64) },
    '@/shared/lib/db': {
      getAccessUsers: async (_id: number, actorRole: AdminSessionRole) => { readScopes.push(actorRole); return actorRole === 'admin' ? users : users.filter((user) => user.role !== 'admin'); },
      createAccessUser: async (input: Record<string, unknown>, actorRole: AdminSessionRole) => {
        management.assertAccessUserManagementAllowed(actorRole, String(input.role));
        if (input.dashboardAccess !== undefined && input.dashboardOptionsVersion !== 'a'.repeat(64)) throw new management.DashboardOptionsConflictError();
        writes.push({ input, actorRole });
        return { ...users[2], id: 'manager:6', role: input.role };
      },
      updateAccessUser: async (id: string, input: Record<string, unknown>, _currentId: number, actorRole: AdminSessionRole) => {
        const user = users.find((item) => item.id === id)!;
        management.assertAccessUserManagementAllowed(actorRole, user.role, String(input.role));
        if (actorRole === 'admintop') management.assertDelegatedAccessOnly(user as Parameters<typeof management.assertDelegatedAccessOnly>[0], input as Parameters<typeof management.assertDelegatedAccessOnly>[1]);
        writes.push({ input, actorRole });
        return { previous: user, user, passwordChanged: Boolean(input.passwordHash), permissionsChanged: true };
      },
      deleteAccessUser: async (id: string, _currentId: number, actorRole: AdminSessionRole) => {
        const user = users.find((item) => item.id === id)!;
        management.assertAccessUserManagementAllowed(actorRole, user.role);
        writes.push({ id, actorRole });
        return user;
      },
      revokeAdminUserSessions: async () => {},
      revokeManagerSessions: async () => {},
    },
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async (event: Record<string, unknown>) => audits.push(event) },
    '@/shared/lib/originProtection': { enforceSameOriginRequest },
    '@/shared/lib/passwordPolicy': { validatePasswordPolicy: () => ({ ok: true }) },
    '@/shared/lib/rateLimit': { getClientIp: () => '127.0.0.1' },
    '@/shared/lib/wholesaleSecurity': { normalizeTextField: (value: unknown) => typeof value === 'string' ? value.trim() : '' },
  };
  const load = (path: string) => {
    const code = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const loaded = { exports: {} as Route };
    new Function('require', 'module', 'exports', code)((key: string) => { assert.ok(key in modules, key); return modules[key]; }, loaded, loaded.exports);
    return loaded.exports;
  };
  return { collection: load('src/app/api/admin/users/route.ts'), item: load('src/app/api/admin/users/[id]/route.ts'), writes, audits, readScopes };
}

const delegated: AdminSession = { role: 'admintop', adminUserId: 4, sessionId: 'stored' };
const context = (id = 'manager:5') => ({ params: Promise.resolve({ id }) });
function request(method: string, overrides: Record<string, unknown> = {}, origin = 'https://example.test') {
  return new Request('https://example.test/api/admin/users', {
    method, headers: { origin, 'Content-Type': 'application/json' },
    ...(method === 'DELETE' ? {} : { body: JSON.stringify({ name: 'Employee', login: 'employee', email: '', role: 'manager', password: method === 'POST' ? 'StrongNewPassword123' : '', dashboardAccess: ['top:7'], dashboardAccessVersion: 'a'.repeat(64), dashboardOptionsVersion: 'a'.repeat(64), ...overrides }) }),
  });
}

test('Admin TOP users API scopes reads and never returns protected admin profile or credentials', async () => {
  const scoped = api(delegated);
  const result = await scoped.collection.GET();
  const body = await result.json();
  assert.equal(result.status, 200);
  assert.match(result.headers.get('cache-control')!, /no-store/);
  assert.equal(body.canManageSiteAdmins, false);
  assert.equal(body.dashboardOptionsVersion, 'a'.repeat(64));
  assert.deepEqual(scoped.readScopes, ['admintop']);
  assert.equal(body.users.some((user: { role: string }) => user.role === 'admin'), false);
  assert.doesNotMatch(JSON.stringify(body), /private-admin|password|hash/i);
});

test('new-user explicit grants require current options while untouched input inherits atomically', async () => {
  for (const version of [undefined, '', 'forged', 'b'.repeat(64)]) {
    const scoped = api(delegated);
    assert.equal((await scoped.collection.POST(request('POST', { dashboardOptionsVersion: version }))).status, 409);
    assert.deepEqual(scoped.writes, []);
  }
  const scoped = api(delegated);
  assert.equal((await scoped.collection.POST(request('POST', { dashboardAccess: undefined, dashboardOptionsVersion: undefined }))).status, 200);
  assert.equal((scoped.writes[0] as { input: { dashboardAccess?: string[] } }).input.dashboardAccess, undefined);
});

test('Admin TOP can create non-admin employees and update only existing dashboard access', async () => {
  for (const role of ['wholesale_admin', 'top', 'admintop', 'purchaser', 'manager', 'support_manager']) {
    const scoped = api(delegated);
    assert.equal((await scoped.collection.POST(request('POST', { role }))).status, 200);
    assert.equal((scoped.writes[0] as { actorRole: string }).actorRole, 'admintop');
    assert.equal(scoped.audits[0].actorType, 'admintop');
  }
  const scoped = api(delegated);
  assert.equal((await scoped.item.PUT(request('PUT'), context())).status, 200);
  assert.equal(scoped.audits.some((event) => event.eventType === 'password_changed'), false);
  assert.equal((await scoped.item.DELETE(request('DELETE'), context())).status, 403);
  for (const change of [{password:'Replacement123'}, {name:'Changed'}, {login:'changed'}, {email:'changed@example.test'}, {isActive:false}, {role:'purchaser'}, {canManageTopDashboard:true}, {supportManagerId:12}]) {
    assert.equal((await scoped.item.PUT(request('PUT', change), context())).status, 403);
  }
  assert.equal(scoped.writes.length, 1, 'only the dashboard grant edit reaches the write');
});

test('malicious role/body values cannot create, promote, change or delete site-admin accounts', async () => {
  const scoped = api(delegated);
  assert.equal((await scoped.collection.POST(request('POST', { role: 'admin', actorRole: 'admin' }))).status, 403);
  assert.equal((await scoped.item.PUT(request('PUT', { role: 'admin' }), context())).status, 403);
  for (const changes of [{ password: 'HackedPassword123' }, { isActive: false }, { dashboardAccess: [] }, { name: 'Changed' }, { role: 'purchaser' }]) {
    assert.equal((await scoped.item.PUT(request('PUT', { ...changes, actorRole: 'admin' }), context('admin:1'))).status, 403);
  }
  assert.equal((await scoped.item.DELETE(request('DELETE'), context('admin:1'))).status, 403);
  assert.deepEqual(scoped.writes, []);
  assert.deepEqual(scoped.audits, []);
});

test('other roles, invalid delegated identities and cross-origin changes are denied before writes', async () => {
  for (const session of [null, { role: 'admintop' }, ...(['top', 'manager', 'support_manager', 'purchaser', 'wholesale_admin'] as const).map((role) => ({ ...delegated, role, managerId: 5, canManageTopDashboard: true }))] as Array<AdminSession | null>) {
    const scoped = api(session);
    assert.equal((await scoped.collection.GET()).status, session ? 403 : 401);
    assert.equal((await scoped.collection.POST(request('POST'))).status, session ? 403 : 401);
    assert.equal((await scoped.item.PUT(request('PUT'), context())).status, session ? 403 : 401);
    assert.equal((await scoped.item.DELETE(request('DELETE'), context())).status, session ? 403 : 401);
    assert.deepEqual(scoped.writes, []);
  }
  const scoped = api(delegated);
  assert.equal((await scoped.collection.POST(request('POST', {}, 'https://evil.test'))).status, 403);
  assert.equal((await scoped.item.PUT(request('PUT', {}, 'https://evil.test'), context())).status, 403);
  assert.equal((await scoped.item.DELETE(request('DELETE', {}, 'https://evil.test'), context())).status, 403);
  assert.deepEqual(scoped.writes, []);
});
