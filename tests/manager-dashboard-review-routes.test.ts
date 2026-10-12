import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import type { AdminSession } from '../src/shared/lib/adminAuth';
import * as security from '../src/shared/lib/managerDashboardSecurity';
import * as html from '../src/shared/lib/managerDashboardHtml';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';
import { PersonalDashboardError } from '../src/shared/lib/managerDashboardDomain';

type Route = { GET(request: Request): Promise<Response>; POST?: unknown; PUT?: unknown; DELETE?: unknown; PATCH?: unknown };
function compile<T>(relative: string, modules: Record<string, unknown>): T {
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} as T };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}

function routes(session: AdminSession | null = { role: 'top', adminUserId: 3, sessionId: 'persisted' }) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const selected = { managerId: 7, name: 'МР', email: 'mr@example.test', audience: 'development' as const,
    bindingStatus: 'matched' as const, snapshot: { id: 17, issued: '2026-01-01', expires: '2099-12-31' },
    history: [{ id: 17, issued: '2026-01-01', expires: '2099-12-31' }] };
  let repositoryError: PersonalDashboardError | null = null;
  const repository = {
    getPersonalDashboardReviewOverview: async (...args: unknown[]) => {
      calls.push({ name: 'overview', args });
      if (repositoryError) throw repositoryError;
      if (args[1] !== undefined && args[1] !== 7) throw new PersonalDashboardError('REVIEW_NOT_FOUND', 'Отчёт МР недоступен');
      return { managers: [{ id: 7, name: 'МР', email: 'mr@example.test' }], htmlVersion: { id: 11, audience: 'development' }, selected: args[1] ? selected : null };
    },
    getPersonalDashboardReviewHtml: async (...args: unknown[]) => {
      calls.push({ name: 'html', args });
      if (repositoryError) throw repositoryError;
      return args[1] === 7 && args[2] === 11 ? '<html><body><input id="fileInp"><script>let FILE=null;function gate(){}function tryOpen(){}function decryptFile(){};/* kts-personal emailHash */</script></body></html>' : null;
    },
    getPersonalDashboardReviewSnapshot: async (...args: unknown[]) => {
      calls.push({ name: 'snapshot', args });
      if (repositoryError) throw repositoryError;
      return args[1] === 7 && (args[2] === undefined || args[2] === 17)
        ? { bytes: Buffer.from('encrypted-fixture'), email: 'mr@example.test', originalName: 'mr.ktsp' } : null;
    },
  };
  const base = {
    personalJson: (value: unknown, status = 200) => Response.json(value, { status, headers: security.PERSONAL_PRIVATE_HEADERS }),
    personalApiError: () => Response.json({ error: 'safe error' }, { status: 500 }),
  };
  const shared = compile('../src/app/api/admin/manager-dashboard/review/_shared.ts', {
    '@/shared/lib/adminAuth': { getAdminSession: async () => session },
    '@/shared/lib/managerDashboardSecurity': security,
    '../_shared': base,
  });
  const modules = { './_shared': shared, '../_shared': shared,
    '@/shared/lib/db/managerDashboardRepo': repository,
    '@/shared/lib/managerDashboardSecurity': security,
    '@/shared/lib/managerDashboardHtml': html,
    '@/shared/lib/originProtection': { enforceSameOriginRequest },
  };
  return {
    overview: compile<Route>('../src/app/api/admin/manager-dashboard/review/route.ts', modules),
    frame: compile<Route>('../src/app/api/admin/manager-dashboard/review/frame/route.ts', modules),
    content: compile<Route>('../src/app/api/admin/manager-dashboard/review/content/route.ts', modules),
    snapshots: compile<Route>('../src/app/api/admin/manager-dashboard/review/snapshots/route.ts', modules),
    calls, selected, fail: (code: string) => { repositoryError = new PersonalDashboardError(code, 'Access changed'); },
  };
}
const request = (path: string, referer?: string) => new Request(`https://example.test/api/admin/manager-dashboard/review/${path}`, {
  headers: referer ? { referer: `https://example.test/api/admin/manager-dashboard/review/${referer}` } : {},
});

