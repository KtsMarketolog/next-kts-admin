import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as security from '../src/shared/lib/managerDashboardSecurity';
import * as html from '../src/shared/lib/managerDashboardHtml';
import * as routePlannerHtml from '../src/shared/lib/supportSharedRoutePlannerHtml';
import * as origin from '../src/shared/lib/originProtection';
import * as upload from '../src/app/api/admin/top-dashboard/blocks/routeUtils';

function compile<T>(filename: string, modules: Record<string, unknown>): T {
  const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  const testModule = {exports: {} as T};
  new Function('require', 'module', 'exports', 'console', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, testModule, testModule.exports, {error: () => {}});
  return testModule.exports;
}

const fixture = '<html><body><input id="fileInp"><script>let FILE=null;function gate(){} function tryOpen(){} function decryptFile(){} const fmt="kts-personal",emailHash="";</script></body></html>';
const routeFixture = '<html><head></head><body><input id="snapIn"><script>const S={}; function revive(x){return x;} function loadSnapshot(j){S.orders = revive(j.orders);} function handleFiles(list){} const snapshot={app:"компоновщик"};window.UI = {};</script></body></html>';
const sharedSnapshot = {id: 31, email: 'shared@example.test', originalName: 'shared.ktsp', issued: '2026-09-16', expires: '2099-12-31', expired: false};
type Role = 'admin' | 'admintop' | 'manager' | 'support_manager' | 'top' | null;
type Route = {GET(request: Request): Promise<Response>; POST(request: Request): Promise<Response>; DELETE(request: Request): Promise<Response>};

function routes(role: Role = 'support_manager', options: {inactive?: boolean; currentRole?: string; limit?: boolean; noSnapshot?: boolean; expired?: boolean; routePlanner?: boolean; foreignPreviewSnapshot?: boolean} = {}) {
  const calls: Array<{name: string; args: unknown[]}> = [];
  const session = role ? {role, sessionId: 'synthetic-session', adminUserId: 2, managerId: 71} : null;
  const manager = {id: 71, role: options.currentRole ?? role, email: '', isActive: !options.inactive};
  const base = compile<typeof import('../src/app/api/admin/manager-dashboard/_shared')>(
    '../src/app/api/admin/manager-dashboard/_shared.ts', {
      '@/shared/lib/adminAuth': {getAdminSession: async () => session},
      '@/shared/lib/adminSecurity': {enforceAdminActionRateLimit: async () => options.limit ? new Response(null, {status: 429}) : null},
      '@/shared/lib/db/wholesaleAdminRepo/managerRepo': {getWholesaleManagerById: async () => manager},
      '@/shared/lib/managerDashboardSecurity': security, '@/shared/lib/originProtection': origin,
    });
  const shared = compile<typeof import('../src/app/api/admin/manager-dashboard/shared/_shared')>(
    '../src/app/api/admin/manager-dashboard/shared/_shared.ts', {'../_shared': base});
  const observed = (name: string, fn: (...args: unknown[]) => unknown) => async (...args: unknown[]) => {
    calls.push({name, args}); return fn(...args);
  };
  const snapshot = options.noSnapshot ? null : {...sharedSnapshot, expired: !!options.expired};
  const jsonSnapshot = options.noSnapshot ? null : {id: 81, htmlVersionId: 22};
  const overview = {htmlVersions: [{id: 22, audience: 'support', originalName: 'shared.html'}], activeHtmlVersionId: 22, previousHtmlVersionId: null, snapshot, history: snapshot ? [snapshot] : [], jsonSnapshot, jsonHistory: jsonSnapshot ? [jsonSnapshot] : []};
  const repo = {
    getSupportSharedDashboardOverview: observed('overview', () => overview),
    getSupportSharedDashboardHtml: observed('html', (id, preview) => id === 22 || (preview && id === 23) ? {id, htmlContent: options.routePlanner ? routeFixture : fixture, format: options.routePlanner ? 'route-planner-v1' : 'ktsp'} : null),
    getSupportSharedDashboardSnapshot: observed('snapshot', (_manager, id) => id === undefined || id === 31 ? {...sharedSnapshot, bytes: Buffer.from('encrypted-fixture')} : null),
    getSupportSharedDashboardJsonPreviewMetadata: observed('preview-metadata', (htmlVersionId) => options.noSnapshot ? null
      : {id: htmlVersionId === 23 ? 82 : 81, htmlVersionId: options.foreignPreviewSnapshot ? 99 : htmlVersionId}),
    createSupportSharedDashboardHtml: observed('create', () => ({id: 24})),
    activateSupportSharedDashboardHtml: observed('publish', () => ({activeHtmlVersionId: 24})),
    deleteSupportSharedDashboardHtml: observed('delete', () => ({deleted: true})),
    importSupportSharedDashboardSnapshot: observed('import', () => ({status: 'imported', snapshot: sharedSnapshot})),
  };
  const common = {
    '@/shared/lib/db/supportSharedDashboardRepo': repo,
    '@/shared/lib/managerDashboardHtml': html,
    '@/shared/lib/supportSharedRoutePlannerHtml': routePlannerHtml,
    '@/shared/lib/managerDashboardSecurity': security,
    '@/shared/lib/originProtection': origin,
    '../../../top-dashboard/blocks/routeUtils': upload,
    '../../_shared': base, '../_shared': shared,
  };
  const route = (name: string) => compile<Route>(`../src/app/api/admin/manager-dashboard/shared/${name}/route.ts`, common);
  const personal = {
    listPersonalDashboardAdmin: async () => ({groups: [], imports: [], importsNextCursor: null}),
    getPersonalDashboardStatus: async () => ({audience: role === 'support_manager' ? 'support' : 'development', snapshot: null, history: [], bindingStatus: 'missing_email'}),
    getPersonalDashboardHtml: async () => null,
  };
  const overviewRoute = compile<Route>('../src/app/api/admin/manager-dashboard/route.ts', {
    '@/shared/lib/db/managerDashboardRepo': personal,
    '@/shared/lib/db/supportSharedDashboardRepo': repo,
    '@/shared/lib/managerDashboardSecurity': security, './_shared': base,
  });
  return {frame: route('frame'), content: route('content'), snapshots: route('snapshots'), html: route('html'), publish: route('publish'), overview: overviewRoute, calls};
}

