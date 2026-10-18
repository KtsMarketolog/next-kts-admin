import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import type { AdminSession, AdminSessionRole } from '../src/shared/lib/adminAuth';
import * as permissions from '../src/shared/lib/dashboardPermissions';
import * as origin from '../src/shared/lib/originProtection';
import type { RecordSecurityEventInput } from '../src/shared/lib/db/securityAuditRepo';

type Route = typeof import('../src/app/api/admin/clients/[id]/password/route');
type Password = Awaited<ReturnType<typeof import('../src/shared/lib/db/clientPasswordRepo').readClientCompanyPassword>>;

function load<T>(filename: string, dependencies: Record<string, unknown>): T {
  const code = ts.transpileModule(readFileSync(new URL(filename, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, output, output.exports);
  return output.exports as T;
}

const roles: AdminSessionRole[] = ['admin', 'wholesale_admin', 'manager', 'support_manager', 'top', 'admintop', 'purchaser'];
const operational = ['admin', 'wholesale_admin', 'manager', 'support_manager'];
const password = 'SyntheticClientReviewOnly391!';
const secretError = new Error(`${password} synthetic-hash synthetic-key synthetic-ciphertext`);

function harness(options: {
  role?: AdminSessionRole | null;
  bypassAuthGate?: boolean;
  authError?: boolean;
  limited?: boolean;
  limitError?: boolean;
  readError?: boolean;
  auditError?: boolean;
  result?: Password;
  auditStarted?: () => void;
  auditGate?: Promise<void>;
} = {}) {
  const role = options.role === undefined ? 'admin' : options.role;
  const manager = role === 'manager' || role === 'support_manager';
  const session: AdminSession | null = role ? {
    role, managerId: manager ? 12 : undefined, adminUserId: manager ? undefined : 11,
    sessionId: 'synthetic-session', canManageTopDashboard: true,
    canAccessTopDashboard: undefined, dashboardAccess: undefined,
  } : null;
  const reads: Array<{ companyId: number; session: AdminSession }> = [];
  const audits: RecordSecurityEventInput[] = [];
  const auditWrites: unknown[][] = [];
  const limits: Array<{ key: string; limit: number; windowMs: number }> = [];
  let result: Password = options.result === undefined ? { password, clientUserId: 31 } : options.result;
  // Exercise the real requireEmployee role gate; only cookies/session persistence is stubbed.
  const auth = load<typeof import('../src/shared/lib/adminAuth')>('../src/shared/lib/adminAuth.ts', {
    'next/headers': { cookies: async () => {
      if (options.authError) throw secretError;
      return { get: () => session ? { value: 'synthetic-cookie' } : undefined };
    } },
    crypto,
    './authSecret': { getAdminSessionSecret: () => 'synthetic-session-secret' },
    './db/adminSessionsRepo': { getStoredAdminSession: async () => session },
    './dashboardPermissions': permissions,
  });
  const security = load<typeof import('../src/shared/lib/adminSecurity')>('../src/shared/lib/adminSecurity.ts', {
    './adminAuth': auth,
    './rateLimit': { checkDbRateLimit: async (key: string, limit: number, windowMs: number) => {
      limits.push({ key, limit, windowMs });
      if (options.limitError) throw secretError;
      return { allowed: !options.limited, retryAfter: 33 };
    } },
  });
  // Run the actual required-audit failure handling, not a permissive audit stub.
  const auditRepo = load<typeof import('../src/shared/lib/db/securityAuditRepo')>('../src/shared/lib/db/securityAuditRepo.ts', {
    '../securityHash': { hashSensitiveValue: () => 'synthetic-digest', safeHeaderValue: (value: unknown) => value ?? '' },
    './schema': { ensureSiteSchema: async () => {} },
    './client': { query: async (sql: string, params: unknown[]) => {
      assert.match(sql, /insert into security_audit_events/);
      options.auditStarted?.();
      await options.auditGate;
      if (options.auditError) throw secretError;
      auditWrites.push(params);
      return { rows: [] };
    } },
  });
  const route = load<Route>('../src/app/api/admin/clients/[id]/password/route.ts', {
    '@/shared/lib/adminAuth': options.bypassAuthGate
      ? { ...auth, requireEmployee: async () => ({ denied: null, session }) } : auth,
    '@/shared/lib/adminSecurity': security,
    '@/shared/lib/db/clientPasswordRepo': { readClientCompanyPassword: async (companyId: number, value: AdminSession) => {
      assert.equal(limits.length, reads.length + 1, 'actor limit must precede every credential read');
      reads.push({ companyId, session: value });
      if (options.readError) throw secretError;
      return result;
    } },
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async (input: RecordSecurityEventInput, settings?: { required?: boolean }) => {
      assert.equal(settings?.required, true, 'disclosure requires a committed audit event');
      await auditRepo.recordSecurityEvent(input, settings);
      audits.push(input);
    } },
    '@/shared/lib/originProtection': origin,
  });
  return {
    route, session, reads, audits, auditWrites, limits,
    setResult(value: Password) { result = value; },
    run: (input = request(), id = '19') => route.POST(input, { params: Promise.resolve({ id }) }),
  };
}

function request(headers: HeadersInit = { origin: 'https://example.test' }, body = '{}') {
  return new Request('https://example.test/api/admin/clients/19/password', { method: 'POST', headers, body });
}

function assertUncached(response: Response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('vary'), 'Cookie');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('client password route only exports POST and uses actual employee authorization for every role', async () => {
  for (const role of [...roles, null]) {
    const h = harness({ role });
    assert.deepEqual(Object.keys(h.route), ['POST'], 'no GET/HEAD password disclosure');
    const response = await h.run();
    const allowed = role !== null && operational.includes(role);
    assert.equal(response.status, allowed ? 200 : 401, `${role}`);
    assertUncached(response);
    assert.equal(h.reads.length, allowed ? 1 : 0);
    assert.equal(h.audits.length, allowed ? 1 : 0);
    if (allowed) {
      assert.deepEqual(await response.json(), { password });
      assert.deepEqual(h.reads[0], { companyId: 19, session: h.session });
    }
  }
});

test('operational-role defense rejects delegated dashboard roles even if upstream authorization weakens', async () => {
  for (const role of ['top', 'admintop', 'purchaser', null] as const) {
    const h = harness({ role, bypassAuthGate: true });
    const response = await h.run();
    assert.equal(response.status, 403);
    assertUncached(response);
    assert.equal(h.reads.length + h.audits.length + h.limits.length, 0);
  }
});

test('only canonical positive safe company IDs reach rate limits or the repository', async () => {
  for (const id of ['', '0', '-1', '+19', '019', '19.0', '19e0', ' 19', '19 ', '19\n', '0x13', '19/20', 'NaN', 'Infinity', '9007199254740992']) {
    const h = harness();
    const response = await h.run(request(), id);
    assert.equal(response.status, 400, JSON.stringify(id));
    assertUncached(response);
    assert.equal(h.reads.length + h.audits.length + h.limits.length, 0);
  }
});

test('missing/foreign origins fail before actor limits and credential reads; same-origin referer is accepted', async () => {
  const invalidHeaders: HeadersInit[] = [{}, { origin: 'https://foreign.test' }, { referer: 'https://foreign.test/' },
    { origin: 'https://foreign.test', referer: 'https://example.test/admin' }];
  for (const headers of invalidHeaders) {
    const h = harness();
    const response = await h.run(request(headers));
    assert.equal(response.status, 403);
    assertUncached(response);
    assert.equal(h.reads.length + h.audits.length + h.limits.length, 0);
  }
  assert.equal((await harness().run(request({ referer: 'https://example.test/admin' }))).status, 200);
});

test('credential reads pass current session scope and never reveal a missing/out-of-scope company', async () => {
  for (const role of ['admin', 'wholesale_admin', 'manager', 'support_manager'] as const) {
    const h = harness({ role, result: null });
    const response = await h.run();
    assert.equal(response.status, 404);
    assertUncached(response);
    assert.deepEqual(h.reads, [{ companyId: 19, session: h.session }]);
    assert.equal(h.audits.length, 0);
    assert.deepEqual(await response.json(), { error: 'Клиент не найден' });
  }
});

test('each actor is limited to 120 password requests per ten minutes before password lookup', async () => {
  for (const role of ['admin', 'wholesale_admin', 'manager', 'support_manager'] as const) {
    const h = harness({ role, limited: true });
    const response = await h.run();
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '33');
    assertUncached(response);
    assert.deepEqual(h.limits, [{
      key: `admin_action:user:${role.includes('manager') ? 'manager:12' : 'admin:11'}:action:client_password_view`,
      limit: 120, windowMs: 600_000,
    }]);
    assert.equal(h.reads.length + h.audits.length, 0);
  }
});

