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

test('admin and admintop home layouts expose distinct development and support cards', () => {
  for (const isTopAreaOnlyUser of [false, true]) {
    const cards = managerCards(render({
      canAccessSite: !isTopAreaOnlyUser,
      topDashboardMode: 'manage',
      managerDashboardMode: 'manage',
      isTopAreaOnlyUser,
      wholesaleHref: '/admin/wholesale/admin',
    }));
    assert.deepEqual(cards.map((card) => card.href), [
      '/admin/manager-dashboard?audience=development',
      '/admin/manager-dashboard?audience=support',
    ]);
    assert.match(cards[0].html, /<h2>Дашборды МР<\/h2>/);
    assert.match(cards[1].html, /<h2>Дашборды МС<\/h2>/);
    assert.match(cards[1].html, /Личные и общие дашборды менеджеров сопровождения/);
  }
});

test('each manager sees only the card for their verified audience', () => {
  for (const managerDashboardAudience of ['development', 'support'] as const) {
    const cards = managerCards(render({ managerDashboardMode: 'view', managerDashboardAudience }));
    assert.equal(cards.length, 1);
    assert.equal(cards[0].href, `/admin/manager-dashboard?audience=${managerDashboardAudience}`);
    assert.match(cards[0].html, managerDashboardAudience === 'development'
      ? /<h2>Дашборды МР<\/h2>/
      : /<h2>Дашборды МС<\/h2>/);
    if (managerDashboardAudience === 'support') {
      assert.match(cards[0].html, /Ваш личный и общие дашборды/);
    }
  }
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
