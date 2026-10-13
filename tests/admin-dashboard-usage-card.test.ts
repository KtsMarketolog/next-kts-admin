import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';
import type { AdminSession } from '../src/shared/lib/adminAuth';
import { canReviewDashboardUsage } from '../src/shared/lib/dashboardUsageAccess';

type Dashboard = typeof import('../src/features/admin/dashboard/AdminDashboard').AdminDashboard;
type Props = Parameters<Dashboard>[0];
type LinkProps = { href: string; className?: string; children?: ReactNode; replace?: boolean; scroll?: boolean };
const journalHref = '/admin/dashboard-usage';

function renderDashboard(props: Partial<Props> = {}) {
  const links: Omit<LinkProps, 'children'>[] = [];
  function Link({ children, ...attributes }: LinkProps) {
    links.push(attributes);
    return createElement('a', { href: attributes.href, className: attributes.className }, children);
  }
  const dependencies: Record<string, unknown> = {
    'react/jsx-runtime': jsxRuntime,
    'next/link': { default: Link },
    '@/app/admin/admin.module.scss': { default: {
      dashboardCard: 'dashboardCard', dashboardCardInteractive: 'dashboardCardInteractive',
      dashboardGrid: 'dashboardGrid', dashboardGridSingle: 'dashboardGridSingle', dashboardCardLink: 'dashboardCardLink',
    } },
  };
  const code = ts.transpileModule(readFileSync('src/features/admin/dashboard/AdminDashboard.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports: { AdminDashboard?: Dashboard } = {};
  vm.runInNewContext(code, { exports, require: (name: string) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  const html = renderToStaticMarkup(createElement(exports.AdminDashboard!, {
    canAccessSite: true, topDashboardMode: 'manage', managerDashboardMode: 'manage',
    isTopAreaOnlyUser: false, wholesaleHref: '/admin/wholesale/admin', ...props,
  }));
  return { html, links };
}

test('journal card uses the existing role-and-identity permission in both dashboard layouts', () => {
  for (const role of ['admin', 'admintop', 'top', 'wholesale_admin', 'manager', 'support_manager', 'purchaser'] as const) {
    const session: AdminSession = { role, sessionId: 'persisted-session', adminUserId: 1, managerId: 2,
      dashboardAccess: ['currency-rates', 'top:4'] };
    const allowed = ['admin', 'admintop', 'top'].includes(role);
    for (const isTopAreaOnlyUser of [false, true]) {
      const { html, links } = renderDashboard({ isTopAreaOnlyUser, canReviewUsage: canReviewDashboardUsage(session) });
      assert.equal(links.filter(link => link.href === journalHref).length, allowed ? 1 : 0, `${role}/${isTopAreaOnlyUser}`);
      assert.equal(html.includes('Журнал и сотрудники'), allowed);
      if (allowed) {
        assert.equal(links[0].href, journalHref, 'The prominent journal card is the first card');
        assert.equal(links[0].className, 'dashboardCard dashboardCardInteractive');
        assert.match(html, /Открыть журнал/);
      }
    }
  }
});

test('journal card defaults to hidden and report access or incomplete identity does not grant it', () => {
  const denied: Array<AdminSession | null | undefined> = [null, undefined,
    { role: 'admin' }, { role: 'top', adminUserId: 1 }, { role: 'admintop', sessionId: 'session' },
    { role: 'top', sessionId: 'session', adminUserId: 0, dashboardAccess: ['top:4'] },
  ];
  for (const isTopAreaOnlyUser of [false, true]) {
    assert.equal(renderDashboard({ isTopAreaOnlyUser }).links.some(link => link.href === journalHref), false);
    for (const session of denied) {
      const { links } = renderDashboard({ isTopAreaOnlyUser, canManageUsers: true,
        canReviewUsage: canReviewDashboardUsage(session) });
      assert.equal(links.some(link => link.href === journalHref), false);
    }
  }
  assert.equal(renderDashboard({ canReviewUsage: canReviewDashboardUsage({ role: 'admin', sessionId: 'env-admin-session' }) })
    .links.some(link => link.href === journalHref), true, 'Environment-backed admin has a persisted session, without an employee ID');
});

test('journal navigation keeps normal history and scroll and preserves all existing cards', () => {
  for (const isTopAreaOnlyUser of [false, true]) {
    for (const canManageUsers of [false, true]) {
      const options = { isTopAreaOnlyUser, canManageUsers };
      const previous = renderDashboard(options).links;
      const next = renderDashboard({ ...options, canReviewUsage: true }).links;
      const journal = next.find(link => link.href === journalHref)!;
      assert.equal(journal.replace, undefined);
      assert.equal(journal.scroll, undefined);
      assert.deepEqual(next.filter(link => link.href !== journalHref), previous);
      assert.ok(previous.some(link => link.href === '/admin/top'));
      if (!isTopAreaOnlyUser) {
        for (const href of ['/admin/site', '/admin/wholesale/admin', '/admin/clients', '/admin/analogs']) {
          assert.ok(previous.some(link => link.href === href), href);
        }
      }
    }
  }
  const restricted = renderDashboard({ canAccessSite: false, canAccessReportsCatalog: false,
    wholesaleHref: '/admin/wholesale/manager', canReviewUsage: false });
  assert.equal(restricted.links.some(link => ['/admin/site', '/admin/top', journalHref].includes(link.href)), false);
  assert.ok(restricted.links.some(link => link.href === '/admin/wholesale/manager'));
});

test('admin home passes the shared journal permission, without broadening server authorization', () => {
  const panel = readFileSync('src/app/admin/AdminPanel.tsx', 'utf8');
  const dashboard = panel.match(/<AdminDashboard\b[\s\S]*?\/>/)?.[0] ?? '';
  assert.match(dashboard, /canReviewUsage=\{canReviewDashboardUsage\(reportSession\)\}/);
  const source = readFileSync('src/features/admin/dashboard/AdminDashboard.tsx', 'utf8');
  assert.equal(source.split('<h2>Журнал и сотрудники</h2>').length - 1, 1, 'One shared JSX card implementation');
  assert.equal(source.split('{canReviewUsage && <DashboardUsageCard />}').length - 1, 2, 'Both dashboard layouts use the same card');
});
