import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import type { AdminSession, AdminSessionRole } from '../src/shared/lib/adminAuth';
import * as permissions from '../src/shared/lib/dashboardPermissions';
import * as origin from '../src/shared/lib/originProtection';
import * as vault from '../src/shared/lib/employeePasswordVault';

type Repo = typeof import('../src/shared/lib/db/employeePasswordRepo');
type ResponseModule = typeof import('../src/shared/lib/employeePasswordResponse');
type SecurityEvent = import('../src/shared/lib/db/securityAuditRepo').RecordSecurityEventInput;

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

const originalKey = process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY;
process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString('base64');
test.after(() => {
  if (originalKey === undefined) delete process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY;
  else process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = originalKey;
});
const syntheticPassword = 'SyntheticReviewOnly81749!';
const salt = '7'.repeat(32);
const loginHash = `scrypt:${salt}:${crypto.scryptSync(syntheticPassword, salt, 64).toString('hex')}`;
const encrypted = vault.encryptEmployeePassword(syntheticPassword, loginHash);
const roles: AdminSessionRole[] = ['admin', 'wholesale_admin', 'manager', 'support_manager', 'top', 'admintop', 'purchaser'];

function harness(options: {
  role?: AdminSessionRole | null;
  record?: 'present' | 'missing' | 'unavailable' | 'stale' | 'tampered' | 'error';
  limited?: boolean;
  auditError?: boolean;
  writeError?: boolean;
} = {}) {
  const role = options.role === undefined ? 'admin' : options.role;
  const session: AdminSession | null = role ? {
    role, adminUserId: 11, managerId: 12, sessionId: 'synthetic-session', canManageTopDashboard: true,
  } : null;
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const audits: SecurityEvent[] = [];
  const auditWrites: unknown[][] = [];
  const limits: Array<{ key: string; limit: number; windowMs: number }> = [];
  let passwordCiphertext: string | null = options.record === 'unavailable' ? null : encrypted;
  if (options.record === 'tampered') {
    const parts = encrypted.split('.');
    parts[4] = (parts[4][0] === 'a' ? 'b' : 'a') + parts[4].slice(1);
    passwordCiphertext = parts.join('.');
  }
  let stored = options.record === 'missing' ? null : {
    password_hash: options.record === 'stale' ? loginHash.replace(`:${salt}:`, `:${'8'.repeat(32)}:`) : loginHash,
    password_ciphertext: passwordCiphertext,
    display_password: 'synthetic legacy display copy',
  };
  let inTransaction = false;
  let transactions = 0;
  let rollbacks = 0;
  const query = async (sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    if (options.record === 'error') throw new Error(`Synthetic failure ${syntheticPassword} ${loginHash} ${encrypted}`);
    if (sql.startsWith('select')) {
      assert.match(sql, /^select password_hash, password_ciphertext from (?:admin_users|wholesale_managers) where id = \$1(?: for update)?$/);
      assert.equal(sql.endsWith(' for update'), inTransaction);
      return { rows: stored ? [structuredClone(stored)] : [] };
    }
    assert.equal(inTransaction, true, 'a recovered copy must be written in the locked transaction');
    assert.match(sql, /^update (?:admin_users|wholesale_managers) set password_ciphertext = \$2(?:, display_password = '')? where id = \$1$/);
    assert.doesNotMatch(sql, /password_hash\s*=|password_changed_at|wholesale_price|snapshot/);
    assert.ok(stored);
    stored.password_ciphertext = params[1] as string;
    if (sql.includes('display_password')) stored.display_password = '';
    if (options.writeError) throw new Error('Synthetic copy update failure');
    return { rows: [] };
  };
  const repo = load<Repo>('../src/shared/lib/db/employeePasswordRepo.ts', {
    '../employeePasswordVault': vault,
    './schema': { ensureSiteSchema: async () => {} },
    './client': { query, withTransaction: async <T,>(callback: (client: { query: typeof query }) => Promise<T>) => {
      assert.equal(inTransaction, false);
      const before = structuredClone(stored);
      transactions++;
      inTransaction = true;
      try { return await callback({ query }); }
      catch (error) { stored = before; rollbacks++; throw error; }
      finally { inTransaction = false; }
    } },
  });
  // The actual authentication role gates run; only the cookie/session store is IO-stubbed.
  const auth = load<typeof import('../src/shared/lib/adminAuth')>('../src/shared/lib/adminAuth.ts', {
    'next/headers': { cookies: async () => ({ get: () => session ? { value: 'synthetic-cookie' } : undefined }) },
    crypto,
    './authSecret': { getAdminSessionSecret: () => 'synthetic-session-secret' },
    './db/adminSessionsRepo': { getStoredAdminSession: async () => session },
    './dashboardPermissions': permissions,
  });
  const security = load<typeof import('../src/shared/lib/adminSecurity')>('../src/shared/lib/adminSecurity.ts', {
    './adminAuth': auth,
    './rateLimit': { checkDbRateLimit: async (key: string, limit: number, windowMs: number) => {
      assert.equal(queries.length, 0, 'rate limit must precede credential reads');
      limits.push({ key, limit, windowMs });
      return { allowed: !options.limited, retryAfter: 33 };
    } },
  });
  const securityHash = load<typeof import('../src/shared/lib/securityHash')>('../src/shared/lib/securityHash.ts', {
    crypto,
    './authSecret': { getAdminSessionSecret: () => 'synthetic-session-secret' },
  });
  const auditRepo = load<typeof import('../src/shared/lib/db/securityAuditRepo')>('../src/shared/lib/db/securityAuditRepo.ts', {
    '../securityHash': securityHash,
    './schema': { ensureSiteSchema: async () => {} },
    './client': { query: async (sql: string, params: unknown[]) => {
      assert.match(sql, /insert into security_audit_events/);
      if (options.auditError) throw new Error(`Synthetic audit failure ${syntheticPassword}`);
      auditWrites.push(params);
      return { rows: [] };
    } },
  });
  const responses = load<ResponseModule>('../src/shared/lib/employeePasswordResponse.ts', {
    './adminSecurity': security,
    './db/employeePasswordRepo': repo,
    './db/securityAuditRepo': { recordSecurityEvent: async (input: SecurityEvent, auditOptions?: { required?: boolean }) => {
      assert.equal(auditOptions?.required, true, 'password disclosure requires a successfully committed audit event');
      await auditRepo.recordSecurityEvent(input, auditOptions);
      audits.push(input);
    } },
    './originProtection': origin,
    './rateLimit': { getClientIp: () => '192.0.2.7' },
  });
  const route = (kind: 'users' | 'managers') => load<{
    POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  }>(kind === 'users'
    ? '../src/app/api/admin/users/[id]/password/route.ts'
    : '../src/app/api/admin/wholesale/managers/[id]/password/route.ts', {
    '@/shared/lib/adminAuth': auth,
    '@/shared/lib/employeePasswordResponse': responses,
  });
  return { repo, responses, session, queries, audits, auditWrites, limits,
    stored: () => structuredClone(stored), transactions: () => transactions, rollbacks: () => rollbacks,
    run: (kind: 'users' | 'managers', request: Request, id = kind === 'users' ? 'admin:19' : '19') => route(kind).POST(request, { params: Promise.resolve({ id }) }) };
}

