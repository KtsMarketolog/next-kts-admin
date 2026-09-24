import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const requireForCards = createRequire(import.meta.url);
const previousStyleLoader = requireForCards.extensions['.scss'];
requireForCards.extensions['.scss'] = (module) => { module.exports = {}; };
const { AdminDashboard } = requireForCards('../src/features/admin/dashboard/AdminDashboard.tsx') as typeof import('../src/features/admin/dashboard/AdminDashboard');
if (previousStyleLoader) requireForCards.extensions['.scss'] = previousStyleLoader;
else delete requireForCards.extensions['.scss'];

type Props = Parameters<typeof AdminDashboard>[0];

function render(props: Partial<Props> = {}) {
  return renderToStaticMarkup(createElement(AdminDashboard, {
    canAccessSite: false,
    topDashboardMode: null,
    managerDashboardMode: null,
    isTopAreaOnlyUser: false,
    wholesaleHref: '/admin/wholesale/manager',
    ...props,
  }));
}

function managerCards(html: string) {
  return [...html.matchAll(/<a\b[^>]*href="(\/admin\/manager-dashboard[^"]*)"[^>]*>(.*?)<\/a>/g)]
    .map((match) => ({ href: match[1], html: match[2] }));
}

test('admin and admintop home layouts expose one reports catalog instead of standalone MR/MS cards', () => {
  for (const isTopAreaOnlyUser of [false, true]) {
    const html = render({
      canAccessSite: !isTopAreaOnlyUser,
      topDashboardMode: 'manage',
      managerDashboardMode: 'manage',
      isTopAreaOnlyUser,
      wholesaleHref: '/admin/wholesale/admin',
    });
    assert.deepEqual(managerCards(html), []);
    assert.equal([...html.matchAll(/href="\/admin\/top"/g)].length, 1);
    assert.match(html, /<h2>HTML-страницы и отчёты<\/h2>/);
  }
});

test('managers without general TOP permission can reach their reports through the catalog', () => {
  for (const managerDashboardAudience of ['development', 'support'] as const) {
    const html = render({ managerDashboardMode: 'view', managerDashboardAudience });
    assert.deepEqual(managerCards(html), []);
    assert.equal([...html.matchAll(/href="\/admin\/top"/g)].length, 1);
  }
});

test('a purchaser-style reports-only home never shows operational or management sections', () => {
  const html = render({ isTopAreaOnlyUser: true, canAccessReportsCatalog: true, topDashboardMode: 'view' });
  assert.match(html, /href="\/admin\/top"/);
  assert.doesNotMatch(html, /href="\/admin\/(site|clients|analogs|wholesale)/);
  assert.deepEqual(managerCards(html), []);
});

test('no manager permission or missing viewer audience exposes no dashboard card', () => {
  for (const managerDashboardAudience of [undefined, null, 'development', 'support'] as const) {
    for (const isTopAreaOnlyUser of [false, true]) {
      assert.deepEqual(managerCards(render({ managerDashboardAudience, isTopAreaOnlyUser })), []);
    }
  }
  assert.deepEqual(managerCards(render({ managerDashboardMode: 'view' })), []);
  assert.deepEqual(managerCards(render({ managerDashboardMode: 'view', managerDashboardAudience: null })), []);
});
