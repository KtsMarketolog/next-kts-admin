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

test('currency report belongs only to persisted Admin and Admin TOP, never general TOP grants', () => {
  for (const role of ['admin', 'admintop', 'top', 'manager', 'support_manager', 'purchaser', 'wholesale_admin'] as const) {
    const session: AdminSession = { role, adminUserId: 5, managerId: 9, sessionId: 'synthetic',
      canAccessTopDashboard: true, canManageTopDashboard: true, dashboardAccess: ['currency-rates'] };
    const expected = role === 'admin' || role === 'admintop';
    assert.equal(access.canAccessCurrencyDashboard(session), expected, role);
    assert.equal(getReportEntries(session).some(({ key }) => key === 'currency-rates'), expected);
    assert.equal(access.canAccessCurrencyDashboard({ ...session, sessionId: undefined }), false);
  }
  assert.equal(access.canAccessCurrencyDashboard(null), false);
  for (const adminUserId of [undefined, 0, -1, 1.5, Infinity]) {
    assert.equal(access.canAccessCurrencyDashboard({ role: 'admintop', sessionId: 'x', adminUserId }), false);
  }
  assert.equal(parseDashboardAccess(['currency-rates']), null);
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
  const infrastructure = new Proxy({}, { get: (_target, key) => {
    if (String(key).endsWith('Error')) return class extends Error {};
    return async () => { calls.push(String(key)); return { revision: 0, current: null, previous: null }; };
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
      renderCurrencyDashboardHtml: () => { calls.push('html'); return '<html></html>'; },
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
  return { exports, calls };
}

test('actual API and HTML route reject unauthorized roles before data reads or source requests', async () => {
  for (const session of [null, { role: 'admin' }, { role: 'top', adminUserId: 1, sessionId: 'x' },
    { role: 'purchaser', adminUserId: 1, sessionId: 'x', dashboardAccess: ['currency-rates'] },
    { role: 'support_manager', managerId: 1, sessionId: 'x', canManageTopDashboard: true }] as Array<AdminSession | null>) {
    for (const [relative, method] of [['route.ts', 'POST'], ['frame/route.ts', 'GET']]) {
      const h = harness(relative, session);
      const response = await h.exports[method](new Request('https://example.test/api/admin/currency-dashboard', { method }));
      assert.equal(response.status, session ? 403 : 401);
      assert.deepEqual(h.calls, []);
      assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
    }
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
