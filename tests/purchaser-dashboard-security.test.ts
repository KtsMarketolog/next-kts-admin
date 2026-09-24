import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import { type AdminSession, isTopDashboardManagementSession, isTopDashboardSession } from '../src/shared/lib/adminAuth';
import * as access from '../src/shared/lib/dashboardAccess';
import * as security from '../src/shared/lib/topDashboardContentSecurity';
import { parsePositiveId } from '../src/app/api/admin/top-dashboard/blocks/routeUtils';

const purchaser = (keys: string[] = []): AdminSession => ({
  role: 'purchaser', adminUserId: 42, sessionId: 'synthetic-session', dashboardAccess: keys,
});
const routeRoot = 'src/app/api/admin/top-dashboard/blocks';
const readSurfaces = ['[blockId]/route.ts', '[blockId]/data/route.ts',
  '[blockId]/versions/[versionId]/frame/route.ts', '[blockId]/versions/[versionId]/content/route.ts'];

test('dashboard grants accept only canonical, exact report keys without wildcards or coercion', () => {
  assert.deepEqual(access.parseDashboardAccess(['top:7', 'route-planner', 'top:7']), ['route-planner', 'top:7']);
  assert.deepEqual(access.parseDashboardAccess([]), []);
  for (const value of [null, undefined, '*', {}, [7], ['*'], ['top:*'], ['top:0'], ['top:-1'], ['top:01'],
    ['top:1.5'], ['top:1e2'], ['top:9007199254740992'], ['top:7 '], ['route-planner/'], ['manager:all'],
    ['manager:development'], ['manager:support'], ['top:7', 'manager:support']]) {
    assert.equal(access.parseDashboardAccess(value), null, JSON.stringify(value));
  }
});