test('required audit records only actor/entity IDs and availability, never credential values', async () => {
  for (const role of ['admin', 'wholesale_admin', 'manager', 'support_manager'] as const) for (const available of [true, false]) {
    const h = harness({ role, result: { password: available ? password : null, clientUserId: 31 } });
    const response = await h.run();
    assert.equal(response.status, 200);
    assertUncached(response);
    assert.deepEqual(await response.json(), { password: available ? password : null });
    const manager = role.includes('manager');
    assert.deepEqual(h.audits, [{
      eventType: 'client_password_viewed', actorType: manager ? 'manager' : role,
      adminUserId: manager ? null : 11, managerId: manager ? 12 : null,
      sessionId: 'synthetic-session', entityType: 'client_user', entityId: 31,
      metadata: { companyId: 19, available },
    }]);
    assert.ok(!JSON.stringify([h.audits, h.auditWrites]).includes(password));
  }
});

test('password response waits for required audit commit, not just scheduling the event', async () => {
  let startAudit!: () => void;
  let finishAudit!: () => void;
  const started = new Promise<void>((resolve) => { startAudit = resolve; });
  const gate = new Promise<void>((resolve) => { finishAudit = resolve; });
  const h = harness({ auditStarted: startAudit, auditGate: gate });
  let returned = false;
  const pending = h.run().then((response) => { returned = true; return response; });
  await started;
  assert.equal(returned, false);
  assert.equal(h.audits.length, 0);
  finishAudit();
  const response = await pending;
  assert.deepEqual(await response.json(), { password });
  assert.equal(h.auditWrites.length, 1);
});