const ROOT = 'https://example.test/api/admin/manager-dashboard/shared/';
function request(path: string, init?: RequestInit) { return new Request(ROOT + path, init); }
function json(body: unknown, originValue = 'https://example.test'): RequestInit {
  return {method: 'POST', headers: {'content-type': 'application/json', origin: originValue}, body: JSON.stringify(body)};
}
function snapshotForm(overrides: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', new File(['synthetic-encrypted-bytes'], 'shared.ktsp'));
  for (const [key, value] of Object.entries({email: 'shared@example.test', expectedActiveSnapshotId: 'null', confirmShared: 'true', ...overrides})) form.append(key, value);
  return form;
}

test('route-planner frame selects only version-bound JSON and never the legacy KTSP', async () => {
  const api = routes('support_manager', {routePlanner: true});
  const response = await api.frame.GET(request('frame?version=22'));
  assert.equal(response.status, 200);
  const document = await response.text();
  assert.match(document, /shared\/json\?version=22&snapshot=81/);
  assert.doesNotMatch(document, /shared\/snapshots/);
  assert.equal((await api.frame.GET(request('frame?version=22&snapshot=31'))).status, 404);
  const noData = routes('support_manager', {routePlanner: true, noSnapshot: true});
  assert.match(await (await noData.frame.GET(request('frame?version=22'))).text(), /hasSnapshot = false/);
});

test('administrator route-planner preview resolves JSON only for the selected HTML version', async () => {
  for (const role of ['admin', 'admintop'] as const) {
    for (const version of [22, 23]) {
      const api = routes(role, {routePlanner: true});
      const response = await api.frame.GET(request(`frame?version=${version}&preview=1`));
      assert.equal(response.status, 200);
      const document = await response.text();
      assert.match(document, new RegExp(`shared/json\\?version=${version}&snapshot=${version === 23 ? 82 : 81}&preview=1`));
      assert.match(document, /hasSnapshot = true/);
      assert.deepEqual(api.calls, [{name: 'html', args: [version, true, undefined]}, {name: 'preview-metadata', args: [version]}]);
    }
  }
  const foreign = routes('admin', {routePlanner: true, foreignPreviewSnapshot: true});
  assert.equal((await foreign.frame.GET(request('frame?version=23&preview=1'))).status, 404);
  const empty = routes('admin', {routePlanner: true, noSnapshot: true});
  const response = await empty.frame.GET(request('frame?version=23&preview=1'));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /hasSnapshot = false/);
  const injected = routes('admin', {routePlanner: true});
  assert.equal((await injected.frame.GET(request('frame?version=23&preview=1&snapshot=81'))).status, 403);
  assert.deepEqual(injected.calls, []);
});

