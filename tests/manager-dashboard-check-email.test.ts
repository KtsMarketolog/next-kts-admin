import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { MANAGER_DASHBOARD_MAIL_DISABLED_MESSAGE } from '../src/shared/lib/managerDashboardMail';
import { PERSONAL_PRIVATE_HEADERS } from '../src/shared/lib/managerDashboardSecurity';

const wrapperPath = fileURLToPath(new URL('../ops/manager-dashboard/check-email.cjs', import.meta.url));
const { checkManagerDashboardEmail } = createRequire(import.meta.url)(wrapperPath) as {
  checkManagerDashboardEmail(options?: Record<string, unknown>): Promise<number>;
};
const enabledEnv = {
  MANAGER_DASHBOARD_MAIL_ENABLED: 'true',
  MANAGER_DASHBOARD_MAIL_ALLOWED_FROM: 'synthetic@example.test',
  CRON_SECRET: 'synthetic-cron-secret',
};

test('legacy dashboard wrapper is safe to import with enabled settings', () => {
  const child = spawnSync(process.execPath, ['-e', `
    globalThis.fetch = () => { throw new Error('Import must not fetch'); };
    const wrapper = require(process.argv[1]);
    if (typeof wrapper.checkManagerDashboardEmail !== 'function') process.exitCode = 2;
  `, wrapperPath], { env: { NODE_ENV: 'test', ...enabledEnv }, encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

test('legacy wrapper is permanently disabled and does not read secrets or fetch', async () => {
  const logs: string[] = [];
  const code = await checkManagerDashboardEmail({
    get env(): never { return assert.fail('Retired wrapper must not read credentials'); },
    fetchImpl() { assert.fail('Retired wrapper must not fetch'); },
    log(line: string) { logs.push(line); },
  });
  assert.equal(code, 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /disabled.*manually/);
  const child = spawnSync(process.execPath, [wrapperPath], { env: {NODE_ENV: 'test', ...enabledEnv}, encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.match(child.stdout, /disabled.*manually/);
  assert.equal(child.stderr, '');
});

function route(denied: Response | null = null) {
  const source = readFileSync(new URL('../src/app/api/admin/manager-dashboard/check-email/route.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const result = {exports: {} as {POST(request: Request): Promise<Response>}};
  const guards: Array<{request: Request; manageOnly: boolean}> = [];
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (name === '@/shared/lib/managerDashboardMail') return {MANAGER_DASHBOARD_MAIL_DISABLED_MESSAGE};
    assert.equal(name, '../_shared', 'No mail/DB/network implementation may be loaded');
    return {
      requirePersonalAccess: async (request: Request, manageOnly: boolean) => {
        guards.push({request, manageOnly});
        return {denied};
      },
      personalJson: (value: unknown, status: number) => Response.json(value, {status, headers: PERSONAL_PRIVATE_HEADERS}),
      personalApiError: () => { assert.fail('Unexpected error'); },
    };
  }, result, result.exports);
  return {POST: result.exports.POST, guards};
}

test('admin mail endpoint preserves authorization and reports manual upload only with 410', async () => {
  const request = new Request('https://example.test/api/admin/manager-dashboard/check-email', {method: 'POST'});
  const api = route();
  const response = await api.POST(request);
  assert.deepEqual(api.guards, [{request, manageOnly: true}]);
  assert.equal(response.status, 410);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.deepEqual(await response.json(), {error: MANAGER_DASHBOARD_MAIL_DISABLED_MESSAGE, code: 'MANUAL_UPLOAD_ONLY'});
  for (const status of [401, 403, 429]) {
    const denied = new Response('denied', {status});
    assert.equal(await route(denied).POST(request), denied);
  }
});
