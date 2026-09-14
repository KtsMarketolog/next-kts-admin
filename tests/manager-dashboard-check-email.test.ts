import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

type CheckOptions = {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  log: (line: string) => void;
  error: (line: string) => void;
  now: () => Date;
};
const wrapperPath = fileURLToPath(new URL('../ops/manager-dashboard/check-email.cjs', import.meta.url));
const { checkManagerDashboardEmail } = createRequire(import.meta.url)(wrapperPath) as {
  checkManagerDashboardEmail: (options?: Partial<CheckOptions>) => Promise<number>;
};
const enabledEnv = {
  MANAGER_DASHBOARD_MAIL_ENABLED: 'true',
  MANAGER_DASHBOARD_MAIL_ALLOWED_FROM: 'synthetic@example.test',
  CRON_SECRET: 'synthetic-cron-secret',
};
const completed = { status: 'completed', checkedMessages: 1, imported: 15, duplicates: 0, stale: 0, failed: 0 };

function harness(response: unknown = completed) {
  const logs: string[] = [];
  const errors: string[] = [];
  const requests: Array<{ url: RequestInfo | URL; init?: RequestInit }> = [];
  const options: CheckOptions = {
    env: enabledEnv,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return Response.json(response);
    },
    log: (line) => { logs.push(line); },
    error: (line) => { errors.push(line); },
    now: () => new Date('2026-09-14T07:00:00Z'),
  };
  return { logs, errors, requests, options, run: () => checkManagerDashboardEmail(options) };
}

test('dashboard cron wrapper is safe to import even when its environment is enabled', () => {
  const child = spawnSync(process.execPath, ['-e', `
    globalThis.fetch = () => { throw new Error('Import must not fetch'); };
    const wrapper = require(process.argv[1]);
    if (typeof wrapper.checkManagerDashboardEmail !== 'function') process.exitCode = 2;
  `, wrapperPath], { env: { NODE_ENV: 'test', ...enabledEnv }, encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

test('dashboard cron intentional local disable skips without a request', async () => {
  for (const env of [{}, { ...enabledEnv, MANAGER_DASHBOARD_MAIL_ENABLED: 'false' }, { ...enabledEnv, MANAGER_DASHBOARD_MAIL_ALLOWED_FROM: '' }]) {
    const h = harness();
    h.options.env = env;
    assert.equal(await h.run(), 0);
    assert.equal(h.requests.length, 0);
    assert.equal(h.errors.length, 0);
    assert.deepEqual(h.logs, ['Manager dashboard mail import is disabled.']);
  }
});

test('dashboard cron POST uses local endpoint and authentication and logs only safe summary fields', async () => {
  const h = harness({ ...completed, reason: enabledEnv.CRON_SECRET, results: [{ originalName: 'private-name.ktsp', sender: enabledEnv.MANAGER_DASHBOARD_MAIL_ALLOWED_FROM }] });
  assert.equal(await h.run(), 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, 'http://127.0.0.1:3000/api/cron/manager-dashboard-import');
  assert.equal(h.requests[0].init?.method, 'POST');
  assert.deepEqual(h.requests[0].init?.headers, { authorization: `Bearer ${enabledEnv.CRON_SECRET}` });
  assert.ok(h.requests[0].init?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(h.logs[0]), { at: '2026-09-14T07:00:00.000Z', ...completed });
  assert.doesNotMatch(h.logs.join(''), /private-name|synthetic-cron-secret|synthetic@example/);
  assert.equal(h.errors.length, 0);
});

test('dashboard cron treats HTTP 200 disabled as failure but busy as a safe skip', async () => {
  const disabled = harness({ ...completed, status: 'disabled', imported: 0 });
  assert.equal(await disabled.run(), 1);
  assert.equal(disabled.errors.length, 1);
  assert.equal(JSON.parse(disabled.logs[0]).status, 'disabled');
  const busy = harness({ ...completed, status: 'busy', checkedMessages: 0, imported: 0 });
  assert.equal(await busy.run(), 0);
  assert.equal(busy.errors.length, 0);
  assert.equal(JSON.parse(busy.logs[0]).status, 'busy');
});

test('dashboard cron partial attachment failures return a failure exit code', async () => {
  const h = harness({ ...completed, imported: 11, failed: 4 });
  assert.equal(await h.run(), 1);
  assert.equal(JSON.parse(h.logs[0]).failed, 4);
});

test('dashboard cron rejects unknown or malformed status without logging raw status text', async () => {
  for (const response of [null, [], {}, { ...completed, status: null }, { ...completed, status: 1 }, { ...completed, status: 'private response text' }]) {
    const h = harness(response);
    assert.equal(await h.run(), 1);
    assert.deepEqual(h.logs, []);
    assert.equal(h.errors.length, 1);
    assert.doesNotMatch(h.errors.join(''), /private response text/);
  }
});

test('dashboard cron rejects missing, negative, noninteger or nonnumeric counts', async () => {
  for (const field of ['checkedMessages', 'imported', 'duplicates', 'stale', 'failed']) {
    for (const value of [undefined, -1, 1.5, 'private count text', null, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      const h = harness({ ...completed, [field]: value });
      assert.equal(await h.run(), 1);
      assert.deepEqual(h.logs, []);
      assert.equal(h.errors.length, 1);
      assert.doesNotMatch(h.errors.join(''), /private count text/);
    }
  }
});

test('dashboard cron hides authentication, HTTP, JSON and network failure details', async () => {
  const missingSecret = harness();
  missingSecret.options.env = { ...enabledEnv, CRON_SECRET: '' };
  assert.equal(await missingSecret.run(), 1);
  assert.equal(missingSecret.requests.length, 0);
  for (const fetchImpl of [
    async () => new Response('private HTTP details', { status: 503 }),
    async () => new Response('private malformed JSON', { status: 200 }),
    async () => { throw new Error('private network details'); },
  ]) {
    const h = harness();
    h.options.fetchImpl = fetchImpl;
    assert.equal(await h.run(), 1);
    assert.deepEqual(h.logs, []);
    assert.equal(h.errors.length, 1);
    assert.doesNotMatch(h.errors.join(''), /private|synthetic-cron-secret/);
  }
});