test('auth/limit/repository/required-audit/parameter failures are uncached 503 without secrets or logs', async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...values: unknown[]) => { logs.push(values); });
  for (const options of [{ authError: true }, { limitError: true }, { readError: true }, { auditError: true }]) {
    const h = harness(options);
    const response = await h.run();
    assert.equal(response.status, 503);
    assertUncached(response);
    assert.equal(h.audits.length, 0);
    assert.doesNotMatch(await response.text(), /SyntheticClient|synthetic-hash|synthetic-key|synthetic-ciphertext/);
  }
  const response = await harness().route.POST(request(), { params: Promise.reject(secretError) });
  assert.equal(response.status, 503);
  assertUncached(response);
  assert.doesNotMatch(await response.text(), /SyntheticClient|synthetic-hash|synthetic-key|synthetic-ciphertext/);
  assert.deepEqual(logs, []);
});

test('fresh password is fetched for each reveal; browser input cannot recover or overwrite a password', async () => {
  const h = harness();
  const input = request(undefined, JSON.stringify({ legacyPassword: 'ObsoleteBrowserPassword!' }));
  for (const field of ['body', 'json', 'text', 'formData']) {
    Object.defineProperty(input, field, { get() { throw new Error('Password endpoint must not read browser credentials'); } });
  }
  assert.deepEqual(await (await h.run(input)).json(), { password });
  h.setResult({ password: 'SyntheticUpdatedCurrentPassword!', clientUserId: 31 });
  assert.deepEqual(await (await h.run(input)).json(), { password: 'SyntheticUpdatedCurrentPassword!' });
  h.setResult({ password: null, clientUserId: 31 });
  assert.deepEqual(await (await h.run(input)).json(), { password: null });
  assert.equal(h.reads.length, 3);
  assert.equal(h.auditWrites.length, 3);
});