function request(headers: HeadersInit = { origin: 'https://example.test' }, body?: string) {
  return new Request('https://example.test/api/admin/users/admin:19/password', { method: 'POST', headers, body });
}

function assertUncached(response: Response) {
  assert.match(response.headers.get('cache-control') ?? '', /private, no-store, max-age=0/);
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('vary'), 'Cookie');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('password endpoint authorization runs the actual role gates for every role and unauthenticated requests', async () => {
  for (const kind of ['users', 'managers'] as const) for (const role of [...roles, null]) {
    const h = harness({ role });
    const response = await h.run(kind, request());
    const allowed = role === 'admin' || (kind === 'managers' && role === 'wholesale_admin');
    assert.equal(response.status, allowed ? 200 : 401, `${kind}: ${role}`);
    assertUncached(response);
    assert.equal(h.queries.length, allowed ? 1 : 0);
    assert.equal(h.audits.length, allowed ? 1 : 0);
    if (allowed) assert.deepEqual(await response.json(), { password: syntheticPassword });
  }
});

test('shared responder independently denies delegated TOP roles and wholesale-admin disclosure of admin credentials', async () => {
  for (const role of roles) for (const identity of ['admin:19', 'manager:19']) {
    const h = harness({ role });
    const response = await h.responses.employeePasswordResponse(request(), identity, h.session!);
    const allowed = role === 'admin' || (role === 'wholesale_admin' && identity.startsWith('manager:'));
    assert.equal(response.status, allowed ? 200 : 403, `${role}: ${identity}`);
    assertUncached(response);
    assert.equal(h.queries.length, allowed ? 1 : 0);
  }
});

