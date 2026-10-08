import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import type { AdminSession } from '../src/shared/lib/adminAuth';
import * as access from '../src/shared/lib/dashboardAccess';
import * as pair from '../src/shared/lib/dashboardPair';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';

const origin = 'https://reports.test';
const config: pair.DashboardPairConfig = { keys: ['top:7', 'route-planner'], layout: 'columns', revision: 1 };

function harness(session: AdminSession | null, conflict = false, stored: pair.DashboardPairConfig | null = config, reports = [{id:7,title:'Продажи'}]) {
  const calls: Array<{ type: string; value?: unknown }> = [];
  const modules: Record<string, unknown> = {
    '@/shared/lib/adminAuth': {
      getAdminSession: async () => session,
      requireAdminSession: async () => session?.role === 'admin'
        ? { session, denied: null }
        : { denied: new Response(null, { status: session ? 403 : 401 }) },
    },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => null },
    '@/shared/lib/dashboardAccess': access,
    '@/shared/lib/dashboardPair': pair,
    '@/shared/lib/db/dashboardPairRepo': {
      getDashboardPairConfig: async () => stored,
      saveDashboardPairConfig: async (value: pair.DashboardPairConfig) => {
        calls.push({ type: 'save', value });
        return conflict ? null : { ...value, revision: value.revision + 1 };
      },
    },
    '@/shared/lib/db/topDashboardBlocksRepo': {
      getPublishedTopDashboardBlocks: async () => reports,
      getPublishedTopDashboardBlockOverview: async (id: number) => {
        calls.push({ type: 'top', value: id });
        return { block: { id, title: reports.find((item)=>item.id===id)?.title ?? 'Продажи' }, activeVersionId: 9,
          updatedAt: '2026-10-07T10:00:00Z', dataUploadedAt: '2026-10-07T10:00:00Z', dataAsOf: '2026-10-06' };
      },
    },
    '@/shared/lib/db/supportSharedDashboardRepo': {
      getSupportSharedDashboardOverview: async (viewer: unknown) => {
        calls.push({ type: 'shared', value: viewer });
        return { activeHtmlVersionId: 3, htmlVersions: [{ id: 3, format: 'route-planner-v1' }], jsonSnapshot: { id: 8, htmlVersionId: 3 } };
      },
    },
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async () => calls.push({ type: 'audit' }) },
    '@/shared/lib/originProtection': { enforceSameOriginRequest },
  };
  const code = ts.transpileModule(readFileSync('src/app/api/admin/dashboard-pair/route.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} as { GET(): Promise<Response>; PUT(request: Request): Promise<Response> } };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in modules, name);
    return modules[name];
  }, loaded, loaded.exports);
  return { ...loaded.exports, calls };
}

function put(value: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/admin/dashboard-pair`, {
    method: 'PUT', headers: { origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
}

test('pair checks each report and does not disclose a denied report key, title, or settings', async () => {
  const api = harness({ role: 'purchaser', sessionId: 's', adminUserId: 2, dashboardAccess: ['top:7'] });
  const response = await api.GET();
  assert.equal(response.status, 200);
  const result = await response.json() as pair.DashboardPairOverview;
  assert.equal(result.canConfigure, false);
  assert.equal(result.settings, undefined);
  assert.equal(result.options, undefined);
  assert.equal(result.panels[0].available, true);
  assert.equal(result.panels[0].reportRevision, '2026-10-07T10:00:00Z');
  assert.equal(result.panels[0].dataAsOf, '2026-10-06');
  assert.deepEqual(result.panels[1], {
    key: 'restricted:1', title: 'Отчёт недоступен', available: false,
    message: 'Для этого отчёта администратор должен предоставить доступ.',
  });
  assert.deepEqual(api.calls, [{ type: 'top', value: 7 }]);
  assert.equal((await api.PUT(put(config))).status, 403);
  assert.equal((await harness(null).GET()).status, 401);
});

test('unconfigured pair selects currency and sales office view but does not grant either report', async () => {
  const reports=[{id:4,title:'Аналитика продаж'}];
  const admin=await (await harness({role:'admin',sessionId:'s',adminUserId:1},false,null,reports).GET()).json() as pair.DashboardPairOverview;
  assert.equal(admin.configured,true);
  assert.equal(admin.revision,0);
  assert.deepEqual(admin.settings?.keys,['currency-rates','top:4']);
  assert.deepEqual(admin.settings?.views,['default','sales-office']);
  assert.equal(admin.panels[1].title,'Аналитика продаж — Экран для офиса');
  assert.equal(admin.panels[1].view,'sales-office');
  const viewer=harness({role:'purchaser',sessionId:'s',adminUserId:2,dashboardAccess:['currency-rates']},false,null,reports);
  const result=await (await viewer.GET()).json() as pair.DashboardPairOverview;
  assert.equal(result.panels[0].available,true);
  assert.equal(result.panels[1].available,false);
  assert.equal(result.panels[1].view,undefined);
  assert.deepEqual(viewer.calls,[]);
});

test('shared pair uses a verified viewer identity, while full admins use management overview', async () => {
  for (const role of ['admin', 'admintop', 'manager', 'support_manager', 'purchaser'] as const) {
    const session: AdminSession = { role, sessionId: 's', adminUserId: 2, managerId: 4, dashboardAccess: ['route-planner'] };
    const api = harness(session);
    const response = await api.GET();
    assert.equal(response.status, 200);
    const result = await response.json() as pair.DashboardPairOverview;
    assert.equal(result.panels[1].available, true);
    assert.equal(result.panels[1].snapshotId, 8);
    assert.deepEqual(api.calls.find((call) => call.type === 'shared')?.value,
      role === 'admin' || role === 'admintop' ? undefined : access.getSharedDashboardViewer(session));
    assert.equal(result.canConfigure, role === 'admin');
    if (role !== 'admin') assert.equal((await api.PUT(put(config))).status, 403);
  }
});

test('pair writes enforce admin, same origin, valid fixed reports, size limit, and revision conflicts', async () => {
  const api = harness({ role: 'admin', sessionId: 's', adminUserId: 1 });
  assert.equal((await api.PUT(put(config, 'https://evil.test'))).status, 403);
  for (const keys of [['top:7', 'top:7'], ['manager:support', 'currency-rates'], ['https://evil.test', 'top:7']]) {
    assert.equal((await api.PUT(put({ ...config, keys }))).status, 400);
  }
  assert.equal((await api.PUT(put({ ...config, keys: ['top:8', 'currency-rates'] }))).status, 409);
  assert.equal((await api.PUT(put({ ...config, padding: 'x'.repeat(2048) }))).status, 413);
  assert.equal(api.calls.length, 0);
  const response = await api.PUT(put(config));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, revision: 2 });
  assert.deepEqual(api.calls.map((call) => call.type), ['save', 'audit']);
  const stale = harness({ role: 'admin', sessionId: 's', adminUserId: 1 }, true);
  assert.equal((await stale.PUT(put(config))).status, 409);
  assert.deepEqual(stale.calls.map((call) => call.type), ['save']);
});
