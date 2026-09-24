import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';

import * as access from '../src/shared/lib/dashboardAccess';
import type { AdminSession } from '../src/shared/lib/adminAuth';
import * as security from '../src/shared/lib/managerDashboardSecurity';

function compile<T>(file: string, modules: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX},
  }).outputText;
  const compiledModule = {exports: {} as T};
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, compiledModule, compiledModule.exports, ...Object.values(globals));
  return compiledModule.exports;
}

type Element = {type: unknown; props: Record<string, unknown>};
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Element;
  return [node, ...elements(node.props.children)];
}

test('reports catalog renders authorized static sections and does not fetch TOP blocks without permission', async () => {
  for (const canReadTopBlocks of [false, true]) {
    const effects: Array<() => unknown> = [];
    const requests: string[] = [];
    const Link = () => null;
    const {AdminTopDashboardCatalog} = compile<typeof import('../src/features/admin/top-dashboard/AdminTopDashboardCatalog')>(
      '../src/features/admin/top-dashboard/AdminTopDashboardCatalog.tsx', {
        'react/jsx-runtime': jsx,
        react: {
          useRef: (current: unknown) => ({current}),
          useState: (value: unknown) => [value, () => {}],
          useEffect: (effect: () => unknown) => { effects.push(effect); },
          useCallback: (callback: unknown) => callback,
        },
        'next/link': {default: Link}, 'next/navigation': {useRouter: () => ({})},
        '@/app/admin/admin.module.scss': {default: {}},
      }, {fetch: async (url: string) => {requests.push(url); return Response.json({blocks: []}); }},
    );
    const entries = access.getReportEntries({role: 'support_manager', managerId: 4, sessionId: 'synthetic'});
    const tree = elements(AdminTopDashboardCatalog({canManage: false, canReadTopBlocks, reportEntries: entries, showStatus() {}}));
    assert.deepEqual(tree.filter((node) => node.type === Link).map((node) => node.props.href), [
      '/admin/manager-dashboard?audience=support', '/admin/top/route-planner',
    ]);
    effects.forEach((effect) => effect());
    await Promise.resolve();
    assert.deepEqual(requests, canReadTopBlocks ? ['/api/admin/top-dashboard/blocks'] : []);
    assert.ok(!tree.some((node) => node.type === 'form'), 'read-only catalog has no creation forms');
  }
});

test('route planner page grants only verified shared access and never fabricates manager identity', async () => {
  for (const [session, expectedMode] of [
    [{role: 'admin', adminUserId: 1, sessionId: 'synthetic'}, 'manage'],
    [{role: 'admintop', adminUserId: 2, sessionId: 'synthetic'}, 'manage'],
    [{role: 'support_manager', managerId: 3, sessionId: 'synthetic'}, 'view'],
    [{role: 'purchaser', adminUserId: 4, sessionId: 'synthetic', dashboardAccess: ['route-planner']}, 'view'],
    [{role: 'purchaser', adminUserId: 4, sessionId: 'synthetic', dashboardAccess: []}, null],
    [{role: 'manager', managerId: 5, sessionId: 'synthetic'}, null],
    [null, null],
  ] as Array<[AdminSession | null, 'manage' | 'view' | null]>) {
    const {default: Page} = compile<typeof import('../src/app/admin/top/route-planner/page')>(
      '../src/app/admin/top/route-planner/page.tsx', {
        'react/jsx-runtime': jsx,
        'next/navigation': {redirect: (href: string) => {throw new Error(`redirect:${href}`);}},
        '@/shared/lib/adminAuth': {getAdminSession: async () => session},
        '@/shared/lib/dashboardAccess': access,
        '@/shared/lib/managerDashboardSecurity': security,
        '@/features/admin/manager-dashboard/ManagerDashboard': {ManagerDashboard() {}},
      },
    );
    if (expectedMode) {
      const rendered = await Page();
      assert.deepEqual(rendered.props, {section: 'shared', mode: expectedMode});
    } else await assert.rejects(Page(), /redirect:\/admin\/top/);
  }
});
