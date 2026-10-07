import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import type { AdminSession } from '../src/shared/lib/adminAuth';
import * as access from '../src/shared/lib/currencyDashboardAccess';
import { getReportEntries, parseDashboardAccess, PURCHASER_DASHBOARD_REPORT_OPTIONS } from '../src/shared/lib/dashboardAccess';
import * as rpc from '../src/shared/lib/currencyDashboardRpc';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';

test('currency report view grants work for all persisted employees without granting management', () => {
  for (const role of ['admin', 'admintop', 'top', 'manager', 'support_manager', 'purchaser', 'wholesale_admin'] as const) {
    const session: AdminSession = { role, adminUserId: 5, managerId: 9, sessionId: 'synthetic',
      canAccessTopDashboard: true, canManageTopDashboard: true, dashboardAccess: ['currency-rates'] };
    const expected = ['admin', 'admintop', 'top', 'manager', 'support_manager'].includes(role);
    assert.equal(access.canAccessCurrencyDashboard(session), true, role);
    assert.equal(access.canManageCurrencyDashboard(session), expected, role);
    assert.equal(getReportEntries(session).some(({ key }) => key === 'currency-rates'), true);
    assert.equal(access.canAccessCurrencyDashboard({ ...session, sessionId: undefined }), false);
  }
  assert.equal(access.canAccessCurrencyDashboard(null), false);
  for (const role of ['admintop', 'top'] as const) {
    for (const adminUserId of [undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const session = { role, sessionId: 'x', adminUserId, canManageTopDashboard: true };
      assert.equal(access.canAccessCurrencyDashboard(session), false);
      assert.equal(access.canManageCurrencyDashboard(session), false);
    }
  }
  for (const role of ['manager', 'support_manager'] as const) {
    for (const managerId of [undefined, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const session: AdminSession = { role, sessionId: 'x', managerId, adminUserId: 6,
        canAccessTopDashboard: true, canManageTopDashboard: true };
      assert.equal(access.canAccessCurrencyDashboard(session), false, `${role}: invalid manager ID ${managerId}`);
      assert.equal(access.canManageCurrencyDashboard(session), false);
      assert.equal(getReportEntries(session).some(({ key }) => key === 'currency-rates'), false);
    }
  }
  for (const role of ['top', 'manager', 'support_manager'] as const) {
    for (const canManageTopDashboard of [undefined, false, true]) {
      const session: AdminSession = { role, sessionId: 'x',
        ...(role === 'top' ? { adminUserId: 6 } : { managerId: 9 }),
        canAccessTopDashboard: false, canManageTopDashboard, dashboardAccess:['currency-rates'] };
      assert.equal(access.canAccessCurrencyDashboard(session), true);
      assert.equal(getReportEntries(session).some(({ key }) => key === 'currency-rates'), true);
      assert.equal(access.canManageCurrencyDashboard(session), canManageTopDashboard === true);
    }
  }
  for (const role of ['admin', 'admintop'] as const) {
    assert.equal(access.canManageCurrencyDashboard({ role, sessionId: 'x', adminUserId: 6,
      canAccessTopDashboard: false, canManageTopDashboard: false }), true);
  }
  assert.deepEqual(parseDashboardAccess(['currency-rates']), ['currency-rates']);
  assert.equal(PURCHASER_DASHBOARD_REPORT_OPTIONS.some(({ key }) => key === 'currency-rates'), false);
});

test('RPC has a closed method list and mutations require an exact revision', () => {
  assert.deepEqual(rpc.parseCurrencyRpcRequest({ method: 'snapshot:get' }), { method: 'snapshot:get', params: {} });
  for (const method of ['fetch', 'eval', 'DELETE', '__proto__', null]) {
    assert.throws(() => rpc.parseCurrencyRpcRequest({ method }));
  }
  for (const expectedRevision of [undefined, null, '1', -1, 1.3, Infinity, 9007199254740992]) {
    assert.throws(() => rpc.parseCurrencyRpcRequest({ method: 'snapshot:save', params: { expectedRevision } }));
  }
  assert.equal(rpc.parseCurrencyRpcRequest({ method: 'snapshot:rollback', params: { expectedRevision: 0 } }).method, 'snapshot:rollback');
});

test('RPC streaming reader rejects oversize, malformed JSON and non-JSON bodies', async () => {
  const make = (body: string, contentType = 'application/json') => new Request('https://example.test/api', {
    method: 'POST', headers: { 'Content-Type': contentType }, body,
  });
  const parsed = await rpc.readCurrencyRpcRequest(make('{"method":"snapshot:get"}'));
  assert.equal(parsed.method, 'snapshot:get');
  await assert.rejects(rpc.readCurrencyRpcRequest(make('x', 'text/plain')), { status: 415 });
  await assert.rejects(rpc.readCurrencyRpcRequest(make('{invalid')), { status: 400 });
  await assert.rejects(rpc.readCurrencyRpcRequest(make(' '.repeat(rpc.CURRENCY_RPC_MAX_BYTES + 1))), { status: 413 });
});

function harness(relative: string, session: AdminSession | null) {
  const calls: string[] = [];
  const callArguments: Array<{ name: string; args: unknown[] }> = [];
  const framePermissions: boolean[] = [];
  const infrastructure = new Proxy({}, { get: (_target, key) => {
    if (String(key).endsWith('Error')) return class extends Error {};
    return async (...args: unknown[]) => {
      calls.push(String(key));
      callArguments.push({ name: String(key), args });
      return { revision: 0, current: null, previous: null };
    };
  } });
  const modules: Record<string, unknown> = {
    '@/shared/lib/adminAuth': { getAdminSession: async () => session },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => { calls.push('limit'); return null; } },
    '@/shared/lib/currencyDashboardAccess': access,
    '@/shared/lib/currencyDashboardRpc': rpc,
    '@/shared/lib/currencyDashboardModel': infrastructure,
    '@/shared/lib/currencyDashboardSources': {
      CurrencySourceError: class extends Error {},
      getCurrencySource: async (kind: string, params: Record<string, unknown>) => {
        assert.equal(kind, 'cbr-daily');
        assert.deepEqual(Object.keys(params), []);
        calls.push('source:cbr-daily');
        return { Date: '2026-09-30', Valute: {} };
      },
    },
    '@/shared/lib/db/currencyDashboardRepo': infrastructure,
    '@/shared/lib/db/securityAuditRepo': infrastructure,
    '@/shared/lib/originProtection': { enforceSameOriginRequest },
    '@/shared/lib/currencyDashboardHtml': {
      renderCurrencyDashboardHtml: (_nonce: string, _origin: string, canManage: boolean) => {
        calls.push('html'); framePermissions.push(canManage); return '<html></html>';
      },
      buildCurrencyDashboardContentSecurityPolicy: () => "connect-src 'none'",
    },
  };
  const exports: Record<string, (request: Request) => Promise<Response>> = {};
  const source = readFileSync(`src/app/api/admin/currency-dashboard/${relative}`, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  runInNewContext(js, { exports, require: (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected module ${name}`);
    return modules[name];
  }, Response, Request, URL, console });
  return { exports, calls, callArguments, framePermissions };
}

test('actual API and HTML route reject unauthorized roles before data reads or source requests', async () => {
  for (const session of [null, { role: 'admin' }, { role: 'top', sessionId: 'x' },
    { role: 'purchaser', adminUserId: 1, sessionId: 'x', dashboardAccess: [] },
    { role: 'manager', adminUserId: 1, sessionId: 'x', canManageTopDashboard: true },
    { role: 'support_manager', managerId: 0, adminUserId: 1, sessionId: 'x', canManageTopDashboard: true },
    { role: 'manager', managerId: 1, canManageTopDashboard: true },
    { role: 'support_manager', managerId: 1, canManageTopDashboard: true }] as Array<AdminSession | null>) {
    for (const [relative, method] of [['route.ts', 'POST'], ['frame/route.ts', 'GET']]) {
      const h = harness(relative, session);
      const response = await h.exports[method](new Request('https://example.test/api/admin/currency-dashboard', { method }));
      assert.equal(response.status, session ? 403 : 401);
      assert.deepEqual(h.calls, []);
      assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
    }
  }
});

test('TOP and both manager roles can read all report data but saving and rollback require the existing management grant', async () => {
  const request = (method: string) => new Request('https://example.test/api/admin/currency-dashboard', {
    method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params: method === 'source' ? { kind: 'cbr-daily' }
      : method.startsWith('snapshot:') && method !== 'snapshot:get' ? { expectedRevision: 0, snapshot: {} } : {} }),
  });
  for (const role of ['top', 'manager', 'support_manager'] as const) {
    for (const canManageTopDashboard of [undefined, false, true]) {
      const session: AdminSession = { role, sessionId: 'x',
        ...(role === 'top' ? { adminUserId: 6 } : { managerId: 9 }),
        canAccessTopDashboard: false, canManageTopDashboard, dashboardAccess:['currency-rates'] };
      for (const [method, expectedCall] of [
        ['snapshot:get', 'readCurrencySnapshot'], ['baselines:get', 'getCurrencyBaselines'], ['source', 'source:cbr-daily'],
      ]) {
        const h = harness('route.ts', session);
        assert.equal((await h.exports.POST(request(method))).status, 200);
        assert.deepEqual(h.calls, ['limit', expectedCall]);
      }
      for (const [method, expectedCall] of [['snapshot:save', 'writeCurrencySnapshot'], ['snapshot:rollback', 'rollbackCurrencySnapshot']]) {
        const h = harness('route.ts', session);
        const response = await h.exports.POST(request(method));
        assert.equal(response.status, canManageTopDashboard ? 200 : 403);
        assert.deepEqual(h.calls, canManageTopDashboard ? ['limit', 'limit', expectedCall, 'recordSecurityEvent'] : ['limit']);
        if (!canManageTopDashboard) assert.equal((await response.json()).code, 'CURRENCY_READ_ONLY');
      }
      const h = harness('frame/route.ts', session);
      const response = await h.exports.GET(new Request('https://example.test/frame?nonce=01234567-89ab-4cde-8fab-0123456789ab', {
        headers: { Referer: 'https://example.test/admin/top/currency-rates' },
      }));
      assert.equal(response.status, 200);
      assert.deepEqual(h.framePermissions, [canManageTopDashboard === true]);
    }
  }
});

test('manager writes and audit events use the manager identity, not an administrator identity', async () => {
  for (const role of ['manager', 'support_manager'] as const) {
    for (const method of ['snapshot:save', 'snapshot:rollback']) {
      const session: AdminSession = { role, managerId: 9, adminUserId: 55, sessionId: 'x', canManageTopDashboard: true };
      const h = harness('route.ts', session);
      const response = await h.exports.POST(new Request('https://example.test/api/admin/currency-dashboard', {
        method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, params: { expectedRevision: 0, snapshot: {} } }),
      }));
      assert.equal(response.status, 200);
      const write = h.callArguments.find(({ name }) => name === (method === 'snapshot:save' ? 'writeCurrencySnapshot' : 'rollbackCurrencySnapshot'));
      assert.equal(write?.args.at(-1), `${role}:9`);
      const audit = h.callArguments.find(({ name }) => name === 'recordSecurityEvent')?.args[0] as Record<string, unknown>;
      assert.equal(audit.actorType, 'manager');
      assert.equal(audit.managerId, 9);
      assert.equal(audit.adminUserId, undefined);
      assert.equal(audit.sessionId, 'x');
      assert.equal(audit.eventType, method === 'snapshot:save' ? 'currency_dashboard_saved' : 'currency_dashboard_rolled_back');
    }
  }
});

test('currency write permission is checked again when TOP or manager management is revoked after opening', async () => {
  for (const role of ['top', 'manager', 'support_manager'] as const) {
    const session: AdminSession = { role, sessionId: 'x',
      ...(role === 'top' ? { adminUserId: 6 } : { managerId: 9 }), canManageTopDashboard: true, dashboardAccess:['currency-rates'] };
    const h = harness('route.ts', session);
    const request = () => new Request('https://example.test/api/admin/currency-dashboard', {
      method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'snapshot:rollback', params: { expectedRevision: 0 } }),
    });
    assert.equal((await h.exports.POST(request())).status, 200);
    h.calls.length = 0;
    session.canManageTopDashboard = false;
    assert.equal((await h.exports.POST(request())).status, 403);
    assert.deepEqual(h.calls, ['limit']);
  }
});

test('actual API rejects cross-site POST and accepts same-origin authorized read', async () => {
  const session: AdminSession = { role: 'admintop', adminUserId: 1, sessionId: 'x' };
  const h = harness('route.ts', session);
  const request = (origin: string) => new Request('https://example.test/api/admin/currency-dashboard', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"method":"snapshot:get"}',
  });
  assert.equal((await h.exports.POST(request('https://evil.test'))).status, 403);
  assert.deepEqual(h.calls, []);
  const response = await h.exports.POST(request('https://example.test'));
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls, ['limit', 'readCurrencySnapshot']);
});

test('frame is only rendered with a same-origin parent and bounded nonce', async () => {
  const h = harness('frame/route.ts', { role: 'admin', sessionId: 'x' });
  const invalid = await h.exports.GET(new Request('https://example.test/frame?nonce=invalid', { headers: { Referer: 'https://example.test/admin' } }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(h.calls, []);
  const valid = await h.exports.GET(new Request('https://example.test/frame?nonce=01234567-89ab-4cde-8fab-0123456789ab', { headers: { Referer: 'https://example.test/admin' } }));
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('Content-Security-Policy'), "connect-src 'none'");
  assert.deepEqual(h.calls, ['html']);
});

test('actual RPC dispatch separates kind from the closed source parameter schema', async () => {
  const h = harness('route.ts', { role: 'admin', sessionId: 'x' });
  const response = await h.exports.POST(new Request('https://example.test/api/admin/currency-dashboard', {
    method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'source', params: { kind: 'cbr-daily' } }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls, ['limit', 'source:cbr-daily']);
});

test('actual scheduled job requires its own configured secret before any source or database access', async () => {
  const source = readFileSync('src/app/api/cron/currency-dashboard/route.ts', 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  for (const [secret, token, expected] of [
    ['', '', 503], ['short', 'short', 503], ['a'.repeat(32), '', 401],
    ['a'.repeat(32), 'b'.repeat(32), 401], ['a'.repeat(32), 'a'.repeat(32), 200],
  ] as const) {
    let calls = 0;
    const modules: Record<string, unknown> = {
      'node:crypto': { timingSafeEqual },
      '@/shared/lib/currencyDashboardAccess': access,
      '@/shared/lib/currencyDashboardJob': { runCurrencyDashboardJob: async () => { calls += 1; return { ok: true }; } },
    };
    const exports: Record<string, (request: Request) => Promise<Response>> = {};
    runInNewContext(js, { exports, Buffer, Response, console,
      process: { env: { CURRENCY_DASHBOARD_CRON_SECRET: secret } },
      require: (name: string) => { assert.ok(name in modules); return modules[name]; },
    });
    const response = await exports.POST(new Request('http://127.0.0.1/api/cron/currency-dashboard', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    }));
    assert.equal(response.status, expected);
    assert.equal(calls, expected === 200 ? 1 : 0);
  }
});
