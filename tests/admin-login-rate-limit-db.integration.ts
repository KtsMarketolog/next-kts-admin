/** Synthetic PostgreSQL acceptance only. Run scripts/test-admin-login-rate-limit-postgres.sh. */
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as net from 'node:net';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { Pool } from 'pg';
import ts from 'typescript';

const syntheticSecret = 'synthetic-isolated-login-rate-limit-secret';
const sourceIp = '192.0.2.10';

function guardedConnectionString() {
  assert.equal(process.env.KTS_LOGIN_RATE_LIMIT_TEST, '1', 'Explicit isolated login integration flag is required');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_login_rate_limit_integration');
  assert.equal(url.username, 'login_rate_limit_app');
  assert.equal(url.password, '', 'Test role must not use application credentials');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-login-limit-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55475');
  return url.toString();
}

function load<T>(path: string, modules: Record<string, unknown>, errors: unknown[][]) {
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports, Request, Response, Headers, Buffer, URL, process: { env: { NODE_ENV: 'production' } },
    console: { error: (...values: unknown[]) => errors.push(values) },
    require(name: string) { assert.ok(name in modules, `Unexpected module: ${name}`); return modules[name]; },
  });
  return exports as T;
}

function worker(pool: Pool, options: { failDatabase?: boolean } = {}) {
  const errors: unknown[][] = [];
  let passwordAttempts = 0;
  let legacyAttempts = 0;
  let otpAttempts = 0;
  let sessions = 0;
  // Real limiter implementation and SQL, with only connection/schema ownership
  // replaced. Each worker has its own VM and fallback memory, sharing PostgreSQL.
  const limiter = load('src/shared/lib/rateLimit.ts', {
    crypto,
    './authSecret': { getAdminSessionSecret: () => syntheticSecret },
    './db/client': { query: (sql: string, params: unknown[]) => {
      if (options.failDatabase) throw new Error('Synthetic database unavailable');
      return pool.query(sql, params);
    } },
    './db/schema': { ensureSiteSchema: async () => {} },
  }, errors);
  const publicSession = load('src/shared/lib/publicSession.ts', { crypto }, errors);
  const loginSource = load('src/shared/lib/loginSource.ts', { 'node:net': net }, errors);
  const route = load<{ POST: (request: Request) => Promise<Response> }>('src/app/api/admin/login/route.ts', {
    '@/shared/lib/adminAuth': {
      createAdminSession: async () => { sessions++; },
      createEmployeeSession: async () => { sessions++; },
      validateAdminPassword: (password: string) => { legacyAttempts++; return password === 'synthetic-legacy-password'; },
      verifyPassword: (password: string) => { passwordAttempts++; return password === 'synthetic-valid-password'; },
    },
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async () => {} },
    '@/shared/lib/db/twoFactorRepo': {
      createTwoFactorChallenge: async () => assert.fail('No challenge creation in these scenarios'),
      consumeTwoFactorChallenge: async () => { otpAttempts++; return null; },
      generateTwoFactorCode: () => '123456', isTwoFactorEnabled: () => false,
    },
    '@/shared/lib/db': {
      getAdminUserByLogin: async (login: string) => {
        return ['employee@example.test', 'colleague@example.test'].includes(login)
          ? { id: 7, login, email: login, role: 'admin', isActive: true, passwordHash: 'synthetic-hash' }
          : null;
      },
      getWholesaleManagerByLogin: async (login: string) => login === 'manager@example.test'
        ? { id: 17, login, email: login, role: 'manager', isActive: true, passwordHash: 'synthetic-hash' }
        : null,
      recordWholesaleManagerLogin: async () => {}, trackAnalyticsEvent: async () => {},
    },
    '@/shared/lib/twoFactorDelivery': {
      deliverTwoFactorCode: async () => assert.fail('No email delivery in integration tests'),
      twoFactorDeliveryFailure: () => assert.fail('No email delivery in integration tests'),
    },
    '@/shared/lib/emailTwoFactorOutage': { isEmailTwoFactorOutageActive: () => false },
    '@/shared/lib/publicSession': publicSession,
    '@/shared/lib/loginSource': loginSource,
    '@/shared/lib/rateLimit': limiter,
  }, errors);
  return {
    errors,
    counts: () => ({ passwordAttempts, legacyAttempts, otpAttempts, sessions }),
    post: (input: { ip?: string; login?: string; cookie?: string; validPassword?: boolean; validLegacyPassword?: boolean; otp?: boolean } = {}) => {
      const headers = new Headers({ 'content-type': 'application/json', 'x-real-ip': input.ip ?? sourceIp });
      headers.set('cookie', `kts_login_sid=${input.cookie ?? 'synthetic-stable-browser-session'}`);
      return route.POST(new Request('https://example.test/api/admin/login', {
        method: 'POST', headers,
        body: JSON.stringify(input.otp
          ? { twoFactorChallengeId: 'synthetic-challenge', twoFactorCode: '000000' }
          : { login: input.login ?? 'employee@example.test', password: input.validPassword ? 'synthetic-valid-password'
            : input.validLegacyPassword ? 'synthetic-legacy-password' : 'wrong-password' }),
      }));
    },
  };
}

