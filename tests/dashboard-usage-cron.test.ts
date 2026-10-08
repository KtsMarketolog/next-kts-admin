import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync('src/app/api/cron/dashboard-usage/route.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const secret = 'synthetic_usage_retention_secret_00000000';

function harness(configured: string | undefined, fail = false) {
  let calls = 0;
  const messages: string[] = [];
  const modules: Record<string, unknown> = {
    'node:crypto': { timingSafeEqual },
    '@/shared/lib/db/dashboardUsageRepo': { pruneExpiredDashboardUsage: async () => {
      calls++;
      if (fail) throw new Error('private database details');
      return { ok: true, deleted: 25, remaining: false, skipped: null, cutoff: '2026-09-08T00:00:00Z' };
    } },
  };
  const exports: Record<string, (request: Request) => Promise<Response>> = {};
  runInNewContext(code, { exports, Buffer, Response,
    console: { error: (value: string) => messages.push(value) },
    process: { env: { DASHBOARD_USAGE_CRON_SECRET: configured } },
    require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
  });
  return { exports, messages, calls: () => calls };
}

function request(token: string, body?: string) {
  return new Request('http://127.0.0.1:3000/api/cron/dashboard-usage', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body,
  });
}

test('retention endpoint is POST-only with a dedicated bounded secret before any database work', async () => {
  for (const [configured, token, status] of [
    [undefined, '', 503], ['', '', 503], ['short', 'short', 503], ['x'.repeat(513), '', 503],
    [secret, '', 401], [secret, 'x'.repeat(secret.length), 401], [secret, secret, 200],
  ] as const) {
    const h = harness(configured);
    assert.equal(h.exports.GET, undefined);
    const response = await h.exports.POST(request(token));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(h.calls(), status === 200 ? 1 : 0);
    assert.equal((await response.text()).includes(secret), false);
  }
});

test('retention caller cannot supply a cutoff, actor or table and errors disclose no data', async () => {
  const h = harness(secret);
  const response = await h.exports.POST(request(secret, '{"cutoff":"2100-01-01","table":"admin_users"}'));
  assert.equal(response.status, 400);
  assert.equal(h.calls(), 0);
  const failing = harness(secret, true);
  const failure = await failing.exports.POST(request(secret));
  assert.equal(failure.status, 503);
  assert.equal((await failure.text()).includes('private'), false);
  assert.deepEqual(failing.messages, ['DASHBOARD_USAGE_RETENTION_FAILED']);
});

test('standard release packages and installs independent retention before reload, activates only after success', () => {
  const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
  assert.match(workflow, /cp scripts\/dashboard-usage-prune\.mjs deploy-artifact\/scripts\/dashboard-usage-prune\.mjs/);
  assert.match(workflow, /ops\/dashboard-usage\/kts-dashboard-usage\.timer deploy-artifact\/ops\/dashboard-usage\//);
  assert.match(workflow, /loginctl show-user/);
  const backup = workflow.indexOf('if ! "$BACKUP_RUNNER" predeploy; then');
  const install = workflow.indexOf('node "$RELEASE/ops/dashboard-usage/install.mjs" --app-env "$BASE/.env.local" --apply');
  const canary = workflow.indexOf('KTS_PM2_CANARY=1 KTS_PM2_PORT=3001');
  const convergence = workflow.indexOf('if ! wait_for_release_workers');
  const committed = workflow.indexOf('ACTIVATION_STARTED=0\n          trap - EXIT', convergence);
  const firstPurge = workflow.indexOf('systemctl --user start kts-dashboard-usage.service');
  const timer = workflow.indexOf('systemctl --user enable --now kts-dashboard-usage.timer');
  assert.ok(backup >= 0 && backup < install && install < canary);
  assert.ok(canary < convergence && convergence < committed && committed < firstPurge && firstPurge < timer);
  assert.match(workflow, /Release is active, but dashboard usage retention activation failed/);
});
