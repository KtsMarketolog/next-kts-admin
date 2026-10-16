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
type Owner = { source: 'admin'; id: number };
const own: Owner = { source: 'admin', id: 3 };
const htmlSource = '<html><body><input id="fileInp"><script>let FILE=null;function gate(){}function tryOpen(){}function decryptFile(){};/* kts-personal emailHash */</script></body></html>';

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

function routes(session: AdminSession | null = { role: 'top', adminUserId: 3, managerId: 3, sessionId: 'persisted' }) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const snapshot = { id: 17, issued: '2026-01-01', expires: '2099-12-31' };
  const status: {
    audience: 'development'; email: string; bindingStatus: 'matched' | 'missing_email' | 'ambiguous_email';
    snapshot: typeof snapshot | null; history: Array<typeof snapshot>;
  } = {
    audience: 'development', email: 'leader@example.test', bindingStatus: 'matched',
    snapshot, history: [snapshot],
  };
  let repositoryError: PersonalDashboardError | null = null;
  const recordOwner = (name: string, args: unknown[]) => {
    calls.push({ name, args });
    // admin_users and wholesale_managers may share the same numeric ID. A bare
    // number or manager source must never select the other account's snapshot.
    assert.deepEqual(args[0], own);
    if (repositoryError) throw repositoryError;
  };
  const repository = {
    getPersonalDashboardStatus: async (...args: unknown[]) => {
      recordOwner('status', args);
      return status;
    },
    getPersonalDashboardHtml: async (...args: unknown[]) => {
      calls.push({ name: 'html', args });
      if (repositoryError) throw repositoryError;
      assert.equal(args[1], false);
      assert.equal(args[2], 'development');
      return args[0] === undefined || args[0] === 11
        ? { id: 11, htmlContent: htmlSource, audience: 'development', originalName: 'personal.html', firstPublishedAt: '2026-01-01' }
        : null;
    },
    getPersonalDashboardSnapshot: async (...args: unknown[]) => {
      recordOwner('snapshot', args);
      return args[1] === undefined || args[1] === 17
        ? { ...snapshot, bytes: Buffer.from('encrypted-leader-fixture'), email: 'leader@example.test', originalName: 'leader.ktsp' }
        : null;
    },
  };
  const base = {
    personalJson: (value: unknown, code = 200) => Response.json(value, { status: code, headers: security.PERSONAL_PRIVATE_HEADERS }),
    personalApiError: (error: unknown) => Response.json({ error: 'safe error' }, {
      status: error instanceof PersonalDashboardError ? 400 : 500, headers: security.PERSONAL_PRIVATE_HEADERS,
    }),
  };
  const shared = compile('../src/app/api/admin/manager-dashboard/own/_shared.ts', {
    '@/shared/lib/adminAuth': { getAdminSession: async () => session },
    '@/shared/lib/managerDashboardSecurity': security,
    '../_shared': base,
  });
  const modules = {
    './_shared': shared, '../_shared': shared,
    '@/shared/lib/db/managerDashboardRepo': repository,
    '@/shared/lib/managerDashboardSecurity': security,
    '@/shared/lib/managerDashboardHtml': html,
    '@/shared/lib/originProtection': { enforceSameOriginRequest },
  };
  return {
    overview: compile<Route>('../src/app/api/admin/manager-dashboard/own/route.ts', modules),
    frame: compile<Route>('../src/app/api/admin/manager-dashboard/own/frame/route.ts', modules),
    content: compile<Route>('../src/app/api/admin/manager-dashboard/own/content/route.ts', modules),
    snapshots: compile<Route>('../src/app/api/admin/manager-dashboard/own/snapshots/route.ts', modules),
    calls, status, fail: (code: string) => { repositoryError = new PersonalDashboardError(code, 'Access changed'); },
  };
}

const request = (path = '', referer?: string) => new Request(`https://example.test/api/admin/manager-dashboard/own/${path}`, {
  headers: referer ? { referer: referer.includes('://') ? referer : `https://example.test/api/admin/manager-dashboard/own/${referer}` } : {},
});