test('route-planner content retains opaque sandbox and hashed scripts with limited map images', async () => {
  const api = routes('support_manager', {routePlanner: true});
  const response = await api.content.GET(request('content?version=22', {headers: {referer: ROOT + 'frame?version=22'}}));
  assert.equal(response.status, 200);
  const csp = response.headers.get('content-security-policy')!;
  assert.match(csp, /sandbox allow-scripts(?:;|$)/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /script-src 'sha256-/);
  assert.match(csp, /script-src-attr 'unsafe-inline'/);
  assert.match(csp, /img-src data: blob:/);
  assert.doesNotMatch(csp, /https:\/\/tile.openstreetmap.org/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-popups|unsafe-eval/);
  assert.match(await response.text(), /__ktsLoadSharedSnapshot/);
});

test('shared report denies unauthorized, development and stale roles before repository reads', async () => {
  for (const [role, options, expected] of [
    [null, {}, 401], ['top', {}, 403], ['manager', {}, 403],
    ['support_manager', {inactive: true}, 403], ['support_manager', {currentRole: 'manager'}, 403],
  ] as const) {
    const api = routes(role, options);
    assert.equal((await api.frame.GET(request('frame?version=22'))).status, expected);
    assert.equal((await api.content.GET(request('content?version=22'))).status, expected);
    assert.equal((await api.snapshots.GET(request('snapshots'))).status, expected);
    assert.deepEqual(api.calls, []);
  }
});

test('support reads shared data using session manager ID but shared recipient email, without own-email binding', async () => {
  const api = routes();
  const response = await api.snapshots.GET(request('snapshots?snapshot=31'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-personal-email'), encodeURIComponent('shared@example.test'));
  assert.match(response.headers.get('cache-control')!, /private.*no-store/);
  assert.equal(await response.text(), 'encrypted-fixture');
  assert.deepEqual(api.calls, [{name: 'snapshot', args: [71, 31]}]);
});

test('shared routes reject duplicate IDs, cross-scope selectors and viewer previews', async () => {
  const api = routes();
  for (const suffix of ['?snapshot=31&snapshot=31', '?managerId=72', '?audience=support', '?snapshot=01']) {
    assert.equal((await api.snapshots.GET(request('snapshots' + suffix))).status, 400);
  }
  for (const suffix of ['?version=22&version=22', '?version=22&managerId=72', '?version=22&preview=0', '?version=22&snapshot=bad']) {
    assert.equal((await api.frame.GET(request('frame' + suffix))).status, 400);
  }
  assert.equal((await api.frame.GET(request('frame?version=23&preview=1'))).status, 403);
  assert.deepEqual(api.calls, []);
});

test('frame pins a shared snapshot, leaves HTML visible without data, rejects foreign snapshot IDs', async () => {
  const api = routes();
  const frame = await api.frame.GET(request('frame?version=22&revision=0'));
  assert.equal(frame.status, 200);
  assert.match(await frame.text(), /shared\/snapshots\?snapshot=31/);
  assert.equal((await api.frame.GET(request('frame?version=22&snapshot=999'))).status, 404);
  for (const [options, reason] of [[{noSnapshot: true}, 'no_snapshot'], [{expired: true}, 'expired']] as const) {
    const emptyApi = routes('support_manager', options);
    const empty = await emptyApi.frame.GET(request('frame?version=22'));
    assert.equal(empty.status, 200);
    assert.match(await empty.text(), new RegExp(`const emptyState = "${reason}"`));
    assert.equal(emptyApi.calls.some((call) => call.name === 'snapshot'), false);
  }
});

test('administrator KTSP previews remain without snapshot reads and cannot use viewer data endpoints', async () => {
  for (const role of ['admin', 'admintop'] as const) {
    const api = routes(role);
    const frame = await api.frame.GET(request('frame?version=23&preview=1'));
    assert.equal(frame.status, 200);
    assert.match(await frame.text(), /const preview = true/);
    assert.deepEqual(api.calls, [{name: 'html', args: [23, true, undefined]}]);
    assert.equal((await api.frame.GET(request('frame?version=23&preview=1&snapshot=31'))).status, 403);
    assert.equal((await api.snapshots.GET(request('snapshots'))).status, 403);
  }
});

test('content requires same-origin shared frame referer, published HTML and strict sandbox', async () => {
  const api = routes();
  for (const referer of ['', 'malformed', 'https://evil.test/api/admin/manager-dashboard/shared/frame?version=22',
    'https://example.test/api/admin/manager-dashboard/frame?version=22', ROOT + 'frame?version=23', ROOT + 'frame?version=22&preview=1']) {
    assert.equal((await api.content.GET(request('content?version=22', {headers: {referer, origin: 'https://example.test'}}))).status, 403);
  }
  assert.deepEqual(api.calls, []);
  const good = await api.content.GET(request('content?version=22', {headers: {referer: ROOT + 'frame?version=22'}}));
  assert.equal(good.status, 200);
  assert.match(good.headers.get('content-security-policy')!, /connect-src 'none'/);
  assert.doesNotMatch(good.headers.get('content-security-policy')!, /allow-same-origin|unsafe-eval/);
  assert.match(await good.text(), /Пароль общего снимка/);
  const draft = await api.content.GET(request('content?version=23', {headers: {referer: ROOT + 'frame?version=23'}}));
  assert.equal(draft.status, 404);
  const proxy = new Request('http://localhost:3000/api/admin/manager-dashboard/shared/content?version=22', {headers: {
    referer: ROOT + 'frame?version=22', 'x-forwarded-host': 'example.test', 'x-forwarded-proto': 'https',
  }});
  assert.equal((await api.content.GET(proxy)).status, 200, 'trusted proxy origin follows the existing application policy');
});

test('every shared write requires admin, same origin and rate limiting', async () => {
  for (const [role, options, expected] of [['support_manager', {}, 403], ['manager', {}, 403], [null, {}, 401], ['admin', {limit: true}, 429]] as const) {
    const api = routes(role, options);
    assert.equal((await api.publish.POST(request('publish', json({versionId: 24, expectedActiveVersionId: 22})))).status, expected);
    assert.equal((await api.html.POST(request('html', {method: 'POST'}))).status, role === 'admin' ? 403 : expected);
    assert.equal((await api.html.DELETE(request('html?id=23', {method: 'DELETE', headers: {origin: 'https://example.test'}}))).status, expected);
    assert.equal((await api.snapshots.POST(request('snapshots', {method: 'POST', headers: {origin: 'https://example.test'}, body: snapshotForm()}))).status, expected);
    assert.deepEqual(api.calls, []);
  }
  const api = routes('admin');
  assert.equal((await api.publish.POST(request('publish', json({versionId: 24, expectedActiveVersionId: 22}, 'https://evil.test')))).status, 403);
  assert.deepEqual(api.calls, []);
});

test('shared uploads, publication and deletion use only separate repository mutations', async () => {
  const api = routes('admintop');
  const form = new FormData(); form.set('file', new File([fixture], 'shared.html'));
  assert.equal((await api.html.POST(request('html', {method: 'POST', headers: {origin: 'https://example.test'}, body: form}))).status, 201);
  assert.equal((await api.publish.POST(request('publish', json({versionId: 24, expectedActiveVersionId: 22})))).status, 200);
  assert.equal((await api.html.DELETE(request('html?id=23', {method: 'DELETE', headers: {origin: 'https://example.test'}}))).status, 200);
  const imported = await api.snapshots.POST(request('snapshots', {method: 'POST', headers: {origin: 'https://example.test'}, body: snapshotForm()}));
  assert.equal(imported.status, 200);
  assert.deepEqual(api.calls.map((call) => call.name), ['create', 'publish', 'delete', 'import']);
  assert.deepEqual(api.calls[1].args, [{versionId: 24, expectedActiveVersionId: 22, actorId: 'admintop:2'}]);
  assert.deepEqual(api.calls[2].args, [{versionId: 23, actorId: 'admintop:2'}]);
  assert.deepEqual(api.calls[3].args, [{filename: 'shared.ktsp', bytes: Buffer.from('synthetic-encrypted-bytes'), email: 'shared@example.test', actorId: 'admintop:2', expectedActiveSnapshotId: null}]);
});

test('shared upload needs explicit group-sharing confirmation, single file and snapshot CAS', async () => {
  const api = routes('admin');
  const forms = [snapshotForm({confirmShared: 'false'}), snapshotForm({expectedActiveSnapshotId: ''})];
  const duplicate = snapshotForm(); duplicate.append('file', new File(['b'], 'b.ktsp')); forms.push(duplicate);
  const extra = snapshotForm(); extra.append('managerId', '71'); forms.push(extra);
  for (const body of forms) {
    assert.equal((await api.snapshots.POST(request('snapshots', {method: 'POST', headers: {origin: 'https://example.test'}, body}))).status, 400);
  }
  const big = snapshotForm(); big.set('file', new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'big.ktsp'));
  assert.equal((await api.snapshots.POST(request('snapshots', {method: 'POST', headers: {origin: 'https://example.test'}, body: big}))).status, 413);
  for (const body of [{versionId: 24}, {versionId: 24, expectedActiveVersionId: 22, managerId: 71}, {versionId: '24', expectedActiveVersionId: 22}]) {
    assert.equal((await api.publish.POST(request('publish', json(body)))).status, 400);
  }
  assert.deepEqual(api.calls, []);
});

test('overview exposes shared reports only to administrators and support, without a mail schedule', async () => {
  for (const role of ['admin', 'admintop', 'manager', 'support_manager'] as const) {
    const api = routes(role);
    const response = await api.overview.GET(request(''));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal('supportShared' in body, role !== 'manager');
    assert.equal('mail' in body, false);
    assert.equal('expectedBy' in body, false);
    assert.deepEqual(api.calls.filter((call) => call.name === 'overview').map((call) => call.args), role === 'manager' ? [] : role === 'support_manager' ? [[71]] : [[]]);
  }
});