test('TOP review GETs use the persisted TOP actor and selected MR while keeping encrypted bytes and private responses', async () => {
  const api = routes();
  const overview = await api.overview.GET(request('?manager=7'));
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).selected.managerId, 7);
  const frame = await api.frame.GET(request('frame?manager=7&version=11&snapshot=17'));
  assert.equal(frame.status, 200);
  const source = await frame.text();
  assert.match(source, /review\/snapshots\?manager=7&snapshot=17/);
  assert.match(source, /review\/content\?version=11&amp;manager=7/);
  assert.match(source, /sandbox="allow-scripts"/);
  const content = await api.content.GET(request('content?manager=7&version=11', 'frame?manager=7&version=11'));
  assert.equal(content.status, 200);
  assert.match(await content.text(), /encode\.encode\(em \+ ':' \+ password\)/);
  assert.match(content.headers.get('content-security-policy')!, /sandbox allow-scripts/);
  const data = await api.snapshots.GET(request('snapshots?manager=7&snapshot=17'));
  assert.equal(data.status, 200);
  assert.equal(await data.text(), 'encrypted-fixture');
  assert.equal(data.headers.get('x-personal-email'), 'mr%40example.test');
  for (const response of [overview, frame, content, data]) assert.match(response.headers.get('cache-control')!, /private, no-store/);
  for (const call of api.calls) assert.deepEqual(call.args[0], { adminUserId: 3, sessionId: 'persisted' });
});

test('review routes never authorize non-TOP roles or legacy sessions and expose no mutations', async () => {
  for (const session of [null, { role: 'top', adminUserId: 3 }, { role: 'top', sessionId: 'x' },
    ...(['admin', 'admintop', 'manager', 'support_manager', 'purchaser', 'wholesale_admin'] as const).map((role) => ({ role, adminUserId: 3, managerId: 7, sessionId: 'x' }))] as Array<AdminSession | null>) {
    const api = routes(session);
    for (const name of ['overview', 'frame', 'content', 'snapshots'] as const) {
      const route = api[name];
      const result = await route.GET(request('anything?manager=7&version=11'));
      assert.equal(result.status, session ? 403 : 401, `${session?.role} ${name}`);
      for (const verb of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) assert.equal(route[verb], undefined);
    }
    assert.equal(api.calls.length, 0);
  }
});

test('review refuses audience/preview/owner overrides, duplicate IDs and foreign snapshots before disclosure', async () => {
  const api = routes();
  for (const suffix of ['&audience=support', '&preview=1', '&manager=8', '&email=other@example.test']) {
    assert.equal((await api.frame.GET(request(`frame?manager=7&version=11${suffix}`))).status, 400);
    assert.equal((await api.snapshots.GET(request(`snapshots?manager=7${suffix}`))).status, 400);
  }
  assert.equal(api.calls.length, 0);
  assert.equal((await api.frame.GET(request('frame?manager=7&version=22'))).status, 404);
  assert.equal((await api.frame.GET(request('frame?manager=7&version=11&snapshot=99'))).status, 404);
  assert.equal((await api.snapshots.GET(request('snapshots?manager=7&snapshot=99'))).status, 404);
  assert.equal((await api.overview.GET(request('?manager=8'))).status, 404);
});

test('review content must originate from the matching protected frame; stale DB authority fails closed', async () => {
  const api = routes();
  for (const referer of [undefined, 'frame?manager=8&version=11', 'frame?manager=7&version=22', 'content?manager=7&version=11']) {
    assert.equal((await api.content.GET(request('content?manager=7&version=11', referer))).status, 403);
  }
  assert.equal(api.calls.length, 0);
  api.fail('REVIEW_FORBIDDEN');
  assert.equal((await api.overview.GET(request('?manager=7'))).status, 403);
  assert.equal((await api.frame.GET(request('frame?manager=7&version=11'))).status, 403);
  assert.equal((await api.snapshots.GET(request('snapshots?manager=7'))).status, 403);
  assert.equal((await api.content.GET(request('content?manager=7&version=11', 'frame?manager=7&version=11'))).status, 403);
});

test('TOP review frame preserves password encryption and does not fetch unavailable or expired personal data', () => {
  const output = html.buildPersonalDashboardReviewFrame({ managerId: 7, versionId: 11, snapshotId: 17, emptyState: 'expired' });
  assert.match(output.html, /const emptyState = "expired"/);
  assert.match(output.html, /if \(emptyState\)/);
  assert.doesNotMatch(output.html, /preview=1|audience=support/);
  assert.throws(() => html.buildPersonalDashboardReviewFrame({ managerId: 0, versionId: 11 }));
});
