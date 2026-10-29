import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import { isTopDashboardManagementSession, isTopDashboardSession, type AdminSession } from '../src/shared/lib/adminAuth';
import { canReadTopDashboardBlock } from '../src/shared/lib/dashboardAccess';
import { detectTopDashboardDataContract } from '../src/shared/lib/topDashboardContentSecurity';
import { resolveTopDashboardInstructionKind } from '../src/shared/lib/dashboardInstructionProfile';

const salesHtml = `<html><script>const DASH_NAME='аналитика_продаж';</script></html>`;
const profitabilityHtml = '<!doctype html><title>Рентабельность сделок V25</title><script>const format = "kts-rent-snapshot"; function parseInvoiceFile(file) { return file; }</script>';
const viewer: AdminSession = { role: 'purchaser', adminUserId: 41, sessionId: 'synthetic-viewer', dashboardAccess: ['top:7'] };
const administrator: AdminSession = { role: 'admin', sessionId: 'synthetic-admin' };

type Fixture = {
  title?: string;
  html?: string | null;
  activeVersionId?: number | null;
  available?: boolean;
};

/** Execute the actual overview route with real auth/profile predicates and inert repository IO. */
function overviewRoute(session: AdminSession | null, fixture: Fixture = {}) {
  const calls: string[] = [];
  const overview = {
    block: { id: 7, title: fixture.title ?? 'Переименованный отчёт', createdAt: '2026-10-13T08:00:00Z' },
    activeVersionId: fixture.activeVersionId === undefined ? 19 : fixture.activeVersionId,
  };
  const loadOverview = (mode: string, blockId: number) => {
    calls.push(`${mode}:${blockId}`);
    return fixture.available === false ? null : overview;
  };
  const modules: Record<string, unknown> = {
    '@/shared/lib/adminAuth': {
      isTopDashboardManagementSession,
      async requireTopDashboardSession() {
        return isTopDashboardSession(session) ? { session, denied: null }
          : { denied: new Response('Нет доступа', { status: session ? 403 : 401 }) };
      },
    },
    '@/shared/lib/dashboardAccess': { canReadTopDashboardBlock },
    '@/shared/lib/db': {
      async getPublishedTopDashboardBlockOverview(blockId: number) { return loadOverview('published', blockId); },
      async getTopDashboardBlockOverview(blockId: number) { return loadOverview('management', blockId); },
      async getTopDashboardBlockVersionContent(blockId: number, versionId: number) {
        calls.push(`html:${blockId}:${versionId}`);
        return fixture.html === null ? null : { htmlContent: fixture.html ?? salesHtml };
      },
      TopDashboardBlockNotFoundError: class extends Error {},
    },
    '@/shared/lib/topDashboardContentSecurity': { detectTopDashboardDataContract },
    '@/shared/lib/dashboardInstructionProfile': { resolveTopDashboardInstructionKind },
    '@/shared/lib/topDashboardUploadTargets': { detectTopDashboardUploadTargets: () => [] },
    '@/shared/lib/adminSecurity': {},
    '@/shared/lib/db/securityAuditRepo': {},
    '@/shared/lib/originProtection': {},
    '@/shared/lib/rateLimit': {},
    '@/shared/lib/topDashboardDataStorage': {},
    '../routeUtils': {
      parsePositiveId(value: string) {
        return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
      },
    },
  };
  const code = ts.transpileModule(readFileSync(new URL('../src/app/api/admin/top-dashboard/blocks/[blockId]/route.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} as { GET: (request: Request, context: { params: Promise<{ blockId: string }> }) => Promise<Response> } };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, testModule, testModule.exports);
  return {
    calls,
    get: (blockId = '7') => testModule.exports.GET(new Request(`https://example.test/api/admin/top-dashboard/blocks/${blockId}`), {
      params: Promise.resolve({ blockId }),
    }),
  };
}

test('viewer and management overview identify the sales instruction from active HTML, not its mutable title', async () => {
  for (const session of [viewer, administrator]) {
    const route = overviewRoute(session);
    const response = await route.get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    const body = await response.json();
    assert.equal(body.instruction, 'sales-analytics');
    assert.equal(body.block.title, 'Переименованный отчёт');
    assert.equal('activeDataContract' in body, session === administrator);
    assert.equal('htmlContent' in body, false);
    assert.doesNotMatch(JSON.stringify(body), /DASH_NAME/);
    assert.deepEqual(route.calls, [session === administrator ? 'management:7' : 'published:7', 'html:7:19']);
  }
});

test('profitability instructions follow published invoice HTML independently of mutable block titles and legacy versions', async () => {
  for (const session of [viewer, administrator]) {
    for (const html of [profitabilityHtml, profitabilityHtml.replace('Рентабельность сделок V25', 'Рентабельность счетов V24.4')]) {
      const route = overviewRoute(session, { title: 'Другой заголовок раздела', html });
      const response = await route.get();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      const body = await response.json();
      assert.equal(body.instruction, 'deal-profitability');
      assert.equal('activeDataContract' in body, session === administrator);
      assert.equal('htmlContent' in body, false);
      assert.doesNotMatch(JSON.stringify(body), /parseInvoiceFile/);
      assert.deepEqual(route.calls, [session === administrator ? 'management:7' : 'published:7', 'html:7:19']);
    }
  }
});

test('a manual title, unavailable HTML, incomplete/mixed signatures or unrelated profile never adds an instruction', async () => {
  for (const session of [viewer, administrator]) {
    for (const fixture of [
      { html: `<script>const DASH_NAME='оптимизация_ассортимента';</script>` },
      { html: '<html><body>Обычный отчёт</body></html>' },
      { html: '<html><title>Рентабельность сделок V25</title></html>' },
      { html: '<title>Рентабельность сделок</title><script>const format="kts-rent-snapshot";</script>' },
      { html: salesHtml + profitabilityHtml },
      { html: null },
      { activeVersionId: null },
    ]) {
      const route = overviewRoute(session, { title: 'Аналитика продаж', ...fixture });
      const response = await route.get();
      assert.equal(response.status, 200);
      assert.equal((await response.json()).instruction, null);
      assert.equal(route.calls.filter((call) => call.startsWith('html:')).length, 'activeVersionId' in fixture ? 0 : 1);
    }
  }
});

test('overview instruction metadata does not bypass login or exact-report permissions', async () => {
  for (const [session, expected] of [
    [null, 401],
    [{ ...viewer, sessionId: undefined }, 403],
    [{ ...viewer, dashboardAccess: [] }, 403],
    [{ ...viewer, dashboardAccess: ['top:8'] }, 403],
  ] as const) {
    const route = overviewRoute(session as AdminSession | null);
    assert.equal((await route.get()).status, expected);
    assert.deepEqual(route.calls, [], 'denied requests must not read report metadata or HTML');
  }
});

test('missing or unpublished report and malformed IDs never reach HTML classification', async () => {
  const missing = overviewRoute(viewer, { available: false });
  assert.equal((await missing.get()).status, 404);
  assert.deepEqual(missing.calls, ['published:7']);
  for (const id of ['0', '07', '../7', '9007199254740992']) {
    const invalid = overviewRoute(administrator);
    assert.equal((await invalid.get(id)).status, 400);
    assert.deepEqual(invalid.calls, []);
  }
});