test('admin user endpoint resolves both principal types without exposing credential columns', async () => {
  for (const id of ['admin:19', 'manager:19']) {
    const h = harness();
    const response = await h.run('users', request(), id);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { password: syntheticPassword });
    assert.match(h.queries[0].sql, id.startsWith('admin:') ? /from admin_users/ : /from wholesale_managers/);
    assert.deepEqual(h.queries[0].params, [19]);
    assert.equal(h.limits[0].limit, 120);
    assert.equal(h.limits[0].windowMs, 600_000);
    assert.match(h.limits[0].key, /admin:11:action:employee_password_view$/);
    assert.equal(h.audits[0].eventType, 'employee_password_viewed');
    assert.deepEqual(h.audits[0].metadata, { available: true });
    const audit = JSON.stringify([h.audits, h.auditWrites]);
    for (const secret of [syntheticPassword, loginHash, encrypted]) assert.ok(!audit.includes(secret));
  }
});

test('wrong or absent origins are rejected before rate limiting or credential reads', async () => {
  const headers: HeadersInit[] = [
    {}, { origin: 'https://evil.example' }, { referer: 'https://evil.example/' },
    { origin: 'https://evil.example', referer: 'https://example.test/admin' },
  ];
  for (const header of headers) {
    const h = harness();
    const response = await h.run('users', request(header));
    assert.equal(response.status, 403);
    assertUncached(response);
    assert.equal(h.queries.length + h.audits.length + h.limits.length, 0);
  }
  const h = harness();
  assert.equal((await h.run('users', request({ referer: 'https://example.test/admin' }))).status, 200);
});

test('invalid employee identities cannot reach SQL', async () => {
  for (const id of ['19', 'admin:0', 'manager:-1', 'admin:01', 'admin:1 OR 1=1', 'manager:9007199254740992']) {
    const h = harness();
    const response = await h.run('users', request(), id);
    assert.equal(response.status, 403);
    assertUncached(response);
    assert.equal(h.queries.length + h.audits.length + h.limits.length, 0);
  }
});

test('missing, unavailable, tampered and stale copies never return a prior password', async () => {
  for (const record of ['missing', 'unavailable', 'tampered', 'stale'] as const) {
    const h = harness({ record });
    const response = await h.run('users', request());
    assertUncached(response);
    assert.equal(response.status, record === 'missing' ? 404 : 200);
    const body = await response.json();
    assert.ok(!JSON.stringify(body).includes(syntheticPassword));
    if (record !== 'missing') {
      assert.deepEqual(body, { password: null });
      assert.deepEqual(h.audits[0].metadata, { available: false });
    } else assert.equal(h.audits.length, 0);
  }
});

test('rate limit fails before credential lookup, with uncached Retry-After response', async () => {
  const h = harness({ limited: true });
  const response = await h.run('managers', request());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '33');
  assertUncached(response);
  assert.equal(h.queries.length + h.audits.length, 0);
});

test('database and actual required-audit failures do not return secrets', async () => {
  for (const options of [{ record: 'error' as const }, { auditError: true }]) {
    const h = harness(options);
    const response = await h.run('users', request());
    assert.equal(response.status, 503);
    assertUncached(response);
    const body = await response.text();
    for (const secret of [syntheticPassword, loginHash, encrypted]) assert.ok(!body.includes(secret));
  }
});

