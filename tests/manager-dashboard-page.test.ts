import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';

import type { AdminSession } from '../src/shared/lib/adminAuth';
import * as audiences from '../src/shared/lib/managerDashboardAudience';
import * as security from '../src/shared/lib/managerDashboardSecurity';
import * as permissions from '../src/shared/lib/dashboardPermissions';

type Query = { [key: string]: string | string[] | undefined };
type Page = (props: { searchParams: Promise<Query> }) => Promise<{ type: unknown; props: { mode?: string; audience?: audiences.PersonalDashboardAudience | null; own?: boolean; ownReturn?: string; canViewOwn?: boolean } }>;

const managementComponent = () => null;
const reviewComponent = () => null;

class PageRedirect extends Error {
  constructor(public location: string) { super(location); }
}

// Run the real page and access guard with synthetic sessions, no database or network.
function page(session: AdminSession | null): Page {
  const modules: Record<string, unknown> = {
    'react/jsx-runtime': jsx,
    'next/navigation': { redirect: (location: string) => { throw new PageRedirect(location); } },
    '@/shared/lib/adminAuth': { getAdminSession: async () => session },
    '@/shared/lib/managerDashboardAudience': audiences,
    '@/shared/lib/managerDashboardSecurity': security,
    '@/shared/lib/dashboardPermissions': permissions,
    '@/features/admin/manager-dashboard/ManagerDashboard': { ManagerDashboard: managementComponent },
    '@/features/admin/manager-dashboard/ManagerDashboardReview': { ManagerDashboardReview: reviewComponent },
  };
  const code = ts.transpileModule(readFileSync(new URL('../src/app/admin/manager-dashboard/page.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const testModule = { exports: {} as { default: Page } };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, testModule, testModule.exports);
  return testModule.exports.default;
}

test('administrator cards select MR/MS while the legacy URL retains the combined management view', async () => {
  for (const role of ['admin', 'admintop'] as const) {
    const render = page({ role, adminUserId: 3, sessionId: 'synthetic-admin-session' });
    for (const audience of ['development', 'support', undefined] as const) {
      const result = await render({ searchParams: Promise.resolve({ audience }) });
      assert.deepEqual(result.props, { mode: 'manage', audience: audience ?? null,canAssignAccess:true, canViewOwn:true });
    }
    for (const audience of ['', 'invalid', ['support', 'development']]) {
      await assert.rejects(render({ searchParams: Promise.resolve({ audience }) }),
        (error: unknown) => error instanceof PageRedirect && error.location === '/admin/manager-dashboard');
    }
  }
});

test('TOP defaults to their own MR report and explicitly switches to the existing separate team reader', async () => {
  const render = page({ role: 'top', adminUserId: 3, sessionId: 'synthetic-top-session', dashboardAccess: [] });
  for (const audience of [undefined, 'development']) {
    for (const view of [undefined, 'personal', 'manage', ['personal', 'team']]) {
      const result = await render({ searchParams: Promise.resolve({ audience, view, mode: 'manage', preview: '1' }) });
      assert.equal(result.type, managementComponent);
      assert.deepEqual(result.props, { mode:'view', audience:'development', own:true, ownReturn:'team' });
    }
    const result = await render({ searchParams: Promise.resolve({ audience, view:'team' }) });
    assert.equal(result.type, reviewComponent);
    assert.deepEqual(result.props, { canViewOwn:true });
  }
  for (const audience of ['support', 'invalid', '', ['development', 'support'], ['development', 'development']]) {
    await assert.rejects(render({ searchParams: Promise.resolve({ audience }) }),
      (error: unknown) => error instanceof PageRedirect && error.location === '/admin/manager-dashboard?view=personal&audience=development');
    await assert.rejects(render({ searchParams: Promise.resolve({ audience, view:'team' }) }),
      (error: unknown) => error instanceof PageRedirect && error.location === '/admin/manager-dashboard?audience=development');
  }
});

test('persisted administrators opt into their own MR snapshot without changing their default management view', async () => {
  for (const role of ['admin', 'admintop'] as const) {
    const render = page({ role, adminUserId:3, sessionId:'synthetic-admin-session' });
    const own = await render({ searchParams:Promise.resolve({ view:'personal', audience:'development' }) });
    assert.deepEqual(own.props, { mode:'view', audience:'development', own:true, ownReturn:'manage' });
    await assert.rejects(render({ searchParams:Promise.resolve({ view:'personal', audience:'support' }) }),
      (error: unknown) => error instanceof PageRedirect && error.location === '/admin/manager-dashboard?view=personal&audience=development');
  }
  const environmental = await page({ role:'admin', sessionId:'synthetic-environment-session' })({ searchParams:Promise.resolve({ view:'personal' }) });
  assert.deepEqual(environmental.props, { mode:'manage', audience:null, canAssignAccess:true, canViewOwn:false });
});

test('a manager sees only the role-derived audience, including direct and misleading URL visits', async () => {
  for (const [role, audience, other] of [
    ['manager', 'development', 'support'],
    ['support_manager', 'support', 'development'],
  ] as const) {
    const render = page({ role, managerId: 17, sessionId: 'synthetic-manager-session',dashboardAccess:[`manager:${audience}`] });
    for (const requested of [undefined, audience]) {
      const result = await render({ searchParams: Promise.resolve({ audience: requested }) });
      assert.deepEqual(result.props, { mode: 'view', audience,canAssignAccess:false, canViewOwn:false });
    }
    const ownQuery = await render({ searchParams: Promise.resolve({ audience, view:'personal' }) });
    assert.equal(ownQuery.props.own, undefined, 'query parameters never select the administrator owner API for managers');
    for (const requested of [other, 'invalid', '', [audience, other]]) {
      await assert.rejects(render({ searchParams: Promise.resolve({ audience: requested }) }),
        (error: unknown) => error instanceof PageRedirect && error.location === `/admin/manager-dashboard?audience=${audience}`);
    }
  }
});

test('query parameters never grant dashboard access to missing or unauthorized sessions', async () => {
  const sessions: Array<AdminSession | null> = [
    null,
    { role: 'admin' },
    { role: 'admintop', sessionId: 'synthetic' },
    { role: 'manager', sessionId: 'synthetic' },
    { role: 'manager', managerId:17, sessionId: 'synthetic', dashboardAccess:[] },
    { role: 'support_manager', managerId: 0, sessionId: 'synthetic' },
    { role: 'wholesale_admin', adminUserId: 3, sessionId: 'synthetic' },
    { role: 'top', adminUserId: 3 },
    { role: 'top', adminUserId: 0, sessionId: 'synthetic' },
    { role: 'top', managerId: 3, sessionId: 'synthetic' },
    { role: 'purchaser', adminUserId: 3, sessionId: 'synthetic', dashboardAccess: ['route-planner', 'top:7'] },
    { role: 'purchaser', adminUserId: 3, sessionId: 'synthetic', dashboardAccess: ['manager:development', 'manager:support'] },
  ];
  for (const session of sessions) {
    for (const audience of [undefined, 'development', 'support']) {
      await assert.rejects(page(session)({ searchParams: Promise.resolve({ audience }) }),
        (error: unknown) => error instanceof PageRedirect && error.location === '/admin');
    }
  }
});
