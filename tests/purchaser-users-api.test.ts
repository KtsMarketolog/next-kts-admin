import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as access from '../src/shared/lib/dashboardAccess';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';

type Route = {
  GET(): Promise<Response>;
  POST(request: Request): Promise<Response>;
  PUT(request: Request, context: {params: Promise<{id: string}>}): Promise<Response>;
};

function routes(authorized = true) {
  const writes: Array<Record<string, unknown>> = [];
  const events: unknown[] = [];
  let reads = 0;
  const user = {id: 'admin:42', numericId: 42, source: 'admin', role: 'purchaser', isActive: true, dashboardAccess: []};
  const modules: Record<string, unknown> = {
    '@/shared/lib/adminAuth': {requireAdminSession: async () => authorized
      ? {session: {role: 'admin', adminUserId: 1, sessionId: 'synthetic-admin'}, denied: null}
      : {denied: new Response(null, {status: 403})}, hashPassword: () => 'synthetic-hash'},
    '@/shared/lib/adminSecurity': {enforceAdminActionRateLimit: async () => null},
    '@/shared/lib/dashboardAccess': access,
    '@/shared/lib/db': {
      getAccessUsers: async () => {reads++; return [user];},
      getTopDashboardBlocks: async () => {reads++; return [{id: 7, title: 'Аналитика продаж'}, {id: 12, title: 'Новый отчёт'}];},
      createAccessUser: async (input: Record<string, unknown>) => {writes.push(input); return {...user, ...input};},
      updateAccessUser: async (_id: string, input: Record<string, unknown>) => {
        writes.push(input);
        return {previous: user, user: {...user, ...input}, permissionsChanged: true};
      },
      revokeAdminUserSessions: async (id: number) => {events.push(['revoke', id]);},
    },
    '@/shared/lib/db/securityAuditRepo': {recordSecurityEvent: async (event: unknown) => {events.push(event);}},
    '@/shared/lib/originProtection': {enforceSameOriginRequest},
    '@/shared/lib/passwordPolicy': {validatePasswordPolicy: () => ({ok: true})},
    '@/shared/lib/rateLimit': {getClientIp: () => '127.0.0.1'},
    '@/shared/lib/wholesaleSecurity': {normalizeTextField: (value: unknown) => typeof value === 'string' ? value.trim() : ''},
  };
  const compile = (filename: string) => {
    const code = ts.transpileModule(readFileSync(new URL(filename, import.meta.url), 'utf8'), {
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
    }).outputText;
    const loaded = {exports: {} as Route};
    new Function('require', 'module', 'exports', code)((name: string) => {
      assert.ok(name in modules, `Unexpected dependency ${name}`);
      return modules[name];
    }, loaded, loaded.exports);
    return loaded.exports;
  };
  return {collection: compile('../src/app/api/admin/users/route.ts'),
    item: compile('../src/app/api/admin/users/[id]/route.ts'), writes, events, readCount: () => reads};
}

const context = {params: Promise.resolve({id: 'admin:42'})};
function request(method: string, dashboardAccess: unknown) {
  return new Request('https://example.test/api/admin/users', {method,
    headers: {origin: 'https://example.test', 'content-type': 'application/json'},
    body: JSON.stringify({name: 'Synthetic', login: 'buyer', role: 'purchaser', password: 'Synthetic12345',
      isActive: true, canManageTopDashboard: true, dashboardAccess})});
}

test('admin options are individual current catalog blocks, never personal MR/MS groups', async () => {
  const api = routes();
  const response = await api.collection.GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control')!, /private.*no-store/);
  const {dashboardOptions} = await response.json();
  assert.deepEqual(dashboardOptions.map((option: {key: string}) => option.key), ['route-planner', 'top:7', 'top:12']);
  assert.equal(dashboardOptions.find((option: {key: string}) => option.key === 'top:12').title, 'Новый отчёт');
  const denied = routes(false);
  assert.equal((await denied.collection.GET()).status, 403);
  assert.equal(denied.readCount(), 0);
});

test('both create and update reject personal group permissions before any write', async () => {
  for (const grant of ['manager:development', 'manager:support', 'manager:*', 'top:*']) {
    const api = routes();
    assert.equal((await api.collection.POST(request('POST', [grant]))).status, 400);
    assert.equal((await api.item.PUT(request('PUT', [grant]), context)).status, 400);
    assert.deepEqual(api.writes, []);
    assert.deepEqual(api.events, []);
  }
});

test('create/update save only selected keys, force purchaser read-only, and revoke sessions on change', async () => {
  const api = routes();
  assert.equal((await api.collection.POST(request('POST', ['top:7', 'top:7']))).status, 200);
  assert.equal((await api.item.PUT(request('PUT', ['top:12']), context)).status, 200);
  assert.deepEqual(api.writes.map((input) => input.dashboardAccess), [['top:7'], ['top:12']]);
  assert.equal(api.writes.every((input) => input.canManageTopDashboard === false), true);
  assert.ok(api.events.some((event) => Array.isArray(event) && event[0] === 'revoke' && event[1] === 42));
});