test('persisted ADMIN, ADMIN TOP and TOP sessions read only their own admin-source personal snapshot', async () => {
  for (const role of ['admin', 'admintop', 'top'] as const) {
    const api = routes({ role, adminUserId: 3, managerId: 3, sessionId: 'persisted' });
    const overview = await api.overview.GET(request());
    assert.equal(overview.status, 200, role);
    const overviewData = await overview.json();
    assert.equal(overviewData.email, 'leader@example.test');
    assert.equal(overviewData.snapshot.id, 17);
    const frame = await api.frame.GET(request('frame?version=11&snapshot=17'));
    assert.equal(frame.status, 200, role);
    const frameSource = await frame.text();
    assert.match(frameSource, /own\/snapshots\?snapshot=17/);
    assert.match(frameSource, /own\/content\?version=11/);
    assert.match(frameSource, /sandbox="allow-scripts"/);
    assert.doesNotMatch(frameSource, /[?&](?:amp;)?(?:manager|adminUserId|owner|source)=/);
    const content = await api.content.GET(request('content?version=11', 'frame?version=11&snapshot=17'));
    assert.equal(content.status, 200, role);
    assert.match(await content.text(), /encode\.encode\(em \+ ':' \+ password\)/);
    assert.match(content.headers.get('content-security-policy')!, /sandbox allow-scripts/);
    const data = await api.snapshots.GET(request('snapshots?snapshot=17'));
    assert.equal(data.status, 200, role);
    assert.equal(await data.text(), 'encrypted-leader-fixture');
    assert.equal(data.headers.get('x-personal-email'), 'leader%40example.test');
    assert.equal(data.headers.get('x-personal-filename'), 'leader.ktsp');
    for (const response of [overview, frame, content, data]) {
      assert.match(response.headers.get('cache-control')!, /private, no-store/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    assert.ok(api.calls.some((call) => call.name === 'status'));
    assert.ok(api.calls.some((call) => call.name === 'snapshot'));
  }
});

test('own snapshot APIs deny anonymous, legacy, malformed-ID and non-leader sessions without touching data', async () => {
  const deniedSessions: Array<AdminSession | null> = [
    null,
    ...(['admin', 'admintop', 'top'] as const).flatMap((role) => [
      { role, adminUserId: 3 },
      { role, adminUserId: 3, sessionId: '' },
      { role, sessionId: 'persisted' },
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((adminUserId) => ({ role, adminUserId, sessionId: 'persisted' })),
    ]),
    ...(['manager', 'support_manager', 'purchaser', 'wholesale_admin'] as const)
      .map((role) => ({ role, adminUserId: 3, managerId: 3, sessionId: 'persisted' })),
  ];
  for (const session of deniedSessions) {
    const api = routes(session);
    for (const name of ['overview', 'frame', 'content', 'snapshots'] as const) {
      const route = api[name];
      const response = await route.GET(request('anything?version=11&snapshot=17'));
      assert.equal(response.status, session ? 403 : 401, `${session?.role} ${session?.adminUserId} ${name}`);
      assert.match(response.headers.get('cache-control')!, /private, no-store/);
      for (const verb of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) assert.equal(route[verb], undefined);
    }
    assert.equal(api.calls.length, 0);
  }
});

test('own APIs reject recipient selectors, unknown query fields and duplicates before repository access', async () => {
  const api = routes();
  for (const override of ['manager=3', 'managerId=3', 'adminUserId=3', 'owner=3', 'source=manager', 'email=other@example.test', 'preview=1', 'audience=support']) {
    assert.equal((await api.overview.GET(request(`?${override}`))).status, 400, `overview ${override}`);
    assert.equal((await api.frame.GET(request(`frame?version=11&${override}`))).status, 400, `frame ${override}`);
    assert.equal((await api.content.GET(request(`content?version=11&${override}`, 'frame?version=11'))).status, 400, `content ${override}`);
    assert.equal((await api.snapshots.GET(request(`snapshots?${override}`))).status, 400, `snapshots ${override}`);
  }
  for (const suffix of ['version=11&version=11', 'version=11&snapshot=17&snapshot=17', 'version=11&audience=development&audience=development']) {
    assert.equal((await api.frame.GET(request(`frame?${suffix}`))).status, 400, suffix);
  }
  assert.equal((await api.content.GET(request('content?version=11&version=11', 'frame?version=11'))).status, 400);
  assert.equal((await api.snapshots.GET(request('snapshots?snapshot=17&snapshot=17'))).status, 400);
  for (const id of ['0', '-1', '1.5', '9007199254740992', '011', '']) {
    assert.equal((await api.frame.GET(request(`frame?version=${id}`))).status, 400, id);
    assert.equal((await api.snapshots.GET(request(`snapshots?snapshot=${id}`))).status, 400, id);
  }
  assert.equal(api.calls.length, 0);
});

test('own frame permits only published development HTML and snapshots belonging to the current admin owner', async () => {
  const api = routes();
  assert.equal((await api.frame.GET(request('frame?version=11&audience=development'))).status, 200);
  assert.equal((await api.frame.GET(request('frame?version=11&audience=development&revision=2'))).status, 200);
  assert.equal((await api.frame.GET(request('frame?version=22'))).status, 404);
  assert.equal((await api.frame.GET(request('frame?version=11&snapshot=99'))).status, 404);
  assert.equal((await api.snapshots.GET(request('snapshots?snapshot=99'))).status, 404);
  assert.equal((await api.snapshots.GET(request('snapshots'))).status, 200);
  assert.equal(api.calls.filter((call) => call.name === 'snapshot').length, 2);
});

test('own HTML requires its matching same-origin protected frame, not manager/review or a foreign frame', async () => {
  const api = routes();
  for (const referer of [undefined, 'frame?version=22', 'content?version=11',
    'https://example.test/api/admin/manager-dashboard/frame?version=11',
    'https://example.test/api/admin/manager-dashboard/review/frame?version=11&manager=3',
    'https://other.example/api/admin/manager-dashboard/own/frame?version=11']) {
    assert.equal((await api.content.GET(request('content?version=11', referer))).status, 403, referer);
  }
  assert.equal(api.calls.length, 0);
});

test('expired own snapshots produce an empty protected frame without fetching encrypted bytes', async () => {
  const api = routes();
  api.status.snapshot!.expires = '2000-01-01';
  const response = await api.frame.GET(request('frame?version=11&snapshot=17'));
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.match(source, /const emptyState = "expired"/);
  assert.match(source, /if \(emptyState\)/);
  assert.doesNotMatch(source, /own\/snapshots\?snapshot=17/);
  assert.equal(api.calls.filter((call) => call.name === 'snapshot').length, 0);
});

test('own frame keeps missing and ambiguous recipients empty instead of loading another account with the same email', async () => {
  for (const bindingStatus of ['missing_email', 'ambiguous_email', 'matched'] as const) {
    const api = routes();
    api.status.bindingStatus = bindingStatus;
    api.status.snapshot = null;
    api.status.history = [];
    const response = await api.frame.GET(request('frame?version=11'));
    assert.equal(response.status, 200);
    const source = await response.text();
    const expected = bindingStatus === 'matched' ? 'no_snapshot' : bindingStatus;
    assert.ok(source.includes(`const emptyState = "${expected}"`));
    assert.equal(api.calls.filter((call) => call.name === 'snapshot').length, 0);
  }
});

test('own APIs fail closed if current recipient authority disappears in the repository', async () => {
  const api = routes();
  api.fail('NOT_FOUND');
  for (const [route, req] of [
    [api.overview, request()],
    [api.frame, request('frame?version=11')],
    [api.content, request('content?version=11', 'frame?version=11')],
    [api.snapshots, request('snapshots')],
  ] as const) {
    const response = await route.GET(req);
    assert.ok(response.status >= 400);
    assert.doesNotMatch(await response.text(), /encrypted-leader-fixture|leader@example\.test/);
    assert.match(response.headers.get('cache-control')!, /private, no-store/);
  }
});
