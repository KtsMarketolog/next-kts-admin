import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as security from '../src/shared/lib/managerDashboardSecurity';

type ViewerRole = 'manager' | 'support_manager';
type SessionRole = 'admin' | ViewerRole;
type Audience = 'development' | 'support';
type HtmlCall = { id: number | undefined; preview: boolean; audience: Audience };
type GetRoute = { GET: (request: Request) => Promise<Response> };

function compile<T>(filename: string, modules: Record<string, unknown>): T {
  const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} as T };
  new Function('require', 'module', 'exports', 'console', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, testModule, testModule.exports, { error: () => {} });
  return testModule.exports;
}

/** Execute the real shared guard and both real route handlers; only session/DB IO and HTML rendering are injected. */
function routes(sessionRole: SessionRole, managerRole: ViewerRole = sessionRole === 'admin' ? 'manager' : sessionRole) {
  const manager = sessionRole === 'admin' ? null : {
    id: 71,
    name: 'Synthetic Manager',
    login: 'synthetic',
    email: 'manager@example.test',
    phone: '',
    role: managerRole,
    canAccessTopDashboard: false,
    canManageTopDashboard: false,
    isActive: true,
  };
  const session = sessionRole === 'admin'
    ? { role: 'admin' as const, sessionId: 'admin-session' }
    : { role: sessionRole, managerId: manager!.id, sessionId: 'manager-session' };
  const origin = { enforceSameOriginRequest: () => null };
  const shared = compile<typeof import('../src/app/api/admin/manager-dashboard/_shared')>(
    '../src/app/api/admin/manager-dashboard/_shared.ts',
    {
      '@/shared/lib/adminAuth': { getAdminSession: async () => session },
      '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => null },
      '@/shared/lib/db/wholesaleAdminRepo/managerRepo': { getWholesaleManagerById: async () => manager },
      '@/shared/lib/managerDashboardSecurity': security,
      '@/shared/lib/originProtection': origin,
    },
  );

  const htmlCalls: HtmlCall[] = [];
  const versions = new Map<number, Audience>([[11, 'development'], [22, 'support']]);
  const repository = {
    getPersonalDashboardStatus: async () => ({
      audience: managerRole === 'support_manager' ? 'support' as const : 'development' as const,
      bindingStatus: 'matched' as const,
      snapshot: null,
      history: [],
    }),
    getPersonalDashboardHtml: async (id: number | undefined, preview: boolean, audience: Audience) => {
      htmlCalls.push({ id, preview, audience });
      if (!id || versions.get(id) !== audience) return null;
      return { id, audience, htmlContent: `<html data-audience="${audience}"></html>` };
    },
  };
  const html = {
    buildPersonalDashboardFrame: (input: unknown) => ({ html: JSON.stringify(input), csp: "default-src 'none'" }),
    injectPersonalDashboardAdapter: (value: string) => `${value}<!-- injected -->`,
    personalHtmlCsp: () => "default-src 'none'",
  };
  const common = {
    '@/shared/lib/db/managerDashboardRepo': repository,
    '@/shared/lib/managerDashboardHtml': html,
    '@/shared/lib/managerDashboardSecurity': security,
    '@/shared/lib/originProtection': origin,
    '../_shared': shared,
  };
  return {
    frame: compile<GetRoute>('../src/app/api/admin/manager-dashboard/frame/route.ts', common),
    content: compile<GetRoute>('../src/app/api/admin/manager-dashboard/content/route.ts', common),
    htmlCalls,
  };
}

function request(path: string, referer?: string) {
  const headers = referer ? { referer: `https://example.test${referer}` } : undefined;
  return new Request(`https://example.test${path}`, { headers });
}

test('manager frame and content routes reject the other HTML audience before reading a version', async () => {
  for (const [role, own, other] of [
    ['manager', 'development', 'support'],
    ['support_manager', 'support', 'development'],
  ] as const) {
    const api = routes(role);
    const framePath = `/api/admin/manager-dashboard/frame?version=${other === 'support' ? 22 : 11}&audience=${other}`;
    const frame = await api.frame.GET(request(framePath));
    assert.equal(frame.status, 403, `${role} must not read ${other} frame`);
    const contentPath = `/api/admin/manager-dashboard/content?version=${other === 'support' ? 22 : 11}&audience=${other}`;
    const content = await api.content.GET(request(contentPath, framePath));
    assert.equal(content.status, 403, `${role} must not read ${other} content`);
    assert.deepEqual(api.htmlCalls, [], `${role}/${own}: rejected requests must not reach HTML storage`);
  }
});

test('an administrator previews only the version belonging to the explicitly selected audience', async () => {
  const api = routes('admin');
  const supportFrame = '/api/admin/manager-dashboard/frame?version=22&audience=support&preview=1';
  const frame = await api.frame.GET(request(supportFrame));
  assert.equal(frame.status, 200);
  assert.deepEqual(JSON.parse(await frame.text()), { versionId: 22, preview: true, audience: 'support' });
  const content = await api.content.GET(request(
    '/api/admin/manager-dashboard/content?version=22&audience=support&preview=1',
    supportFrame,
  ));
  assert.equal(content.status, 200);
  assert.match(await content.text(), /data-audience="support"/);
  assert.deepEqual(api.htmlCalls, [
    { id: 22, preview: true, audience: 'support' },
    { id: 22, preview: true, audience: 'support' },
  ]);

  const wrongGroup = await api.frame.GET(request(
    '/api/admin/manager-dashboard/frame?version=11&audience=support&preview=1',
  ));
  assert.equal(wrongGroup.status, 404, 'a development version cannot be previewed through support state');
});

test('frame and content reject duplicate audience query parameters without choosing either value', async () => {
  const api = routes('admin');
  const framePath = '/api/admin/manager-dashboard/frame?version=22&audience=support&audience=support&preview=1';
  assert.equal((await api.frame.GET(request(framePath))).status, 403);
  const contentPath = '/api/admin/manager-dashboard/content?version=22&audience=support&audience=support&preview=1';
  assert.equal((await api.content.GET(request(contentPath, framePath))).status, 403);
  assert.deepEqual(api.htmlCalls, []);
});

test('a persisted manager session cannot follow an account across a role/audience change', async () => {
  const stale = routes('manager', 'support_manager');
  const response = await stale.frame.GET(request(
    '/api/admin/manager-dashboard/frame?version=22&audience=support',
  ));
  assert.equal(response.status, 403);
  assert.deepEqual(stale.htmlCalls, []);
});
