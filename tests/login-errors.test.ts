import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import * as crypto from 'node:crypto';
import ts from 'typescript';

import { isEmailTwoFactorOutageActive } from '../src/shared/lib/emailTwoFactorOutage';

function load<T>(path: string, modules: Record<string, unknown>, messages: unknown[][] = [], env = {}) {
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports, Response, Buffer, process: { env },
    console: { error: (...values: unknown[]) => messages.push(values) },
    require(name: string) { assert.ok(name in modules, name); return modules[name]; },
  });
  return exports as T;
}

type RouteKind = 'admin' | 'client';
const privateMessage = 'private SMTP password, recipient, code and connection details';
function harness(kind: RouteKind, options: {
  invalidPassword?: boolean; smtpFails?: boolean; invalidationFails?: boolean;
  databaseFails?: boolean; twoFactor?: boolean; missingEmail?: boolean; validCode?: boolean;
  employee?: 'admin' | 'manager' | 'env';
  credentialsChanged?: boolean;
  outage?: { start: string; end: string; now: string };
} = {}) {
  const messages: unknown[][] = [];
  const invalidated: unknown[][] = [];
  const events: Array<Record<string, unknown>> = [];
  let challenges = 0;
  let sessions = 0;
  let sent = 0;
  const account = {
    id: 7, login: 'synthetic@example.test', email: options.missingEmail ? '' : 'synthetic@example.test',
    role: options.employee === 'manager' ? 'manager' : 'admin',
    isActive: true, companyIsActive: true, companyId: 5, passwordHash: 'synthetic-hash',
    passwordChangedAt: null, requireTwoFactor: options.twoFactor !== false,
  };
  // A client without a usable address is a malformed stored account, not a password failure.
  if (kind === 'client' && options.missingEmail) account.login = 'synthetic-no-email';
  const actor = {
    credentialProof: '1'.repeat(64),
    challengeId: 'challenge-a', createdAt: new Date().toISOString(), login: account.login,
    actorType: kind === 'client' ? 'client' : options.employee === 'manager' ? 'manager' : 'admin',
    role: kind === 'client' ? 'client' : account.role,
    adminUserId: 7, managerId: 7, clientUserId: 7,
  };
  const delivery = load('src/shared/lib/twoFactorDelivery.ts', {
    './mailer': { sendSystemMail: async (_input: unknown, timeouts: Record<string, number>) => {
      sent++;
      assert.equal(timeouts.connectionTimeout, 10_000);
      assert.equal(timeouts.greetingTimeout, 10_000);
      assert.equal(timeouts.socketTimeout, 20_000);
      if (options.smtpFails) throw new Error(privateMessage);
    } },
    './db/twoFactorRepo': { invalidateTwoFactorChallenge: async (...args: unknown[]) => {
      invalidated.push(args);
      if (options.invalidationFails) throw new Error(privateMessage);
    } },
  }, messages);
  const lookup = async () => {
    if (options.databaseFails) throw new Error(privateMessage);
    return account;
  };
  const proofs = load<typeof import('../src/shared/lib/loginCredentialProof')>('src/shared/lib/loginCredentialProof.ts', {
    crypto, './authSecret': { getAdminSessionSecret: () => 'synthetic-login-proof-secret' },
  });
  const requireProof = (input: { credentialProof: string }) => {
    assert.match(input.credentialProof, /^[a-f0-9]{64}$/, 'every real login path must pass a verified snapshot proof');
    if (options.validCode) assert.equal(input.credentialProof, actor.credentialProof, 'OTP keeps its original credential proof');
    if (options.credentialsChanged) throw new proofs.LoginCredentialsChangedError();
  };
  const createSession = async (_identity: unknown, input: { credentialProof: string }) => {
    requireProof(input);
    sessions++;
  };
  const modules = {
    '@/shared/lib/loginCredentialProof': proofs,
    '@/shared/lib/adminAuth': {
      createAdminSession: createSession, createEmployeeSession: createSession,
      verifyPassword: () => !options.invalidPassword,
      validateAdminPassword: () => options.employee === 'env' && !options.invalidPassword,
    },
    '@/shared/lib/clientAuth': { createClientSession: createSession },
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async (event: Record<string, unknown>) => { events.push(event); } },
    '@/shared/lib/db/twoFactorRepo': {
      createTwoFactorChallenge: async (input: { credentialProof: string }) => { requireProof(input); challenges++; return 'challenge-a'; },
      consumeTwoFactorChallenge: async () => options.validCode ? actor : null,
      generateTwoFactorCode: () => '123456', isTwoFactorEnabled: () => options.twoFactor !== false,
    },
    '@/shared/lib/db': {
      getAdminUserByLogin: async () => options.employee === 'manager' || options.employee === 'env' ? null : lookup(),
      getWholesaleManagerByLogin: async () => options.employee === 'manager' ? lookup() : null,
      getClientUserByLogin: lookup,
      recordWholesaleManagerLogin: async () => {}, trackAnalyticsEvent: async () => {}, recordClientUserLogin: async () => {},
    },
    '@/shared/lib/twoFactorDelivery': delivery,
    '@/shared/lib/emailTwoFactorOutage': {
      isEmailTwoFactorOutageActive: () => isEmailTwoFactorOutageActive(
        new Date(options.outage?.now ?? '2026-10-12T13:45:10.000Z'),
        { EMAIL_2FA_OUTAGE_START_AT: options.outage?.start, EMAIL_2FA_OUTAGE_END_AT: options.outage?.end },
      ),
    },
    '@/shared/lib/publicSession': {
      LOGIN_SESSION_COOKIE: 'kts_login_sid',
      getOrCreateSessionCookie: () => ({ sessionId: 'synthetic-login-session' }),
      applySessionCookie: (headers: Headers) => { headers.set('Set-Cookie', 'synthetic-login-cookie'); },
    },
    '@/shared/lib/loginSource': { getLoginSourceIp: () => '192.0.2.10' },
    '@/shared/lib/rateLimit': {
      checkDbRateLimit: async () => ({ allowed: true }), getClientIp: () => 'synthetic-ip', resetDbRateLimit: async () => {},
    },
    '@/shared/lib/originProtection': { enforceSameOriginRequest: () => null },
  };
  const route = load<{ POST: (request: Request) => Promise<Response> }>(`src/app/api/${kind}/login/route.ts`, modules, messages,
    options.employee === 'env' && !options.missingEmail ? { ADMIN_2FA_EMAIL: 'synthetic@example.test' } : {});
  return {
    post: (body: unknown = { login: account.login, password: 'synthetic-password' }) => route.POST(new Request(`https://example.test/api/${kind}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })),
    messages, invalidated, events,
    counts: () => ({ challenges, sessions, sent }),
  };
}

test('changed credentials fail closed for direct login, challenge creation and OTP completion without secret disclosure', async () => {
  for (const kind of ['admin', 'client'] as const) {
    for (const employee of (kind === 'admin' ? ['admin', 'manager', 'env'] : ['admin']) as Array<'admin' | 'manager' | 'env'>) {
      for (const flow of ['direct', 'challenge', 'otp'] as const) {
        // Environment-admin OTP fixture needs no account ID; the environment
        // branch itself is covered by direct/challenge and real PostgreSQL tests.
        if (employee === 'env' && flow === 'otp') continue;
        const h = harness(kind, { employee, credentialsChanged: true, twoFactor: flow !== 'direct', validCode: flow === 'otp' });
        const response = await h.post(flow === 'otp' ? { twoFactorChallengeId: 'challenge-a', twoFactorCode: '123456' } : undefined);
        assert.equal(response.status, 401, `${kind}/${employee}/${flow}`);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.deepEqual(h.counts(), { challenges: 0, sessions: 0, sent: 0 });
        assert.doesNotMatch(JSON.stringify([await response.json(), h.messages]), /synthetic|123456|[a-f0-9]{64}/);
      }
    }
  }
});

for (const kind of ['admin', 'client'] as const) {
  test(`${kind}: SMTP failure returns safe 503, cancels only its challenge, and never logs in`, async () => {
    const h = harness(kind, { smtpFails: true });
    const response = await h.post();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Set-Cookie'), 'synthetic-login-cookie');
    assert.deepEqual(await response.json(), { error: 'Unable to send confirmation code', code: 'TWO_FACTOR_DELIVERY_FAILED' });
    assert.deepEqual(h.invalidated, [['challenge-a', 'synthetic-login-session']]);
    assert.deepEqual(h.counts(), { challenges: 1, sessions: 0, sent: 1 });
    assert.deepEqual(h.messages, [['TWO_FACTOR_DELIVERY_FAILED']]);
    assert.equal(h.events.length, 0);
  });

  test(`${kind}: cleanup failure and database failure expose no exception details or challenge`, async () => {
    for (const options of [{ smtpFails: true, invalidationFails: true }, { databaseFails: true }]) {
      const h = harness(kind, options);
      const response = await h.post();
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.code, options.smtpFails ? 'TWO_FACTOR_DELIVERY_FAILED' : 'LOGIN_UNAVAILABLE');
      assert.equal(body.challengeId, undefined);
      assert.equal(h.counts().sessions, 0);
      assert.doesNotMatch(JSON.stringify([body, h.messages]), /private|password|recipient|123456|synthetic-login-session/);
    }
  });

  test(`${kind}: missing delivery address is a service error and bad password remains 401`, async () => {
    const missing = harness(kind, { missingEmail: true });
    const response = await missing.post();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'TWO_FACTOR_DELIVERY_FAILED');
    assert.deepEqual(missing.counts(), { challenges: 0, sessions: 0, sent: 0 });
    const bad = harness(kind, { invalidPassword: true });
    assert.equal((await bad.post()).status, 401);
    assert.deepEqual(bad.counts(), { challenges: 0, sessions: 0, sent: 0 });
  });

  test(`${kind}: successful SMTP only starts confirmation; valid code is still required`, async () => {
    const h = harness(kind);
    const response = await h.post();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.twoFactorRequired, true);
    assert.equal(body.challengeId, 'challenge-a');
    assert.deepEqual(h.counts(), { challenges: 1, sessions: 0, sent: 1 });
    assert.equal(h.invalidated.length, 0);
    assert.equal(h.events[0].eventType, 'two_factor_challenge_created');
    const invalid = await h.post({ twoFactorChallengeId: body.challengeId, twoFactorCode: '000000' });
    assert.equal(invalid.status, 401);
    assert.equal(h.counts().sessions, 0);
    const valid = harness(kind, { validCode: true });
    assert.equal((await valid.post({ twoFactorChallengeId: 'challenge-a', twoFactorCode: '123456' })).status, 200);
    assert.deepEqual(valid.counts(), { challenges: 0, sessions: 1, sent: 0 });
  });

  test(`${kind}: existing setting can disable OTP, but cannot bypass password validation`, async () => {
    const h = harness(kind, { twoFactor: false, smtpFails: true });
    assert.equal((await h.post()).status, 200);
    assert.deepEqual(h.counts(), { challenges: 0, sessions: 1, sent: 0 });
    const invalid = harness(kind, { twoFactor: false, invalidPassword: true });
    assert.equal((await invalid.post()).status, 401);
    assert.deepEqual(invalid.counts(), { challenges: 0, sessions: 0, sent: 0 });
  });
}

test('manager and legacy admin use the same safe SMTP failure path', async () => {
  for (const employee of ['manager', 'env'] as const) {
    const h = harness('admin', { employee, smtpFails: true });
    const response = await h.post();
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'TWO_FACTOR_DELIVERY_FAILED');
    assert.deepEqual(h.invalidated, [['challenge-a', 'synthetic-login-session']]);
    assert.equal(h.counts().sessions, 0);
  }
});

test('bounded email outage exempts password-verified employees and clients, never bad credentials', async () => {
  const outage = { start: '2026-10-12T13:45:10.000Z', end: '2027-01-12T13:45:10.000Z', now: '2026-11-01T00:00:00.000Z' };
  for (const employee of ['admin', 'manager', 'env'] as const) {
    const h = harness('admin', { employee, outage, smtpFails: true });
    assert.equal((await h.post()).status, 200);
    assert.deepEqual(h.counts(), { challenges: 0, sessions: 1, sent: 0 });
    const invalid = harness('admin', { employee, outage, invalidPassword: true });
    assert.equal((await invalid.post()).status, 401);
    assert.deepEqual(invalid.counts(), { challenges: 0, sessions: 0, sent: 0 });
  }
  const client = harness('client', { outage });
  const response = await client.post();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.deepEqual(client.counts(), { challenges: 0, sessions: 1, sent: 0 });
  const invalidClient = harness('client', { outage, invalidPassword: true });
  assert.equal((await invalidClient.post()).status, 401);
  assert.deepEqual(invalidClient.counts(), { challenges: 0, sessions: 0, sent: 0 });
});

test('employee and client OTP are required before, at expiry and for invalid or oversized outage settings', async () => {
  const range = { start: '2026-10-12T13:45:10.000Z', end: '2027-01-12T13:45:10.000Z', now: '2026-11-01T00:00:00.000Z' };
  for (const outage of [
    { ...range, now: '2026-10-12T13:45:09.999Z' },
    { ...range, now: range.end },
    { ...range, start: 'invalid' },
    { ...range, end: '2027-01-12T13:45:10.001Z' },
  ]) {
    for (const employee of ['admin', 'manager', 'env'] as const) {
      const h = harness('admin', { employee, outage });
      const response = await h.post();
      assert.equal(response.status, 200);
      assert.equal((await response.json()).twoFactorRequired, true);
      assert.deepEqual(h.counts(), { challenges: 1, sessions: 0, sent: 1 });
    }
    const client = harness('client', { outage });
    const response = await client.post();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).twoFactorRequired, true);
    assert.deepEqual(client.counts(), { challenges: 1, sessions: 0, sent: 1 });
    const clientWithoutOtp = harness('client', { outage, twoFactor: false });
    assert.equal((await clientWithoutOtp.post()).status, 200);
    assert.deepEqual(clientWithoutOtp.counts(), { challenges: 0, sessions: 1, sent: 0 });
  }
});

test('failed challenge invalidation is restricted to the challenge and browser login session', async () => {
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const repo = load<{ invalidateTwoFactorChallenge: (id: string, session: string) => Promise<void> }>('src/shared/lib/db/twoFactorRepo.ts', {
    crypto,
    '../securityHash': { hashSensitiveValue: () => 'synthetic-hash', safeHeaderValue: (value: string) => value.trim() },
    './schema': { ensureSiteSchema: async () => {} },
    './client': { query: async (sql: string, args: unknown[]) => { queries.push({ sql, args }); } },
    './loginCredentialsRepo': { lockVerifiedLoginCredential: () => assert.fail('Invalidation does not issue credentials') },
  });
  await repo.invalidateTwoFactorChallenge('challenge-a', 'session-a');
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /set consumed_at = coalesce\(consumed_at, now\(\)\)/);
  assert.match(queries[0].sql, /where id = \$1 and login_session_id = \$2/);
  assert.deepEqual(Array.from(queries[0].args), ['challenge-a', 'session-a']);
});

test('OTP transport deadlines are opt-in; other system mail keeps its configuration', async () => {
  const configurations: Array<Record<string, unknown>> = [];
  let sends = 0;
  const mailer = load<{ sendSystemMail: (input: unknown, timeouts?: unknown) => Promise<void> }>('src/shared/lib/mailer.ts', {
    nodemailer: { default: { createTransport: (config: Record<string, unknown>) => {
      configurations.push(config);
      return { sendMail: async () => { sends++; } };
    } } },
  }, [], { SMTP_USER: 'synthetic@example.test', SMTP_PASSWORD: 'synthetic-password' });
  const input = { to: 'synthetic-recipient@example.test', subject: 'Synthetic', text: 'Synthetic', html: '<p>Synthetic</p>' };
  await mailer.sendSystemMail(input);
  await mailer.sendSystemMail(input, { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
  assert.equal(sends, 2);
  assert.equal(configurations[0].connectionTimeout, undefined);
  assert.equal(configurations[0].greetingTimeout, undefined);
  assert.equal(configurations[0].socketTimeout, undefined);
  assert.equal(configurations[1].connectionTimeout, 10_000);
  assert.equal(configurations[1].greetingTimeout, 10_000);
  assert.equal(configurations[1].socketTimeout, 20_000);
});
