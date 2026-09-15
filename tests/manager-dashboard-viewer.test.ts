import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';

import * as audiences from '../src/shared/lib/managerDashboardAudience';
import { isManagerRole } from '../src/app/admin/adminPanelConfig';

import type { ManagerDashboardOverview, ManagerDashboardSnapshot } from '../src/features/admin/manager-dashboard/types';

// Exercise the real React viewer/frame. Only CSS loading is stubbed for Node; no browser or API is used.
const requireForViewer = createRequire(import.meta.url);
const previousStyleLoader = requireForViewer.extensions['.scss'];
requireForViewer.extensions['.scss'] = (module) => { module.exports = {}; };
const { ManagerDashboardViewer, managerDashboardViewIdentity } = requireForViewer('../src/features/admin/manager-dashboard/ManagerDashboardViewer.tsx') as typeof import('../src/features/admin/manager-dashboard/ManagerDashboardViewer');
const parts = requireForViewer('../src/features/admin/manager-dashboard/ManagerDashboardParts.tsx') as typeof import('../src/features/admin/manager-dashboard/ManagerDashboardParts');
const { ManagerDashboardManagement } = requireForViewer('../src/features/admin/manager-dashboard/ManagerDashboardManagement.tsx') as typeof import('../src/features/admin/manager-dashboard/ManagerDashboardManagement');
if (previousStyleLoader) requireForViewer.extensions['.scss'] = previousStyleLoader;
else delete requireForViewer.extensions['.scss'];

type View = Extract<ManagerDashboardOverview, { mode: 'view' }>;
const snapshot: ManagerDashboardSnapshot = {
  id: 17, originalName: 'synthetic-manager.ktsp', issued: '2026-09-01',
  expires: '2999-12-31', receivedAt: '2026-09-01T06:00:00Z',
};
const base: View = {
  mode: 'view', audience: 'development', bindingStatus: 'matched', email: 'synthetic.manager@example.test',
  snapshot: null, history: [], htmlVersion: { id: 9, audience: 'development', originalName: 'synthetic-dashboard.html' },
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
  assert.equal(frameUrl(html).searchParams.get('audience'), 'development');
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

test('viewer identity changes when audience/role, binding or recipient changes, not for ordinary data updates', () => {
  const initial = managerDashboardViewIdentity(base);
  assert.notEqual(managerDashboardViewIdentity({ ...base, bindingStatus: 'missing_email' }), initial);
  assert.notEqual(managerDashboardViewIdentity({ ...base, bindingStatus: 'ambiguous_email' }), initial);
  assert.notEqual(managerDashboardViewIdentity({ ...base, email: 'other.manager@example.test' }), initial);
  assert.notEqual(managerDashboardViewIdentity({ ...base, audience: 'support' }), initial);
  const nextData: View = { ...base, snapshot, htmlVersion: { id: 10, audience: 'development', originalName: 'new-dashboard.html' } };
  assert.equal(managerDashboardViewIdentity(nextData), initial);
});

test('support viewer selects its own audience and preserves password flow, empty states and frame isolation', () => {
  const support: View = { ...base, audience: 'support', snapshot, htmlVersion: { ...base.htmlVersion!, audience: 'support' } };
  const html = render(support);
  assert.equal(frameUrl(html).searchParams.get('audience'), 'support');
  assert.equal(frameUrl(html).searchParams.get('snapshot'), '17');
  assert.match(html, /введите пароль от файла/);
  assert.match(html, /sandbox="allow-scripts allow-same-origin"/);
  assert.doesNotMatch(html, /allow-popups/);
  const empty = render({ ...support, htmlVersion: null });
  assert.doesNotMatch(empty, /<iframe/);
  assert.match(empty, /HTML дашборда ещё не опубликован/);
});

test('frame defaults legacy callers to development and scopes support previews explicitly', () => {
  const legacy = renderToStaticMarkup(createElement(parts.DashboardFrame, { versionId: 9 }));
  assert.equal(frameUrl(legacy).searchParams.get('audience'), 'development');
  const support = renderToStaticMarkup(createElement(parts.DashboardFrame, { versionId: 29, audience: 'support', preview: true }));
  assert.match(support, /audience=support/);
  assert.match(support, /preview=1/);
  assert.match(support, /version=29/);
});

type Manage = Extract<ManagerDashboardOverview, { mode: 'manage' }>;
function managementOverview(): Manage {
  return {
    mode: 'manage', mail: { enabled: true, configured: true }, expectedBy: '10:00 МСК',
    imports: [{ id: 1, originalName: 'common-development.ktsp', status: 'imported' }, { id: 2, originalName: 'common-support.ktsp', status: 'imported' }],
    groups: (['development', 'support'] as const).map((audience, index) => ({
      audience, activeHtmlVersionId: index * 10 + 11, previousHtmlVersionId: index ? 22 : null,
      htmlVersions: [11, 12].map((id) => ({
        id: index * 10 + id, audience, originalName: `${audience}-${id}.html`, fileSize: 100,
        createdAt: '2026-09-01T06:00:00Z', firstPublishedAt: index || id === 11 ? '2026-09-01T06:00:00Z' : null,
      })),
      managers: [{ id: index + 1, name: `Only ${audience} manager`, email: `${audience}@example.test`, isActive: true, snapshot: null }],
    })),
  };
}

type Element = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const item = node as Element;
  return [item, ...elements(item.props.children)];
}
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (!node || typeof node !== 'object' || !('props' in node)) return '';
  return text((node as Element).props.children);
}