test('authorization, same-origin and rate limit checks happen before candidate body reads', async () => {
  for (const [options, headers, status] of [
    [{ role: 'top' }, { origin: 'https://example.test' }, 401],
    [{}, { origin: 'https://evil.example' }, 403],
    [{ limited: true }, { origin: 'https://example.test' }, 429],
  ] as const) {
    const h = harness(options);
    const input = request(headers);
    Object.defineProperty(input, 'body', { get() { throw new Error('A denied request must not read its body'); } });
    assert.equal((await h.run('users', input)).status, status);
    assert.equal(h.queries.length + h.audits.length, 0);
  }
});

test('legacy candidate body is bounded before reading credentials, regardless of Content-Length', async () => {
  for (const body of [
    '{', 'null', '[]', JSON.stringify({ legacyPassword: null }), JSON.stringify({ legacyPassword: 123 }),
    JSON.stringify({ legacyPassword: '' }), JSON.stringify({ legacyPassword: 'x'.repeat(201) }),
    JSON.stringify({ padding: 'x'.repeat(2048), legacyPassword: syntheticPassword }),
  ]) for (const declared of [undefined, '2']) {
    const h = harness();
    const headers = new Headers({ origin: 'https://example.test' });
    if (declared) headers.set('content-length', declared);
    const response = await h.run('users', request(headers, body));
    assert.equal(response.status, 400);
    assertUncached(response);
    assert.equal(h.queries.length + h.audits.length, 0);
  }
  const h = harness();
  assert.equal((await h.run('users', request(undefined, '{}'))).status, 200);
});

test('an explicitly supplied matching browser copy is encrypted under the current hash without changing login credentials', async () => {
  for (const source of ['admin', 'manager'] as const) {
    const h = harness({ record: 'unavailable' });
    const response = await h.run('users', request(undefined, JSON.stringify({ legacyPassword: syntheticPassword })), `${source}:19`);
    assert.equal(response.status, 200);
    assertUncached(response);
    assert.deepEqual(await response.json(), { password: syntheticPassword });
    assert.equal(h.transactions(), 1);
    assert.equal(h.queries.length, 2);
    assert.equal(h.stored()!.password_hash, loginHash);
    assert.equal(vault.decryptEmployeePassword(h.stored()!.password_ciphertext, loginHash), syntheticPassword);
    if (source === 'manager') assert.equal(h.stored()!.display_password, '');
    assert.deepEqual(h.audits[0].metadata, { available: true });
    assert.ok(!JSON.stringify(h.auditWrites).includes(syntheticPassword));
  }
});

test('missing or incorrect browser candidates cannot populate or replace the server copy', async () => {
  for (const record of ['unavailable', 'stale', 'missing'] as const) {
    const h = harness({ record });
    const before = h.stored();
    const result = await h.repo.readEmployeePassword({ source: 'admin', id: 19 }, 'SyntheticWrongPassword981!');
    assert.deepEqual(result, record === 'missing' ? null : { password: null });
    assert.deepEqual(h.stored(), before);
    assert.equal(h.queries.length, 1);
    assert.equal(h.transactions(), 1);
  }
  const h = harness({ record: 'unavailable' });
  assert.deepEqual(await h.repo.readEmployeePassword({ source: 'manager', id: 19 }), { password: null });
  assert.equal(h.transactions(), 0);
  assert.equal(h.queries.length, 1);
});

test('browser candidates never overwrite an existing valid server ciphertext, even if stale', async () => {
  for (const legacyPassword of [syntheticPassword, 'SyntheticObsoleteBrowserCopy!']) {
    const h = harness();
    const before = h.stored();
    assert.deepEqual(await h.repo.readEmployeePassword({ source: 'manager', id: 19 }, legacyPassword), { password: syntheticPassword });
    assert.deepEqual(h.stored(), before);
    assert.equal(h.queries.length, 1);
    assert.equal(h.transactions(), 1);
  }
});

test('failed copy persistence rolls back the encrypted copy and returns no password', async () => {
  const h = harness({ record: 'unavailable', writeError: true });
  const before = h.stored();
  const response = await h.run('users', request(undefined, JSON.stringify({ legacyPassword: syntheticPassword })));
  assert.equal(response.status, 503);
  assertUncached(response);
  assert.ok(!(await response.text()).includes(syntheticPassword));
  assert.equal(h.rollbacks(), 1);
  assert.deepEqual(h.stored(), before);
  assert.equal(h.audits.length, 0);
});
