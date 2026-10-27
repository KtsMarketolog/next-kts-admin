import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import ts from 'typescript';
import { PersonalDashboardError } from '../src/shared/lib/managerDashboardDomain';
import * as security from '../src/shared/lib/managerDashboardSecurity';
import * as origin from '../src/shared/lib/originProtection';
import * as dashboardAccess from '../src/shared/lib/dashboardAccess';
import * as uploadRequestGuard from '../src/shared/lib/uploadRequestGuard';
import { SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES } from '../src/shared/lib/supportSharedRoutePlannerLimits';

function compile<T>(filename: string, modules: Record<string, unknown>): T {
  const code = ts.transpileModule(readFileSync(new URL(filename, import.meta.url), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const loaded = {exports: {} as T};
  new Function('require', 'module', 'exports', 'console', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency ${name}`); return modules[name];
  }, loaded, loaded.exports, {error: () => {}});
  return loaded.exports;
}
type Role = 'admin' | 'admintop' | 'support_manager' | 'manager' | 'top' | 'purchaser' | null;
function api(role: Role = 'admin', options: {
  sessionId?: string | null; inactive?: boolean; limited?: boolean; busy?: boolean;
  preflightError?: Error; prepareError?: Error; importError?: Error; duplicate?: boolean;
  missingSnapshot?: boolean; readError?: Error; grants?: string[];
  prepare?: (request: Request) => Promise<void>; importDelayMs?: number; commitDelayMs?: number;
  guardLimits?: {maxBytes?: number; idleTimeoutMs?: number; totalTimeoutMs?: number};
} = {}) {
  const calls: Array<{name: string; args: unknown[]}> = [];
  const uploadUsage: Array<Record<string, unknown>> = [];
  const observe = (name: string, fn: (...args: unknown[]) => unknown = () => undefined) => async (...args: unknown[]) => {
    calls.push({name, args}); return fn(...args);
  };
  const session = role ? {role, sessionId: options.sessionId === undefined ? 'synthetic' : options.sessionId, adminUserId: 7, managerId: 20,
    dashboardAccess: options.grants ?? (role === 'support_manager' ? ['route-planner'] : [])} : null;
  const base = compile<typeof import('../src/app/api/admin/manager-dashboard/_shared')>('../src/app/api/admin/manager-dashboard/_shared.ts', {
    '@/shared/lib/adminAuth': {getAdminSession: async () => session},
    '@/shared/lib/adminSecurity': {enforceAdminActionRateLimit: async () => options.limited ? new Response(null, {status: 429}) : null},
    '@/shared/lib/db/wholesaleAdminRepo/managerRepo': {getWholesaleManagerById: async () => ({id: 20, role, isActive: !options.inactive})},
    '@/shared/lib/managerDashboardSecurity': security, '@/shared/lib/originProtection': origin,
  });
  const shared = compile<typeof import('../src/app/api/admin/manager-dashboard/shared/_shared')>(
    '../src/app/api/admin/manager-dashboard/shared/_shared.ts', {'../_shared': base,
      '@/shared/lib/adminAuth': {getAdminSession: async () => session},
      '@/shared/lib/adminSecurity': {enforceAdminActionRateLimit: async () => options.limited ? new Response(null, {status: 429}) : null},
      '@/shared/lib/db/wholesaleAdminRepo/managerRepo': {getWholesaleManagerById: async () => ({id: 20, role, isActive: !options.inactive})},
      '@/shared/lib/dashboardAccess': dashboardAccess,
      '@/shared/lib/managerDashboardSecurity': security, '@/shared/lib/originProtection': origin,
    });
  const pending = {fileSize: 18, sha256: 'a'.repeat(64), firstBytes: Buffer.from('{"'), temporaryPath: '/synthetic',
    commit: observe('commit', async () => {
      if (options.commitDelayMs) await new Promise((resolve) => setTimeout(resolve, options.commitDelayMs));
      return 'aa/file.bin';
    }), discard: observe('discard'), preserve: observe('preserve')};
  const snapshot = {id: 9, htmlVersionId: 8, originalName: 'маршруты.json', fileSize: 18, sha256: 'a'.repeat(64),
    savedAt: '2026-09-17T05:28:47.226Z', receivedAt: '2026-09-17', uploadedBy: 'admin:7', status: 'active'};
  const route = compile<typeof import('../src/app/api/admin/manager-dashboard/shared/json/route')>(
    '../src/app/api/admin/manager-dashboard/shared/json/route.ts', {
      'node:stream': {Readable}, '@/shared/lib/managerDashboardDomain': {PersonalDashboardError},
      '@/shared/lib/dashboardUploadUsage': { getDashboardUploadUsageActor: () => ({actorKey: 'admin:7', actorRole: role}), scheduleDashboardUploadUsageDrain() { uploadUsage.push({}); } },
      '@/shared/lib/managerDashboardSecurity': security, '../../_shared': base, '../_shared': shared,
      '@/shared/lib/db/supportSharedDashboardRepo': {
        assertSupportSharedJsonUploadTarget: observe('preflight', () => {if (options.preflightError) throw options.preflightError;}),
        importSupportSharedDashboardJson: observe('import', async () => {
          if (options.importDelayMs) await new Promise((resolve) => setTimeout(resolve, options.importDelayMs));
          if (options.importError) throw options.importError;
          return {status: options.duplicate ? 'duplicate' : 'imported', snapshot, prunedStoragePaths: ['synthetic-pruned-file']};
        }),
        getSupportSharedDashboardJsonSnapshot: observe('read', () => ({...snapshot, stream: Readable.from([Buffer.from('{"synthetic":true}')])})),
        getSupportSharedDashboardJsonPreviewSnapshot: observe('preview-read', () => {
          if (options.readError) throw options.readError;
          return options.missingSnapshot ? null : {...snapshot, stream: Readable.from([Buffer.from('{"synthetic":true}')])};
        }),
      },
      '@/shared/lib/supportSharedRoutePlannerData': {SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES,
        prepareSupportSharedRoutePlannerUpload: observe('prepare', async (request) => {
          if (options.prepareError) throw options.prepareError;
          await options.prepare?.(request as Request);
          return {pending, savedAt: snapshot.savedAt};
        })},
      '@/shared/lib/topDashboardDataStorage': {deleteTopDashboardDataFiles: observe('prune')},
      '@/shared/lib/topDashboardUploadConcurrency': {acquireDistributedTopDashboardDataUploadSlot: observe('lock', () => options.busy ? null : observe('release'))},
      '@/shared/lib/uploadRequestGuard': {...uploadRequestGuard,
        createUploadRequestGuard: (request: Request, limits: {maxBytes: number}) => uploadRequestGuard.createUploadRequestGuard(request, {...limits, ...options.guardLimits})},
    });
  return {route, calls, snapshot, uploadUsage};
}
const URL_ROOT = 'https://example.test/api/admin/manager-dashboard/shared/json';
function upload(headers: Record<string, string> = {}, suffix = '') {
  return new Request(URL_ROOT + suffix, {method: 'POST', body: 'synthetic gzip', headers: {
    origin: 'https://example.test', 'content-type': 'application/gzip', 'x-kts-shared-version': '8',
    'x-kts-shared-expected-snapshot': 'null', 'x-kts-shared-confirm': 'true',
    'x-kts-shared-filename': encodeURIComponent('маршруты.json'), ...headers,
  }});
}

test('shared JSON writes authorize persisted administrators and origin before preflight, locking or body inspection', async () => {
  for (const [role, options, status] of [[null, {}, 401], ['manager', {}, 403], ['support_manager', {}, 403],
    ['top', {}, 403], ['admin', {sessionId: null}, 403], ['admin', {limited: true}, 429]] as const) {
    const harness = api(role, options);
    assert.equal((await harness.route.POST(upload())).status, status);
    assert.deepEqual(harness.calls, []);
    assert.equal(harness.uploadUsage.length, 0);
  }
  const harness = api();
  assert.equal((await harness.route.POST(upload({origin: 'https://evil.test'}))).status, 403);
  assert.deepEqual(harness.calls, []);
});

test('shared JSON rejects malformed headers, scope injection and request sizes before consuming input', async () => {
  const invalidHeaders: Record<string, string>[] = [
    {'x-kts-shared-version': '01'}, {'x-kts-shared-version': '8,9'}, {'x-kts-shared-expected-snapshot': ''},
    {'x-kts-shared-confirm': 'false'}, {'x-kts-shared-filename': '../data.json'}, {'x-kts-shared-filename': '%'},
    {'x-kts-shared-filename': 'data.ktsp'}, {'content-type': 'application/json'}, {'content-encoding': 'gzip'},
    {'content-length': String(SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES + 1)}, {'content-length': '-1'},
  ];
  for (const headers of invalidHeaders) {
    const harness = api();
    const response = await harness.route.POST(upload(headers));
    assert.ok([400, 413].includes(response.status));
    assert.deepEqual(harness.calls, []);
    assert.equal(harness.uploadUsage.length, 0);
  }
  const harness = api();
  assert.equal((await harness.route.POST(upload({}, '?managerId=21'))).status, 400);
  assert.deepEqual(harness.calls, []);
});

test('shared JSON admits transport up to 501 MiB and reports the correct cap before body work', async () => {
  const accepted = api();
  assert.equal((await accepted.route.POST(upload({'content-length': String(SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES)}))).status, 201);
  const rejected = api();
  const response = await rejected.route.POST(upload({'content-length': String(SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES + 1)}));
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /501 МиБ/);
  assert.deepEqual(rejected.calls, []);
});

test('HTML/CAS conflicts and cross-worker contention prevent JSON body inspection', async () => {
  for (const options of [{preflightError: new PersonalDashboardError('STATE_CONFLICT', 'Changed')}, {busy: true}]) {
    const harness = api('admin', options);
    assert.equal((await harness.route.POST(upload())).status, 409);
    assert.equal(harness.calls.some((call) => call.name === 'prepare'), false);
  }
});

test('JSON import preserves committed bytes and returns metadata without file paths', async () => {
  const harness = api('admintop');
  const response = await harness.route.POST(upload());
  assert.equal(response.status, 201);
  assert.equal(harness.uploadUsage.length, 1);
  assert.deepEqual((harness.calls.find(call => call.name === 'import')!.args[0] as {usageActor: unknown}).usageActor, {actorKey: 'admin:7', actorRole: 'admintop'});
  const result = await response.json();
  assert.deepEqual(result.snapshot, harness.snapshot);
  assert.equal('prunedStoragePaths' in result, false);
  assert.match(response.headers.get('cache-control')!, /private.*no-store/);
  assert.deepEqual(harness.calls.map((call) => call.name), ['preflight', 'lock', 'prepare', 'commit', 'import', 'preserve', 'prune', 'discard', 'release']);
  assert.deepEqual(harness.calls.find((call) => call.name === 'import')!.args, [{htmlVersionId: 8, expectedActiveSnapshotId: null,
    originalName: 'маршруты.json', savedAt: harness.snapshot.savedAt, fileSize: 18, sha256: 'a'.repeat(64), storagePath: 'aa/file.bin', actorId: 'admintop:7',
    usageActor: {actorKey: 'admin:7', actorRole: 'admintop'}}]);
});

test('duplicates discard only incoming bytes; known rejection discards; uncertain commit preserves recovery bytes', async () => {
  for (const [options, preserve] of [
    [{duplicate: true}, false], [{importError: new PersonalDashboardError('STATE_CONFLICT', 'Changed')}, false],
    [{importError: new Error('Connection lost during COMMIT')}, true],
  ] as const) {
    const harness = api('admin', options);
    await harness.route.POST(upload());
    assert.equal(harness.calls.some((call) => call.name === 'preserve'), preserve);
    assert.equal(harness.calls.filter((call) => call.name === 'discard').length, 1);
    assert.equal(harness.calls.filter((call) => call.name === 'release').length, 1);
    if ('importError' in options) assert.equal(harness.calls.some((call) => call.name === 'prune'), false);
    assert.equal(harness.uploadUsage.length, 0, 'duplicates and failed saves are not new uploads');
  }
});

test('invalid streamed JSON releases the cross-worker slot before returning the domain error', async () => {
  const harness = api('admin', {prepareError: new PersonalDashboardError('INVALID_JSON_SNAPSHOT', 'Invalid')});
  assert.equal((await harness.route.POST(upload())).status, 400);
  assert.deepEqual(harness.calls.map((call) => call.name), ['preflight', 'lock', 'prepare', 'release']);
});

test('stalled shared uploads report the transport timeout even when the validator wraps the error', async () => {
  let canceled = false;
  const input = new Request(URL_ROOT, {method: 'POST', headers: upload().headers,
    body: new ReadableStream({cancel() { canceled = true; }}), duplex: 'half',
  } as RequestInit & {duplex: 'half'});
  const harness = api('admin', {guardLimits: {idleTimeoutMs: 20, totalTimeoutMs: 2_000},
    prepare: async (request) => {
      try { await request.arrayBuffer(); }
      catch { throw new PersonalDashboardError('INVALID_SNAPSHOT', 'Wrapped parser failure'); }
    }});
  const response = await harness.route.POST(input);
  assert.equal(response.status, 408);
  assert.equal((await response.json()).code, 'IDLE_TIMEOUT');
  assert.equal(canceled, true);
  assert.deepEqual(harness.calls.map((call) => call.name), ['preflight', 'lock', 'prepare', 'release']);
  assert.equal(harness.uploadUsage.length, 0);
});

test('shared uploads reject actual oversize bodies independently of Content-Length and preserve publication', async () => {
  const harness = api('admin', {guardLimits: {maxBytes: 4}, prepare: async (request) => { await request.arrayBuffer(); }});
  const response = await harness.route.POST(upload({'content-length': '1'}));
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'TOO_LARGE');
  assert.deepEqual(harness.calls.map((call) => call.name), ['preflight', 'lock', 'prepare', 'release']);
  assert.equal(harness.uploadUsage.length, 0);
});

test('elapsed validation budget discards prepared bytes before commit and releases the slot once', async () => {
  const harness = api('admin', {guardLimits: {idleTimeoutMs: 2_000, totalTimeoutMs: 20},
    prepare: async () => { await new Promise((resolve) => setTimeout(resolve, 40)); }});
  const response = await harness.route.POST(upload());
  assert.equal(response.status, 408);
  assert.equal((await response.json()).code, 'TOTAL_TIMEOUT');
  assert.deepEqual(harness.calls.map((call) => call.name), ['preflight', 'lock', 'prepare', 'discard', 'release']);
});

test('shared upload keeps its global slot until aborted processing has completed cleanup', async () => {
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
  let observedAbort!: () => void;
  const aborted = new Promise<void>((resolve) => { observedAbort = resolve; });
  const harness = api('admin', {guardLimits: {idleTimeoutMs: 20, totalTimeoutMs: 2_000},
    prepare: async (request) => {
      try { await request.arrayBuffer(); }
      catch (error) { observedAbort(); await cleanup; throw error; }
    }});
  const response = harness.route.POST(new Request(URL_ROOT, {method: 'POST', headers: upload().headers,
    body: new ReadableStream(), duplex: 'half',
  } as RequestInit & {duplex: 'half'}));
  await aborted;
  assert.equal(harness.calls.some((call) => call.name === 'release'), false);
  finishCleanup();
  assert.equal((await response).status, 408);
  assert.equal(harness.calls.filter((call) => call.name === 'release').length, 1);
  assert.equal(harness.calls.some((call) => call.name === 'import'), false);
});

test('deadline during file rename discards owned bytes without changing the active shared snapshot', async () => {
  const harness = api('admin', {guardLimits: {idleTimeoutMs: 2_000, totalTimeoutMs: 20}, commitDelayMs: 40});
  const response = await harness.route.POST(upload());
  assert.equal(response.status, 408);
  assert.equal((await response.json()).code, 'TOTAL_TIMEOUT');
  assert.deepEqual(harness.calls.map((call) => call.name), ['preflight', 'lock', 'prepare', 'commit', 'discard', 'release']);
  assert.equal(harness.uploadUsage.length, 0);
});

test('finished transport budget does not interrupt an already started commit', async () => {
  const harness = api('admin', {guardLimits: {idleTimeoutMs: 2_000, totalTimeoutMs: 20}, importDelayMs: 40});
  const response = await harness.route.POST(upload());
  assert.equal(response.status, 201);
  assert.equal(harness.calls.filter((call) => call.name === 'preserve').length, 1);
  assert.equal(harness.calls.filter((call) => call.name === 'release').length, 1);
});

test('normal JSON GET permits management or explicitly assigned viewers and rejects personal manager selectors', async () => {
  for (const role of ['manager', 'top', 'purchaser', null] as const) {
    const harness = api(role);
    assert.ok([401, 403].includes((await harness.route.GET(new Request(`${URL_ROOT}?version=8`))).status));
    assert.deepEqual(harness.calls, []);
  }
  const denied = api('support_manager', {inactive: true});
  assert.equal((await denied.route.GET(new Request(`${URL_ROOT}?version=8`))).status, 403);
  assert.deepEqual(denied.calls, []);
  for (const query of ['', '?version=8&version=9', '?version=8&managerId=21', '?version=8&snapshot=01']) {
    const harness = api('support_manager');
    assert.equal((await harness.route.GET(new Request(URL_ROOT + query))).status, 400);
    assert.deepEqual(harness.calls, []);
  }
  const harness = api('support_manager');
  const response = await harness.route.GET(new Request(`${URL_ROOT}?version=8&snapshot=9`));
  assert.equal(response.status, 200);
  assert.deepEqual(harness.calls, [{name: 'read', args: [20, 8, 9]}]);
  assert.equal(await response.text(), '{"synthetic":true}');
  assert.match(response.headers.get('cache-control')!, /private.*no-store/);
  assert.equal(response.headers.get('x-kts-shared-version'), '8');
  assert.equal(response.headers.get('x-kts-shared-filename'), encodeURIComponent('маршруты.json'));
  assert.equal(response.headers.get('x-personal-email'), null);
  const purchaser = api('purchaser', {grants: ['route-planner']});
  const buyerResponse = await purchaser.route.GET(new Request(`${URL_ROOT}?version=8&snapshot=9`));
  assert.equal(buyerResponse.status, 200);
  assert.deepEqual(purchaser.calls, [{name: 'read', args: [{adminUserId: 7}, 8, 9]}]);
  const buyerPreview = api('purchaser', {grants: ['route-planner']});
  assert.equal((await buyerPreview.route.GET(new Request(`${URL_ROOT}?version=8&preview=1`))).status, 403);
  assert.deepEqual(buyerPreview.calls, []);
  assert.equal((await buyerPreview.route.POST(upload())).status, 403);
  assert.deepEqual(buyerPreview.calls, []);
  for (const role of ['admin', 'admintop'] as const) {
    const admin = api(role);
    assert.equal((await admin.route.GET(new Request(`${URL_ROOT}?version=8&snapshot=9`))).status, 200);
    assert.deepEqual(admin.calls, [{name: 'read', args: [{adminUserId: 7}, 8, 9]}]);
  }
});

test('JSON preview requires a persisted administrator session and never uses manager reads', async () => {
  for (const [role, options, status] of [[null, {}, 401], ['manager', {}, 403], ['support_manager', {}, 403],
    ['support_manager', {inactive: true}, 403], ['top', {}, 403], ['admin', {sessionId: null}, 403]] as const) {
    const harness = api(role, options);
    assert.equal((await harness.route.GET(new Request(`${URL_ROOT}?version=8&snapshot=9&preview=1`))).status, status);
    assert.deepEqual(harness.calls, []);
  }
  for (const role of ['admin', 'admintop'] as const) {
    const harness = api(role);
    const response = await harness.route.GET(new Request(`${URL_ROOT}?version=8&snapshot=9&preview=1`));
    assert.equal(response.status, 200);
    assert.deepEqual(harness.calls, [{name: 'preview-read', args: [8, 9]}]);
    assert.equal(await response.text(), '{"synthetic":true}');
    assert.match(response.headers.get('cache-control')!, /private.*no-store/);
    assert.equal(response.headers.get('x-kts-shared-version'), '8');
    assert.equal(response.headers.get('x-kts-shared-snapshot'), '9');
    assert.equal(response.headers.get('x-kts-shared-sha256'), 'a'.repeat(64));
  }
});

test('JSON preview validates selectors and reports unavailable or corrupt data without fallback', async () => {
  for (const query of ['?version=8&preview=0', '?version=8&preview=1&preview=1', '?version=8&preview=1&managerId=20',
    '?version=8&preview=1&snapshot=01', '?version=8&preview=1&snapshot=9&snapshot=10']) {
    const harness = api('admin');
    assert.equal((await harness.route.GET(new Request(URL_ROOT + query))).status, 400);
    assert.deepEqual(harness.calls, []);
  }
  for (const [options, status] of [[{missingSnapshot: true}, 404],
    [{readError: new PersonalDashboardError('SNAPSHOT_INTEGRITY', 'Invalid')}, 400]] as const) {
    const harness = api('admin', options);
    const response = await harness.route.GET(new Request(`${URL_ROOT}?version=8&preview=1`));
    assert.equal(response.status, status);
    assert.deepEqual(harness.calls, [{name: 'preview-read', args: [8, undefined]}]);
    assert.match(response.headers.get('cache-control')!, /private.*no-store/);
  }
});
