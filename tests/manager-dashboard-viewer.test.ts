import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { ManagerDashboardOverview, ManagerDashboardSnapshot } from '../src/features/admin/manager-dashboard/types';

// Exercise the real React viewer/frame. Only CSS loading is stubbed for Node; no browser or API is used.
const requireForViewer = createRequire(import.meta.url);
const previousStyleLoader = requireForViewer.extensions['.scss'];
requireForViewer.extensions['.scss'] = (module) => { module.exports = {}; };
const { ManagerDashboardViewer, managerDashboardViewIdentity } = requireForViewer('../src/features/admin/manager-dashboard/ManagerDashboardViewer.tsx') as typeof import('../src/features/admin/manager-dashboard/ManagerDashboardViewer');
if (previousStyleLoader) requireForViewer.extensions['.scss'] = previousStyleLoader;
else delete requireForViewer.extensions['.scss'];

type View = Extract<ManagerDashboardOverview, { mode: 'view' }>;
const snapshot: ManagerDashboardSnapshot = {
  id: 17, originalName: 'synthetic-manager.ktsp', issued: '2026-09-01',
  expires: '2999-12-31', receivedAt: '2026-09-01T06:00:00Z',
};
const base: View = {
  mode: 'view', bindingStatus: 'matched', email: 'synthetic.manager@example.test',
  snapshot: null, history: [], htmlVersion: { id: 9, originalName: 'synthetic-dashboard.html' },
};

function render(overview: View) {
  return renderToStaticMarkup(createElement(ManagerDashboardViewer, { overview, loading: false, onReload: async () => true }));
}

function frameUrl(html: string) {
  const match = html.match(/<iframe[^>]+src="([^"]+)"/);
  assert.ok(match, 'published HTML must render a frame');
  const url = new URL(match[1].replaceAll('&amp;', '&'), 'https://example.test');
  assert.equal(url.pathname, '/api/admin/manager-dashboard/frame');
  assert.equal(url.searchParams.get('version'), '9');
  assert.equal(url.searchParams.has('preview'), false, 'manager empty states must not use admin preview');
  return url;
}

test('published HTML is visible before a personal snapshot arrives', () => {
  const html = render(base);
  assert.equal(frameUrl(html).searchParams.has('snapshot'), false);
  assert.match(html, /Ваш файл ещё не поступил/);
  assert.match(html, /Опубликованный HTML уже доступен/);
});

test('missing email leaves published HTML available without a misleading recipient or data request', () => {
  const html = render({ ...base, bindingStatus: 'missing_email', email: '' });
  assert.equal(frameUrl(html).searchParams.has('snapshot'), false);
  assert.match(html, /В профиле не указан email/);
  assert.match(html, /Email нужен только для привязки личного файла/);
  assert.doesNotMatch(html, /Файл для|undefined|role="alert"/);
});

test('ambiguous binding hides any retained snapshot metadata/history and keeps the HTML frame', () => {
  const html = render({ ...base, bindingStatus: 'ambiguous_email', snapshot, history: [snapshot] });
  assert.equal(frameUrl(html).searchParams.has('snapshot'), false);
  assert.match(html, /у нескольких менеджеров/);
  assert.doesNotMatch(html, /synthetic-manager\.ktsp|manager-dashboard-history|Файл для/);
});

test('expired snapshot still opens the normal HTML frame with its ID for server-side empty-state handling', () => {
  const html = render({ ...base, snapshot: { ...snapshot, expires: '2000-01-01' }, snapshotStatus: 'expired' });
  assert.equal(frameUrl(html).searchParams.get('snapshot'), '17');
  assert.match(html, /Срок доступа к этому снимку истёк/);
  assert.doesNotMatch(html, /введите пароль от файла/);
});

test('valid personal snapshot retains the password flow and unpublished HTML remains unavailable', () => {
  const html = render({ ...base, snapshot });
  assert.equal(frameUrl(html).searchParams.get('snapshot'), '17');
  assert.match(html, /введите пароль от файла/);
  const unpublished = render({ ...base, htmlVersion: null });
  assert.doesNotMatch(unpublished, /<iframe/);
  assert.match(unpublished, /HTML дашборда ещё не опубликован/);
});

test('viewer identity changes when binding is lost or recipient changes, not for ordinary data updates', () => {
  const initial = managerDashboardViewIdentity(base);
  assert.notEqual(managerDashboardViewIdentity({ ...base, bindingStatus: 'missing_email' }), initial);
  assert.notEqual(managerDashboardViewIdentity({ ...base, bindingStatus: 'ambiguous_email' }), initial);
  assert.notEqual(managerDashboardViewIdentity({ ...base, email: 'other.manager@example.test' }), initial);
  const nextData: View = { ...base, snapshot, htmlVersion: { id: 10, originalName: 'new-dashboard.html' } };
  assert.equal(managerDashboardViewIdentity(nextData), initial);
});
