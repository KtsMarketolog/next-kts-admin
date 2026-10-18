import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as net from 'node:net';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type LimitResult = { allowed: boolean; remaining: number; retryAfter: number };
type LimitModule = {
  checkRateLimit: (key: string, limit: number, windowMs: number) => LimitResult;
  resetRateLimit: (key: string) => void;
  getClientIp: (request: Request) => string;
};

function load<T>(path: string, modules: Record<string, unknown>, env = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports, Response, Request, Headers, Buffer, URL, process: { env }, ...globals,
    console: { error: () => {} },
    require(name: string) { assert.ok(name in modules, `Unexpected module: ${name}`); return modules[name]; },
  });
  return exports as T;
}

function harness(options: { twoFactor?: boolean; managerPasswordIsLegacy?: boolean } = {}) {
  let now = Date.now();
  class ClockDate extends Date { static now() { return now; } }
  const limits = load<LimitModule>('src/shared/lib/rateLimit.ts', {
    crypto,
    './authSecret': { getAdminSessionSecret: () => 'synthetic-login-test-secret' },
    './db/client': { query: () => assert.fail('No real database access in route regression tests') },
    './db/schema': { ensureSiteSchema: () => assert.fail('No schema writes in route regression tests') },
  }, {}, { Date: ClockDate });
  const publicSession = load('src/shared/lib/publicSession.ts', { crypto }, { NODE_ENV: 'production' });
  const loginSource = load('src/shared/lib/loginSource.ts', { 'node:net': net }, { NODE_ENV: 'production' });
  const calls: Array<{ key: string; limit: number; allowed: boolean }> = [];
  const resets: string[] = [];
  const sessions: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  let lookups = 0;
  let consumedChallenges = 0;
  let legacyPasswordChecks = 0;
  const account = (login: string, role: 'admin' | 'manager') => ({
    id: login.startsWith('office-') ? 100 + Number(login.match(/office-(\d+)/)?.[1]) : role === 'admin' ? 7 : 17,
    login, email: login, role,
    isActive: true,
    passwordHash: role === 'manager' && options.managerPasswordIsLegacy ? 'synthetic-manager-legacy-hash' : 'synthetic-hash',
    passwordChangedAt: null,
  });
  const modules: Record<string, unknown> = {
    '@/shared/lib/adminAuth': {
      createAdminSession: async (role: string) => { sessions.push(role); },
      createEmployeeSession: async (actor: { role: string }) => { sessions.push(actor.role); },
      verifyPassword: (password: string, hash: string) => password === (
        hash === 'synthetic-manager-legacy-hash' ? 'valid-legacy-password' : 'valid-password'
      ),
      validateAdminPassword: (password: string) => {
        legacyPasswordChecks++;
        return password === 'valid-legacy-password';
      },
    },
    '@/shared/lib/db/securityAuditRepo': {
      recordSecurityEvent: async (event: Record<string, unknown>) => { events.push(event); },
    },
    '@/shared/lib/db/twoFactorRepo': {
      createTwoFactorChallenge: async () => 'synthetic-challenge',
      consumeTwoFactorChallenge: async (input: { challengeId: string; code: string }) => {
        consumedChallenges++;
        const officeMatch = input.challengeId.match(/^valid-office-challenge-(\d+)$/);
        if ((input.challengeId !== 'valid-challenge' && !officeMatch) || input.code !== '123456') return null;
        return {
          challengeId: input.challengeId, createdAt: new Date().toISOString(),
          login: officeMatch ? `office-${officeMatch[1]}@example.test` : 'admin@example.test',
          actorType: 'admin', role: 'admin', adminUserId: officeMatch ? 100 + Number(officeMatch[1]) : 7,
        };
      },
      generateTwoFactorCode: () => '123456',
      isTwoFactorEnabled: () => options.twoFactor === true,
    },
    '@/shared/lib/db': {
      getAdminUserByLogin: async (login: string) => {
        lookups++;
        return login === 'admin@example.test' || /^office-\d+@example\.test$/.test(login) ? account(login, 'admin') : null;
      },
      getWholesaleManagerByLogin: async (login: string) => {
        lookups++;
        return login === 'manager@example.test' ? account(login, 'manager') : null;
      },
      recordWholesaleManagerLogin: async () => {},
      trackAnalyticsEvent: async () => {},
    },
    '@/shared/lib/twoFactorDelivery': {
      deliverTwoFactorCode: async () => true,
      twoFactorDeliveryFailure: () => Response.json({ error: 'Unable to send confirmation code' }, { status: 503 }),
    },
    '@/shared/lib/emailTwoFactorOutage': { isEmailTwoFactorOutageActive: () => false },
    '@/shared/lib/publicSession': publicSession,
    '@/shared/lib/loginSource': loginSource,
    '@/shared/lib/rateLimit': {
      ...limits,
      // Same synchronous, atomic bucket reservation semantics as the shared limiter.
      // Only persistence is replaced; real route/session/IP/limit logic runs below.
      checkDbRateLimit: async (key: string, limit: number, windowMs: number) => {
        const result = limits.checkRateLimit(key, limit, windowMs);
        calls.push({ key, limit, allowed: result.allowed });
        return result;
      },
      resetDbRateLimit: async (key: string) => { resets.push(key); limits.resetRateLimit(key); },
    },
  };
  const route = load<{ POST: (request: Request) => Promise<Response> }>('src/app/api/admin/login/route.ts', modules);
  return {
    calls, resets, sessions, events,
    advance: (ms: number) => { now += ms; },
    counts: () => ({ lookups, consumedChallenges, legacyPasswordChecks }),
    post: (input: {
      login?: string; password?: string; cookie?: string | null; ip?: string | null; forwardedFor?: string;
      challenge?: string; code?: string;
    } = {}) => {
      const ip = input.ip === undefined ? '192.0.2.10' : input.ip;
      const headers = new Headers({
        'Content-Type': 'application/json',
        'x-forwarded-for': input.forwardedFor ?? ip ?? '192.0.2.10',
      });
      if (ip !== null) headers.set('x-real-ip', ip);
      if (input.cookie !== null) headers.set('Cookie', `kts_login_sid=${input.cookie ?? 'synthetic-browser-session-1'}`);
      return route.POST(new Request('https://example.test/api/admin/login', {
        method: 'POST', headers,
        body: JSON.stringify(input.challenge !== undefined || input.code !== undefined ? {
          twoFactorChallengeId: input.challenge, twoFactorCode: input.code,
          ...(input.login === undefined ? {} : { login: input.login }),
        } : {
          login: input.login ?? 'admin@example.test', password: input.password ?? 'wrong-password',
        }),
      }));
    },
  };
}

