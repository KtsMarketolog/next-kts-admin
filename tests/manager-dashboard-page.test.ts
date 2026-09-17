import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';

import type { AdminSession } from '../src/shared/lib/adminAuth';
import * as audiences from '../src/shared/lib/managerDashboardAudience';
import * as security from '../src/shared/lib/managerDashboardSecurity';

type Query = { [key: string]: string | string[] | undefined };
type Page = (props: { searchParams: Promise<Query> }) => Promise<{ props: { mode: string; audience: audiences.PersonalDashboardAudience | null } }>;

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
    '@/features/admin/manager-dashboard/ManagerDashboard': { ManagerDashboard: () => null },
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
      assert.deepEqual(result.props, { mode: 'manage', audience: audience ?? null });
    }
    for (const audience of ['', 'invalid', ['support', 'development']]) {
      await assert.rejects(render({ searchParams: Promise.resolve({ audience }) }),
        (error: unknown) => error instanceof PageRedirect && error.location === '/admin/manager-dashboard');
    }
  }
});

test('a manager sees only the role-derived audience, including direct and misleading URL visits', async () => {
  for (const [role, audience, other] of [
    ['manager', 'development', 'support'],
    ['support_manager', 'support', 'development'],
  ] as const) {
    const render = page({ role, managerId: 17, sessionId: 'synthetic-manager-session' });
    for (const requested of [undefined, audience]) {
      const result = await render({ searchParams: Promise.resolve({ audience: requested }) });
      assert.deepEqual(result.props, { mode: 'view', audience });
    }
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
    { role: 'support_manager', managerId: 0, sessionId: 'synthetic' },
    { role: 'wholesale_admin', adminUserId: 3, sessionId: 'synthetic' },
    { role: 'top', adminUserId: 3, sessionId: 'synthetic' },
  ];
  for (const session of sessions) {
    for (const audience of [undefined, 'development', 'support']) {
      await assert.rejects(page(session)({ searchParams: Promise.resolve({ audience }) }),
        (error: unknown) => error instanceof PageRedirect && error.location === '/admin');
    }
  }
});