test('purchaser helpers require a persisted identity and exact grants, never management capability', () => {
  const session = purchaser(['top:7', 'route-planner', 'manager:support']);
  assert.equal(access.hasPurchaserDashboardAccess(session, 'top:7'), true);
  assert.equal(access.canReadTopDashboardBlock(session, 7), true);
  assert.equal(access.canReadTopDashboardBlock(session, 8), false);
  assert.equal(access.canAccessReportsCatalog(purchaser()), true, 'empty account can see its empty reports catalog');
  assert.equal(access.canAccessRoutePlanner(session), true);
  assert.deepEqual(access.getReportEntries(session).map(({key}) => key), ['route-planner']);
  for (const key of ['manager:development', 'manager:support']) {
    assert.equal(access.hasPurchaserDashboardAccess(purchaser([key]), key), false, 'tampered personal grants cannot authorize purchasers');
    assert.deepEqual(access.getReportEntries(purchaser([key])), []);
  }
  assert.deepEqual(access.PURCHASER_DASHBOARD_REPORT_OPTIONS.map(({ key }) => key), ['route-planner']);
  assert.deepEqual(access.getReportEntries({ role: 'manager', managerId: 1, sessionId: 'manager' }).map(({ key }) => key), ['manager:development']);
  assert.deepEqual(access.getReportEntries({ role: 'support_manager', managerId: 1, sessionId: 'support' }).map(({ key }) => key), ['manager:support', 'route-planner']);
  assert.deepEqual(access.getReportEntries(purchaser()), []);
  assert.equal(isTopDashboardManagementSession({ ...session, canManageTopDashboard: true }), false);
  for (const invalid of [{ ...session, sessionId: undefined }, { ...session, adminUserId: undefined },
    { ...session, adminUserId: 0 }, { ...session, adminUserId: -1 }, { ...session, adminUserId: 1.5 },
    { ...session, adminUserId: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(access.hasPurchaserDashboardAccess(invalid, 'top:7'), false);
    assert.equal(access.canAccessReportsCatalog(invalid), false);
    assert.equal(access.canAccessRoutePlanner(invalid), false);
    assert.deepEqual(access.getReportEntries(invalid), []);
  }
  assert.equal(access.canAccessRoutePlanner({ role: 'top', adminUserId: 1, sessionId: 'top' }), false);
  assert.equal(access.canAccessRoutePlanner({ role: 'manager', managerId: 1, sessionId: 'manager' }), false);
  assert.equal(access.canAccessRoutePlanner({ role: 'support_manager', managerId: 1, sessionId: 'support' }), true);
});

/** Executes the actual route exports with inert DB/storage; auth predicates and frame checks are real. */
function harness(relative: string, session: AdminSession | null, published = true) {
  const calls: string[] = [];
  const getPublished = (blockId: number) => {
    calls.push(`published:${blockId}`);
    return published ? { id: blockId, title: 'Synthetic', activeVersionId: 19 } : null;
  };
  const infrastructure = new Proxy({}, { get: (_target, name) => () => {
    calls.push(`unexpected:${String(name)}`);
    throw new Error(`Unexpected infrastructure access ${String(name)}`);
  } });
  const db = {
    async getPublishedTopDashboardBlocks() { calls.push('published-list'); return [{ id: 7 }, { id: 8 }]; },
    async getPublishedTopDashboardBlockOverview(id: number) { return getPublished(id); },
    async isPublishedTopDashboardBlockVersion(id: number, version: number) {
      calls.push(`published-version:${id}:${version}`); return published && version === 19;
    },
    async getPublishedTopDashboardBlockVersionContent(id: number, version: number) {
      calls.push(`published-content:${id}:${version}`);
      return published && version === 19 ? { htmlContent: '<!doctype html><html><body>Synthetic report</body></html>' } : null;
    },
    async getActiveTopDashboardBlockDataContent(id: number, version: number) {
      calls.push(`data:${id}:${version}`);
      return { id: 70, originalName: 'synthetic.json', storagePath: 'synthetic-only', fileSize: 2, sha256: 'a'.repeat(64), snapshotFormat: 'kts-bundle-v1' };
    },
  };
  const dependencies: Record<string, unknown> = {
    'node:stream': { Readable },
    '@/shared/lib/dashboardAccess': access,
    '@/shared/lib/adminAuth': {
      isTopDashboardManagementSession,
      async requireTopDashboardSession() {
        return isTopDashboardSession(session) ? { denied: null, session }
          : { denied: new Response('Unauthorized', { status: session ? 403 : 401 }), session: null };
      },
      async requireTopDashboardManagementSession() {
        return isTopDashboardManagementSession(session) ? { denied: null, session }
          : { denied: new Response('Forbidden', { status: session ? 403 : 401 }), session: null };
      },
    },
    '@/shared/lib/db': new Proxy(db, { get: (target, name) => name in target ? target[name as keyof typeof target] : (infrastructure as Record<string, unknown>)[String(name)] }),
    '@/shared/lib/adminSecurity': infrastructure,
    '@/shared/lib/db/securityAuditRepo': infrastructure,
    '@/shared/lib/originProtection': infrastructure,
    '@/shared/lib/rateLimit': infrastructure,
    '@/shared/lib/topDashboardUploadConcurrency': infrastructure,
    '@/shared/lib/topDashboardUploadTargets': infrastructure,
    '@/shared/lib/topDashboardDataStorage': {
      async openTopDashboardDataFile() { calls.push('storage'); return Readable.from([Buffer.from('{}')]); },
    },
    '@/shared/lib/topDashboardContentSecurity': {
      ...security,
      injectTopDashboardDataAdapter(html: string, options: {readOnly: boolean}) {
        calls.push(`adapter-readonly:${options.readOnly}`);
        return security.injectTopDashboardDataAdapter(html, options);
      },
      createTopDashboardFrameBridgeScript(id: number, version: number, writable: boolean) {
        calls.push(`bridge-writable:${writable}`);
        return security.createTopDashboardFrameBridgeScript(id, version, writable);
      },
    },
  };
  const source = readFileSync(path.join(process.cwd(), routeRoot, relative), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: Record<string, (request: Request, context: {params: Promise<{blockId: string; versionId: string}>}) => Promise<Response>> = {};
  runInNewContext(compiled, { exports, Response, Buffer, URL, console, require(name: string) {
    if (/^(?:\.\.\/)+routeUtils$/.test(name)) return { parsePositiveId };
    if (/^(?:\.\.\/)+(?:dataUpload|multiFileDataUpload|streamDataUpload)$/.test(name)) return infrastructure;
    assert.ok(name in dependencies, `Unexpected import ${name}`);
    return dependencies[name];
  } });
  return { calls, async request(method = 'GET', blockId = '7', versionId = '19', trusted = true) {
    const data = relative === '[blockId]/data/route.ts';
    const headers: Record<string, string> = trusted ? { 'sec-fetch-dest': data ? 'empty' : 'iframe', 'sec-fetch-mode': data ? 'cors' : 'navigate',
      'sec-fetch-site': 'same-origin', referer: `https://kts-impex.ru/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/frame` } : {};
    return exports[method]!(new Request('https://kts-impex.ru/api/admin/top-dashboard/blocks/7', { method, headers }),
      { params: Promise.resolve({ blockId, versionId }) });
  } };
}

test('TOP collection reveals only assigned published dashboards, including an empty selection', async () => {
  for (const [grants, expected] of [[[], []], [['top:7'], [7]], [['top:7', 'top:8'], [7, 8]]] as const) {
    const route = harness('route.ts', purchaser([...grants]));
    const response = await route.request();
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).blocks.map((row: {id: number}) => row.id), expected);
    assert.deepEqual(route.calls, ['published-list']);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  }
});

for (const relative of readSurfaces) {
  test(`purchaser denied before repository/storage reads: ${relative}`, async () => {
    for (const session of [purchaser(), purchaser(['top:8']), purchaser(['manager:support', 'route-planner'])]) {
      const route = harness(relative, session);
      const response = await route.request();
      assert.equal(response.status, 403);
      assert.deepEqual(route.calls, []);
    }
    const anonymous = harness(relative, null);
    assert.equal((await anonymous.request()).status, 401);
    assert.deepEqual(anonymous.calls, []);
  });

  test(`assigned purchaser retains published-only read access: ${relative}`, async () => {
    const route = harness(relative, purchaser(['top:7']));
    const response = await route.request();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.ok(route.calls.some((call) => call.startsWith('published')));
    assert.equal(route.calls.some((call) => call.startsWith('unexpected:')), false);
    if (relative.endsWith('/content/route.ts')) assert.ok(route.calls.includes('adapter-readonly:true'));
    if (relative.endsWith('/frame/route.ts')) assert.ok(route.calls.includes('bridge-writable:false'));
    if (relative === '[blockId]/data/route.ts') assert.equal(await response.text(), '{}');
    const unpublished = harness(relative, purchaser(['top:7']), false);
    assert.equal((await unpublished.request()).status, 404);
    assert.equal(unpublished.calls.includes('storage'), false);
    assert.equal(unpublished.calls.some((call) => call.startsWith('data:')), false);
  });
}

test('assigned grants do not bypass trusted iframe, current-version or cross-block checks', async () => {
  for (const relative of ['[blockId]/data/route.ts', '[blockId]/versions/[versionId]/content/route.ts']) {
    const route = harness(relative, purchaser(['top:7']));
    assert.equal((await route.request('GET', '7', '19', false)).status, 403);
    assert.deepEqual(route.calls, []);
    const oldVersion = harness(relative, purchaser(['top:7']));
    assert.equal((await oldVersion.request('GET', '7', '18')).status, 404);
    assert.equal(oldVersion.calls.includes('storage'), false);
  }
  const frame = harness('[blockId]/versions/[versionId]/frame/route.ts', purchaser(['top:7']));
  assert.equal((await frame.request('GET', '7', '18')).status, 404);
  for (const relative of readSurfaces) {
    const other = harness(relative, purchaser(['top:7']));
    assert.equal((await other.request('GET', '8')).status, 403);
    assert.deepEqual(other.calls, []);
  }
});

test('all TOP mutation methods reject even a fully assigned purchaser before reading infrastructure', async () => {
  const mutations = [['route.ts', 'POST'], ['[blockId]/route.ts', 'PATCH'], ['[blockId]/route.ts', 'DELETE'],
    ['[blockId]/active/route.ts', 'PUT'], ['[blockId]/data/route.ts', 'PUT'], ['[blockId]/data/active/route.ts', 'PUT'],
    ['[blockId]/versions/route.ts', 'POST'], ['[blockId]/versions/[versionId]/route.ts', 'DELETE']];
  for (const [relative, method] of mutations) {
    const route = harness(relative!, { ...purchaser(['top:7', 'route-planner', 'manager:development', 'manager:support']), canManageTopDashboard: true });
    assert.equal((await route.request(method)).status, 403, `${method} ${relative}`);
    assert.deepEqual(route.calls, [], `${method} ${relative}`);
  }
});