test('repeated blocked employee logins cannot exhaust access for another source', async () => {
  const h = harness();
  for (let i = 0; i < 300; i++) {
    assert.equal((await h.post()).status, i < 8 ? 401 : 429);
  }
  assert.equal(h.sessions.length, 0);
  assert.equal(h.counts().lookups, 16, 'blocked requests stop before account lookups');
  assert.equal(h.calls.filter((call) => call.key === 'login:source:192.0.2.10').length, 0,
    'there must be no shared office-IP admission bucket');
  assert.equal(h.counts().legacyPasswordChecks, 8);
  const other = await h.post({ ip: '192.0.2.20', cookie: 'synthetic-browser-session-2', login: 'manager@example.test', password: 'valid-password' });
  assert.equal(other.status, 200, 'one blocked source must not lock out another employee');
  assert.deepEqual(await other.json(), { ok: true, role: 'manager' });
  assert.deepEqual(h.sessions, ['manager']);
});

test('already blocked attempts cannot deny a colleague sharing the office IP', async () => {
  const h = harness();
  for (let i = 0; i < 300; i++) await h.post();
  const colleague = await h.post({ cookie: 'synthetic-colleague-browser', login: 'manager@example.test', password: 'valid-password' });
  assert.equal(colleague.status, 200, 'blocked account retries must not deny colleagues behind the same proxy IP');
  assert.deepEqual(h.sessions, ['manager']);
});

test('rotating browser cookies does not reset an IP/login quota', async () => {
  const h = harness();
  const statuses: number[] = [];
  for (let i = 0; i < 20; i++) statuses.push((await h.post({ cookie: `synthetic-rotated-browser-${i}` })).status);
  assert.deepEqual(statuses.slice(0, 8), Array(8).fill(401));
  assert.ok(statuses.slice(8).every((status) => status === 429));
  assert.equal(h.sessions.length, 0);
});