function hash(key: string) {
  return crypto.createHash('sha256').update(`${syntheticSecret}:${key}`).digest('hex');
}

test('employee login reservations use isolated PostgreSQL atomically across workers', { timeout: 90_000 }, async (t) => {
  const pool = new Pool({ connectionString: guardedConnectionString(), max: 8, connectionTimeoutMillis: 5_000 });
  try {
    const existing = await pool.query(`select count(*)::integer as n from pg_tables where schemaname='public'`);
    assert.equal(existing.rows[0].n, 0, 'Refuse any pre-existing application schema');
    const role = await pool.query(`select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user`);
    assert.deepEqual(role.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    // Mirrors rate_limit_buckets in the application schema; no user/account data.
    await pool.query(`create table rate_limit_buckets (
      key text primary key, count integer not null default 0,
      reset_at timestamptz not null, updated_at timestamptz not null default now()
    )`);
    const count = async (key: string) => {
      const result = await pool.query(`select count from rate_limit_buckets where key=$1`, [hash(key)]);
      return result.rows[0]?.count ?? null;
    };
    const workers = () => [worker(pool), worker(pool)];

    await t.test('300 simultaneous failures admit only eight password and legacy checks without blocking colleagues', async () => {
      const hosts = workers();
      const responses = await Promise.all(Array.from({ length: 300 }, (_, i) => hosts[i % 2].post({ cookie: `synthetic-rotated-cookie-${i}` })));
      assert.equal(responses.filter((response) => response.status === 401).length, 8);
      assert.equal(responses.filter((response) => response.status === 429).length, 292);
      assert.equal(hosts.reduce((sum, host) => sum + host.counts().passwordAttempts, 0), 8);
      assert.equal(hosts.reduce((sum, host) => sum + host.counts().legacyAttempts, 0), 8);
      assert.equal(await count(`login:legacy-admin:source:${sourceIp}`), 8, 'Narrow denials must stop before the legacy credential check');
      assert.equal(await count(`login:source:${sourceIp}`), null, 'No all-office budget may be charged');
      assert.equal(await count('login:global'), null, 'No site-wide budget may be charged');
      for (const response of responses.filter((response) => response.status === 429)) {
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const retry = Number(response.headers.get('retry-after'));
        assert.ok(retry > 0 && retry <= 900);
      }
      const colleague = await hosts[0].post({ login: 'colleague@example.test', validPassword: true });
      assert.equal(colleague.status, 200, 'Repeated narrow denials do not exhaust colleagues sharing the office IP');
      const manager = await hosts[1].post({ login: 'manager@example.test', validPassword: true });
      assert.equal(manager.status, 200, 'A limited legacy password branch must not block a valid manager account');
      assert.equal(await count(`login:legacy-admin:source:${sourceIp}`), 8, 'Persisted accounts must neither charge nor reset the legacy limiter');
      hosts.forEach((host) => assert.equal(host.errors.length, 0, 'Real database path must not silently fall back'));
    });

    await t.test('300 unknown identities cannot multiply legacy password checks or lock valid office accounts', async () => {
      await pool.query('truncate rate_limit_buckets');
      const hosts = workers();
      const responses = await Promise.all(Array.from({ length: 300 }, (_, i) => hosts[i % 2].post({
        login: `synthetic-${i}@example.test`, cookie: `synthetic-rotated-cookie-${i}`,
      })));
      assert.equal(responses.filter((response) => response.status === 401).length, 8);
      assert.equal(responses.filter((response) => response.status === 429).length, 292);
      assert.equal(hosts.reduce((sum, host) => sum + host.counts().passwordAttempts, 0), 0);
      assert.equal(hosts.reduce((sum, host) => sum + host.counts().legacyAttempts, 0), 8);
      assert.equal(await count(`login:legacy-admin:source:${sourceIp}`), 300, 'SQL counts rejected legacy reservations but does not verify their passwords');
      assert.equal(await count(`login:source:${sourceIp}`), null);
      assert.equal(await count('login:global'), null);
      assert.equal((await hosts[0].post({ login: 'colleague@example.test', validPassword: true })).status, 200);
      assert.equal((await hosts[1].post({ login: 'manager@example.test', validPassword: true })).status, 200);
      const other = await hosts[0].post({ ip: '192.0.2.20', validPassword: true });
      assert.equal(other.status, 200);
      assert.equal(await count('login:source:192.0.2.20'), null);
      hosts.forEach((host) => assert.equal(host.errors.length, 0));
    });

    await t.test('OTP retries stay in their own session without charging shared or legacy buckets', async () => {
      await pool.query('truncate rate_limit_buckets');
      const hosts = workers();
      const responses = await Promise.all(Array.from({ length: 100 }, (_, i) => hosts[i % 2].post({ otp: true })));
      assert.equal(responses.filter((response) => response.status === 401).length, 8);
      assert.equal(responses.filter((response) => response.status === 429).length, 92);
      assert.equal(hosts.reduce((sum, host) => sum + host.counts().otpAttempts, 0), 8);
      assert.equal(await count(`login:source:${sourceIp}`), null);
      assert.equal(await count(`login:legacy-admin:source:${sourceIp}`), null);
      assert.equal((await hosts[0].post({ otp: true, cookie: 'synthetic-colleague-session' })).status, 401);
      assert.equal(hosts.reduce((sum, host) => sum + host.counts().legacyAttempts, 0), 0);
      hosts.forEach((host) => assert.equal(host.errors.length, 0));
    });

    await t.test('more than 120 valid office logins work despite old exhausted global and IP buckets', async () => {
      await pool.query('truncate rate_limit_buckets');
      for (const key of ['login:global', `login:source:${sourceIp}`, `login:legacy-admin:source:${sourceIp}`]) {
        await pool.query(`insert into rate_limit_buckets(key,count,reset_at) values($1,999,now()+interval '15 minutes')`, [hash(key)]);
      }
      const host = worker(pool);
      for (let i = 0; i < 150; i++) {
        assert.equal((await host.post({ login: i % 2 ? 'employee@example.test' : 'manager@example.test', validPassword: true })).status, 200);
      }
      assert.equal(host.counts().sessions, 150);
      assert.equal(host.counts().legacyAttempts, 0);
      for (const key of ['login:global', `login:source:${sourceIp}`, `login:legacy-admin:source:${sourceIp}`]) {
        assert.equal(await count(key), 999, 'Persisted-user success must not consume or reset other credential buckets');
      }
      assert.equal((await host.post({ ip: '192.0.2.20', validPassword: true })).status, 200);
      assert.equal(host.errors.length, 0);
    });

    await t.test('successful legacy authentication resets only its legacy and narrow reservations', async () => {
      await pool.query('truncate rate_limit_buckets');
      const host = worker(pool);
      for (let i = 0; i < 3; i++) assert.equal((await host.post({ login: `unknown-${i}@example.test` })).status, 401);
      assert.equal(await count(`login:legacy-admin:source:${sourceIp}`), 3);
      assert.equal((await host.post({ login: 'legacy-synthetic', validLegacyPassword: true })).status, 200);
      assert.equal(await count(`login:legacy-admin:source:${sourceIp}`), null);
      assert.equal(await count(`login:source:${sourceIp}:login:legacy-synthetic`), null);
      assert.equal(await count(`login:source:${sourceIp}:login:unknown-0@example.test`), 1);
      assert.equal(host.counts().sessions, 1);
      assert.equal(host.errors.length, 0);
    });

    await t.test('expired PostgreSQL windows admit new requests without a process restart', async () => {
      await pool.query('truncate rate_limit_buckets');
      const host = worker(pool);
      for (let i = 0; i < 8; i++) assert.equal((await host.post()).status, 401);
      assert.equal((await host.post()).status, 429);
      await pool.query(`update rate_limit_buckets set reset_at=now()-interval '1 second'`);
      assert.equal((await host.post()).status, 401);
      assert.equal(await count(`login:source:${sourceIp}:login:employee@example.test`), 1);
      assert.equal(await count(`login:legacy-admin:source:${sourceIp}`), 1);
      assert.equal(await count(`login:source:${sourceIp}`), null);
      assert.equal(host.errors.length, 0);
    });

    await t.test('existing in-process fallback retains source isolation when database queries fail', async () => {
      await pool.query('truncate rate_limit_buckets');
      // This deliberately tests one worker's documented fallback, not a claim of
      // cross-process coordination while PostgreSQL is unavailable.
      const host = worker(pool, { failDatabase: true });
      for (let i = 0; i < 300; i++) assert.equal((await host.post()).status, i < 8 ? 401 : 429);
      assert.equal(host.counts().passwordAttempts, 8);
      assert.equal(host.counts().legacyAttempts, 8);
      assert.equal((await host.post({ login: 'colleague@example.test', validPassword: true })).status, 200);
      assert.equal((await host.post({ login: 'manager@example.test', validPassword: true })).status, 200);
      assert.equal((await host.post({ ip: '192.0.2.20', validPassword: true })).status, 200);
      assert.ok(host.errors.length > 0);
      assert.equal((await pool.query('select count(*)::integer as n from rate_limit_buckets')).rows[0].n, 0);
    });
  } finally {
    await pool.end();
  }
});