// Actual management component/event handlers with deterministic hooks and input
// refs. No browser, server, application auth, real payload or mutation is used.
function management(options: {
  overview?: Manage; busy?: boolean;
  mutate?: (path: string, init: RequestInit) => Promise<import('../src/features/admin/manager-dashboard/types').ManagerDashboardMutationResult | null>;
} = {}) {
  const overview = options.overview ?? managementOverview();
  const slots: unknown[] = [];
  let cursor = 0;
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
  };
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const confirmations: string[] = [];
  const modules: Record<string, unknown> = {
    react: hooks, 'react/jsx-runtime': jsx, './ManagerDashboard.module.scss': { default: {} },
    './ManagerDashboardParts': parts, '@/shared/lib/managerDashboardAudience': audiences,
  };
  const code = ts.transpileModule(readFileSync(new URL('../src/features/admin/manager-dashboard/ManagerDashboardManagement.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const testModule = { exports: {} as { ManagerDashboardManagement: (props: unknown) => Element } };
  new Function('require', 'module', 'exports', 'window', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`); return modules[name];
  }, testModule, testModule.exports, { confirm: (message: string) => { confirmations.push(message); return true; } });
  const inputs = new Map<string, { files: File[]; value: string }>();
  let focused = '';
  const render = () => {
    cursor = 0;
    const tree = testModule.exports.ManagerDashboardManagement({ overview, busy: options.busy ?? false, mutate: async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      return options.mutate ? options.mutate(path, init) : { results: overview.imports };
    } });
    for (const node of elements(tree)) {
      if (node.type === 'input' && typeof node.props.id === 'string') {
        const id = node.props.id;
        if (!inputs.has(id)) inputs.set(id, { files: [], value: '' });
        (node.props.ref as { current: unknown }).current = inputs.get(id);
      }
      if (node.type === 'button' && node.props.role === 'tab') {
        (node.props.ref as (node: unknown) => void)({ focus() { focused = String(node.props.id); } });
      }
    }
    return tree;
  };
  const find = (type: unknown, predicate: (props: Element['props']) => boolean = () => true) => {
    const item = elements(render()).find((node) => node.type === type && predicate(node.props));
    assert.ok(item, `Missing ${String(type)}`); return item;
  };
  const tab = (audience: audiences.PersonalDashboardAudience) => find('button', (props) => props.id === `manager-dashboard-tab-${audience}`);
  const switchTo = (audience: audiences.PersonalDashboardAudience) => (tab(audience).props.onClick as () => void)();
  const selected = () => String(find('div', (props) => props.role === 'tabpanel').props['aria-labelledby']);
  const selectFiles = (id: string, files: File[]) => {
    find('input', (props) => props.id === id);
    const input = inputs.get(id)!; input.files = files; input.value = 'synthetic-selection';
  };
  const submit = (id: string) => {
    const form = find('form', (props) => elements(props.children).some((node) => node.type === 'input' && node.props.id === id));
    (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  };
  const preview = (id: number) => {
    const row = find('tr', (props) => elements(props.children).some((node) => node.type === 'small'
      && Array.isArray(node.props.children) && node.props.children.includes(id)));
    const button = elements(row).find((node) => node.type === 'button' && text(node.props.children) === 'Предпросмотр')!;
    (button.props.onClick as () => void)();
  };
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); render(); };
  render();
  return { render, find, tab, switchTo, selected, selectFiles, submit, preview, settle, requests, confirmations, inputs, focused: () => focused };
}

test('management renders accessible group tabs while mixed-file controls and journal stay outside the group panel', () => {
  const html = renderToStaticMarkup(createElement(ManagerDashboardManagement, { overview: managementOverview(), busy: false, mutate: async () => null }));
  assert.match(html, /role="tablist"/);
  assert.match(html, /Менеджеры по развитию/);
  assert.match(html, /Менеджеры по сопровождению/);
  const view = management();
  const panel = view.find('div', (props) => props.role === 'tabpanel');
  assert.match(text(panel), /Only development manager/);
  assert.doesNotMatch(text(panel), /Only support manager|Общая загрузка|Журнал импорта|Проверить почту сейчас/);
  assert.equal(elements(panel).some((node) => node.props.id === 'manager-dashboard-snapshots'), false);
  view.switchTo('support');
  const supportPanel = view.find('div', (props) => props.role === 'tabpanel');
  assert.match(text(supportPanel), /Only support manager|support-11.html/);
  assert.doesNotMatch(text(supportPanel), /Only development manager|development-11.html/);
  assert.equal(view.tab('support').props['aria-selected'], true);
  assert.equal(view.tab('support').props.tabIndex, 0);
  assert.equal(view.tab('development').props.tabIndex, -1);
});

test('management tab keyboard navigation focuses and selects the matching panel; initial support HTML can be empty', () => {
  const overview = managementOverview();
  overview.groups[1] = { ...overview.groups[1], htmlVersions: [], activeHtmlVersionId: null, previousHtmlVersionId: null };
  const view = management({ overview });
  let prevented = false;
  (view.tab('development').props.onKeyDown as (event: unknown) => void)({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(view.selected(), 'manager-dashboard-tab-support');
  assert.equal(view.focused(), 'manager-dashboard-tab-support');
  assert.match(text(view.render()), /Для этой группы HTML ещё не загружен/);
  assert.equal(elements(view.render()).some((node) => node.type === parts.DashboardFrame), false);
  (view.tab('support').props.onKeyDown as (event: unknown) => void)({ key: 'Home', preventDefault() {} });
  assert.equal(view.selected(), 'manager-dashboard-tab-development');
});

test('management scopes preview/publication and rollback revisions to the selected group and clears previews on switch', async () => {
  const view = management();
  view.preview(12);
  assert.equal(view.find(parts.DashboardFrame).props.audience, 'development');
  (view.find('button', (props) => text(props.children) === 'Опубликовать группе').props.onClick as () => void)();
  await view.settle();
  assert.deepEqual(JSON.parse(view.requests[0].init.body as string), { audience: 'development', versionId: 12, expectedActiveVersionId: 11 });
  view.switchTo('support');
  assert.equal(elements(view.render()).some((node) => node.type === parts.DashboardFrame), false);
  assert.equal(view.find('button', (props) => text(props.children) === 'Вернуть группе').props.disabled, true);
  view.preview(22);
  const preview = view.find(parts.DashboardFrame);
  assert.equal(preview.props.audience, 'support');
  assert.equal(preview.props.preview, true);
  assert.equal(preview.props.versionId, 22);
  (view.find('button', (props) => text(props.children) === 'Вернуть группе').props.onClick as () => void)();
  await view.settle();
  assert.deepEqual(JSON.parse(view.requests[1].init.body as string), { audience: 'support', versionId: 22, expectedActiveVersionId: 21 });
  assert.match(view.confirmations[0], /Менеджеры по развитию/);
  assert.match(view.confirmations[1], /Менеджеры по сопровождению/);
});

test('management HTML upload fixes its audience and blocks immediate tab switches/duplicate operations until callback completes', async () => {
  let finish!: (result: import('../src/features/admin/manager-dashboard/types').ManagerDashboardMutationResult) => void;
  const view = management({ mutate: () => new Promise((resolve) => { finish = resolve; }) });
  view.switchTo('support');
  const staleDevelopmentClick = view.tab('development').props.onClick as () => void;
  const id = 'manager-dashboard-html-support';
  view.selectFiles(id, [new File(['<html>synthetic</html>'], 'support-upload.html')]);
  view.submit(id);
  staleDevelopmentClick();
  view.submit(id);
  assert.equal(view.selected(), 'manager-dashboard-tab-support');
  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].path, '/html?audience=support');
  assert.equal(view.tab('development').props.disabled, true);
  finish({ version: managementOverview().groups[1].htmlVersions[1] });
  await view.settle();
  assert.equal(view.find(parts.DashboardFrame).props.audience, 'support');
  assert.equal(view.find(parts.DashboardFrame).props.versionId, 22);
  view.switchTo('development');
  assert.equal(view.selected(), 'manager-dashboard-tab-development');
  assert.equal(elements(view.render()).some((node) => node.type === parts.DashboardFrame), false);
});

test('mixed snapshot uploads and mailbox checks are common, without selected-audience parameters', async () => {
  const view = management();
  const files = [new File(['synthetic-development'], 'development.ktsp'), new File(['synthetic-support'], 'support.ktsp')];
  view.selectFiles('manager-dashboard-snapshots', files);
  view.switchTo('support');
  view.submit('manager-dashboard-snapshots');
  await view.settle();
  assert.equal(view.requests[0].path, '/snapshots');
  const form = view.requests[0].init.body as FormData;
  assert.deepEqual([...form.keys()], ['files', 'files']);
  assert.deepEqual(form.getAll('files').map((file) => (file as File).name), ['development.ktsp', 'support.ktsp']);
  view.switchTo('development');
  (view.find('button', (props) => text(props.children) === 'Проверить почту сейчас').props.onClick as () => void)();
  await view.settle();
  assert.equal(view.requests[1].path, '/check-email');
  assert.equal(view.requests[1].init.body, undefined);
  const results = view.find(parts.ImportResults, (props) => props.title === 'Результат последней операции');
  assert.deepEqual(results.props.results, managementOverview().imports);
});

test('management external busy prevents tab navigation and support manager dashboard card uses the shared manager-role guard', () => {
  const view = management({ busy: true });
  view.switchTo('support');
  assert.equal(view.selected(), 'manager-dashboard-tab-development');
  assert.equal(view.tab('support').props.disabled, true);
  assert.equal(isManagerRole('manager'), true);
  assert.equal(isManagerRole('support_manager'), true);
  assert.equal(isManagerRole('wholesale_admin'), false);
  assert.match(readFileSync(new URL('../src/app/admin/AdminPanel.tsx', import.meta.url), 'utf8'), /managerDashboardMode=\{[^\n]+isManagerRole\(sessionRole\) \? 'view' : null\}/);
});