test('rotating login names and cookies cannot brute-force legacy admin or deny office colleagues', async () => {
  const h = harness();
  const statuses: number[] = [];
  for (let i = 0; i < 300; i++) {
    statuses.push((await h.post({ login: `unknown-${i}@example.test`, cookie: `synthetic-rotated-browser-${i}` })).status);
  }
  const processed = statuses.filter((status) => status === 401).length;
  assert.equal(processed, 8, 'legacy password guesses have a separate source-bound cap');
  assert.ok(statuses.slice(processed).every((status) => status === 429));
  assert.equal(h.counts().legacyPasswordChecks, 8);
  for (const login of ['admin@example.test', 'manager@example.test']) {
    assert.equal((await h.post({ login, password: 'valid-password', cookie: 'synthetic-colleague-browser' })).status, 200);
  }
  assert.equal(h.counts().legacyPasswordChecks, 8, 'persisted credentials must not evaluate the legacy password');
  assert.ok(h.calls.every((call) => call.key !== 'login:source:192.0.2.10' && call.key !== 'login:global'));
});

test('spoofing forwarded-for cannot evade the reverse proxy source limit', async () => {
  const h = harness();
  const statuses: number[] = [];
  for (let i = 0; i < 300; i++) {
    statuses.push((await h.post({
      login: `unknown-${i}@example.test`, cookie: `synthetic-rotated-browser-${i}`,
      forwardedFor: `198.51.${Math.floor(i / 250)}.${i % 250 + 1}, 192.0.2.10`,
    })).status);
  }
  const processed = statuses.filter((status) => status === 401).length;
  assert.equal(processed, 8, `Spoofed header bypassed legacy source quota: ${processed}`);
  assert.equal(h.counts().legacyPasswordChecks, 8);
  assert.equal((await h.post({ password: 'valid-password' })).status, 200);
});

test('OTP attempts are limited before consuming a challenge and cannot starve a colleague on the same IP', async () => {
  const h = harness({ twoFactor: true });
  for (let i = 0; i < 300; i++) {
    await h.post({ challenge: `invalid-challenge-${i}`, code: '000000' });
  }
  assert.ok(h.counts().consumedChallenges > 0 && h.counts().consumedChallenges <= 8);
  assert.equal(h.sessions.length, 0);
  const valid = await h.post({ cookie: 'synthetic-browser-session-2', challenge: 'valid-challenge', code: '123456' });
  assert.equal(valid.status, 200);
  assert.deepEqual(h.sessions, ['admin']);
});

test('more than 120 invalid OTPs in other browser sessions cannot exhaust an office-wide quota', async () => {
  const h = harness({ twoFactor: true });
  for (let i = 0; i < 300; i++) {
    assert.equal((await h.post({
      cookie: `synthetic-rotated-browser-${i}`, challenge: `invalid-challenge-${i}`, code: '000000',
    })).status, 401);
  }
  assert.equal(h.counts().consumedChallenges, 300);
  assert.equal(h.counts().legacyPasswordChecks, 0);
  assert.equal(h.sessions.length, 0);
  const valid = await h.post({ cookie: 'synthetic-colleague-browser', challenge: 'valid-challenge', code: '123456' });
  assert.equal(valid.status, 200);
  assert.deepEqual(h.sessions, ['admin']);
  assert.ok(h.calls.every((call) => call.key !== 'login:source:192.0.2.10' && call.key !== 'login:global'));
});

test('parallel invalid attempts admit only the personal quota and preserve another source', async () => {
  const h = harness();
  const responses = await Promise.all(Array.from({ length: 300 }, () => h.post()));
  assert.equal(responses.filter((response) => response.status === 401).length, 8);
  assert.equal(responses.filter((response) => response.status === 429).length, 292);
  const other = await h.post({ ip: '192.0.2.20', cookie: 'synthetic-browser-session-2', password: 'valid-password' });
  assert.equal(other.status, 200);
});

test('429 includes retry time, an uncached response and a new browser session cookie when needed', async () => {
  const h = harness();
  for (let i = 0; i < 8; i++) assert.equal((await h.post()).status, 401);
  const response = await h.post({ cookie: null });
  assert.equal(response.status, 429);
  assert.match(response.headers.get('Retry-After') ?? '', /^[1-9]\d*$/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Set-Cookie') ?? '', /^kts_login_sid=[a-zA-Z0-9_-]+;.*HttpOnly/);
  assert.deepEqual(await response.json(), { error: 'Too many login attempts' });
});

test('valid admin, manager and legacy passwords authenticate and clear only their own quotas', async () => {
  for (const input of [
    { login: 'admin@example.test', password: 'valid-password', role: 'admin' },
    { login: 'manager@example.test', password: 'valid-password', role: 'manager' },
    { login: '', password: 'valid-legacy-password', role: 'admin' },
  ]) {
    const h = harness();
    assert.equal((await h.post({ login: input.login })).status, 401);
    const response = await h.post(input);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, role: input.role });
    assert.deepEqual(h.sessions, [input.role]);
    assert.equal(h.resets.length, input.password === 'valid-legacy-password' ? 2 : 1);
    assert.ok(h.events.some((event) => event.eventType === 'login_success'));
  }
});

test('password verification starts OTP but never creates a session before valid confirmation', async () => {
  const h = harness({ twoFactor: true });
  const response = await h.post({ password: 'valid-password' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).twoFactorRequired, true);
  assert.deepEqual(h.sessions, []);
  const confirmed = await h.post({ challenge: 'valid-challenge', code: '123456' });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(h.sessions, ['admin']);
});

test('150 colleagues sharing one office IP can each complete password and OTP login', async () => {
  const h = harness({ twoFactor: true });
  for (let i = 0; i < 150; i++) {
    const cookie = `synthetic-office-browser-${i}`;
    const password = await h.post({ login: `office-${i}@example.test`, cookie, password: 'valid-password' });
    assert.equal(password.status, 200, `Password login for colleague ${i}`);
    assert.equal((await password.json()).twoFactorRequired, true);
    const confirmation = await h.post({ cookie, challenge: `valid-office-challenge-${i}`, code: '123456' });
    assert.equal(confirmation.status, 200, `OTP login for colleague ${i}; form sends no login name`);
  }
  assert.equal(h.sessions.length, 150);
  assert.equal(h.counts().legacyPasswordChecks, 0);
  assert.ok(h.calls.every((call) => call.key !== 'login:source:192.0.2.10' && call.key !== 'login:global'));
});

test('more than 120 valid stored-password logins cannot lock an office IP or spend legacy budget', async () => {
  const h = harness();
  for (let i = 0; i < 300; i++) {
    const login = i % 2 ? 'manager@example.test' : 'admin@example.test';
    assert.equal((await h.post({ login, password: 'valid-password' })).status, 200);
  }
  assert.equal(h.sessions.length, 300);
  assert.equal(h.counts().legacyPasswordChecks, 0);
  assert.ok(h.calls.every((call) => call.key === 'login:source:192.0.2.10:login:admin@example.test'
    || call.key === 'login:source:192.0.2.10:login:manager@example.test'));
});

test('exhausted legacy fallback cannot block valid stored credentials, and expires normally', async () => {
  const h = harness();
  for (let i = 0; i < 8; i++) {
    assert.equal((await h.post({ login: `unknown-${i}@example.test`, cookie: `synthetic-rotated-browser-${i}` })).status, 401);
  }
  assert.equal((await h.post({ login: 'another-unknown', password: 'valid-legacy-password' })).status, 429);
  assert.equal(h.counts().legacyPasswordChecks, 8, 'blocked fallback must stop before password comparison');
  for (const login of ['admin@example.test', 'manager@example.test']) {
    assert.equal((await h.post({ login, password: 'valid-password' })).status, 200);
  }
  assert.equal(h.counts().legacyPasswordChecks, 8);
  assert.ok(!h.resets.includes('login:legacy-admin:source:192.0.2.10'));
  assert.equal((await h.post({ ip: '192.0.2.20', login: '', password: 'valid-legacy-password' })).status, 200);
  h.advance(15 * 60 * 1000 + 1);
  assert.equal((await h.post({ login: '', password: 'valid-legacy-password' })).status, 200);
});

test('successful stored-password logins cannot reset legacy fallback budget', async () => {
  const h = harness();
  for (let i = 0; i < 7; i++) assert.equal((await h.post({ login: `unknown-${i}` })).status, 401);
  for (let i = 0; i < 12; i++) {
    assert.equal((await h.post({ login: i % 2 ? 'manager@example.test' : 'admin@example.test', password: 'valid-password' })).status, 200);
  }
  assert.equal(h.counts().legacyPasswordChecks, 7);
  assert.equal((await h.post({ login: 'last-allowed-legacy-guess' })).status, 401);
  assert.equal((await h.post({ login: 'blocked-legacy-guess', password: 'valid-legacy-password' })).status, 429);
  assert.equal(h.counts().legacyPasswordChecks, 8);
  assert.ok(!h.resets.includes('login:legacy-admin:source:192.0.2.10'));
});

test('only successful legacy authentication resets its own fallback budget', async () => {
  const h = harness();
  for (let i = 0; i < 7; i++) assert.equal((await h.post({ login: `before-${i}` })).status, 401);
  assert.equal((await h.post({ login: 'legacy-admin', password: 'valid-legacy-password' })).status, 200);
  assert.deepEqual(h.sessions, ['admin']);
  assert.equal(h.resets.filter((key) => key === 'login:legacy-admin:source:192.0.2.10').length, 1);
  for (let i = 0; i < 8; i++) assert.equal((await h.post({ login: `after-${i}` })).status, 401);
  assert.equal((await h.post({ login: 'after-budget-exhausted' })).status, 429);
  assert.equal(h.counts().legacyPasswordChecks, 16);
});

test('a manager password equal to legacy admin password retains manager identity and never evaluates fallback', async () => {
  const h = harness({ managerPasswordIsLegacy: true });
  const response = await h.post({ login: 'manager@example.test', password: 'valid-legacy-password' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, role: 'manager' });
  assert.deepEqual(h.sessions, ['manager']);
  assert.equal(h.counts().legacyPasswordChecks, 0);
  assert.deepEqual(h.resets, ['login:source:192.0.2.10:login:manager@example.test']);
});

test('parallel rotating-login attempts reserve only eight legacy password comparisons', async () => {
  const h = harness();
  const responses = await Promise.all(Array.from({ length: 300 }, (_, i) => h.post({
    login: `unknown-${i}`, cookie: `synthetic-rotated-browser-${i}`,
  })));
  assert.equal(responses.filter((response) => response.status === 401).length, 8);
  assert.equal(responses.filter((response) => response.status === 429).length, 292);
  assert.equal(h.counts().legacyPasswordChecks, 8);
  assert.equal((await h.post({ login: 'manager@example.test', password: 'valid-password' })).status, 200);
});

test('personal quota expires and textual aliases of one IPv6 source share it', async () => {
  const h = harness();
  for (let i = 0; i < 8; i++) {
    assert.equal((await h.post({ ip: '2001:0db8:0000:0000:0000:0000:0000:0001' })).status, 401);
  }
  assert.equal((await h.post({ ip: '2001:db8::1', cookie: 'synthetic-fresh-browser' })).status, 429);
  h.advance(15 * 60 * 1000 + 1);
  assert.equal((await h.post({ ip: '2001:db8::1', password: 'valid-password' })).status, 200);
});

test('IPv4 and its IPv4-mapped IPv6 representations share a personal quota', async () => {
  const h = harness();
  for (let i = 0; i < 8; i++) assert.equal((await h.post({ ip: '192.0.2.10' })).status, 401);
  for (const ip of ['::ffff:192.0.2.10', '::FFFF:C000:020A', '0:0:0:0:0:ffff:c000:20a']) {
    assert.equal((await h.post({ ip, cookie: 'synthetic-fresh-browser' })).status, 429);
  }
  assert.equal(h.calls.filter((call) => call.key === 'login:source:192.0.2.10').length, 0);
});

test('changing login case or surrounding whitespace does not create a fresh quota', async () => {
  const h = harness();
  for (let i = 0; i < 8; i++) {
    assert.equal((await h.post({
      login: i % 2 ? '  ADMIN@EXAMPLE.TEST ' : 'Admin@Example.Test', cookie: `synthetic-rotated-browser-${i}`,
    })).status, 401);
  }
  assert.equal((await h.post({ login: 'admin@example.test', cookie: 'synthetic-fresh-browser' })).status, 429);
  assert.equal(h.calls.filter((call) => call.key === 'login:source:192.0.2.10').length, 0);
});

test('distributed valid logins cannot recreate the old shared 250-request hard lock', async () => {
  const h = harness();
  for (let i = 0; i < 300; i++) {
    const ip = `198.51.${100 + Math.floor(i / 250)}.${i % 250 + 1}`;
    assert.equal((await h.post({ ip, password: 'valid-password' })).status, 200);
  }
  assert.equal(h.sessions.length, 300);
  assert.ok(h.calls.every((call) => call.key !== 'login:global'));
});

test('production requests without a valid trusted proxy address fail before authentication', async () => {
  for (const ip of [null, 'not-an-ip', '192.0.2.10, 198.51.100.1']) {
    const h = harness();
    const response = await h.post({ ip, forwardedFor: '192.0.2.10', password: 'valid-password' });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(h.counts(), { lookups: 0, consumedChallenges: 0, legacyPasswordChecks: 0 });
    assert.deepEqual(h.sessions, []);
    assert.deepEqual(h.calls, []);
  }
});
