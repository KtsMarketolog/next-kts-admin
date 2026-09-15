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
const { ManagerDashboardImportJournal } = requireForViewer('../src/features/admin/manager-dashboard/ManagerDashboardImportJournal.tsx') as typeof import('../src/features/admin/manager-dashboard/ManagerDashboardImportJournal');
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
    imports: [{ id: 1, originalName: 'common-development.ktsp', status: 'imported' }, { id: 2, originalName: 'common-support.ktsp', status: 'imported' }], importsNextCursor: null,
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
    useEffect() {},
  };
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const confirmations: string[] = [];
  const modules: Record<string, unknown> = {
    react: hooks, 'react/jsx-runtime': jsx, './ManagerDashboard.module.scss': { default: {} },
    './ManagerDashboardParts': parts, '@/shared/lib/managerDashboardAudience': audiences,
    './ManagerDashboardImportJournal': { ManagerDashboardImportJournal },
  };
  const code = ts.transpileModule(readFileSync(new URL('../src/features/admin/manager-dashboard/ManagerDashboardManagement.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const testModule = { exports: {} as { ManagerDashboardManagement: (props: unknown) => Element } };
  new Function('require', 'module', 'exports', 'window', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`); return modules[name];
  }, testModule, testModule.exports, { confirm: (message: string) => { confirmations.push(message); return true; } });
  const inputs = new Map<string, { files: File[]; value: string; focus(): void }>();
  let focusedInput = '';
  const render = () => {
    cursor = 0;
    const tree = testModule.exports.ManagerDashboardManagement({ overview, busy: options.busy ?? false, mutate: async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      return options.mutate ? options.mutate(path, init) : { results: overview.imports };
    } });
    for (const node of elements(tree)) {
      if (node.type === 'input' && typeof node.props.id === 'string') {
        const id = node.props.id;
        if (!inputs.has(id)) inputs.set(id, { files: [], value: '', focus() { focusedInput = id; } });
        const ref = node.props.ref;
        if (typeof ref === 'function') ref(inputs.get(id));
        else (ref as { current: unknown }).current = inputs.get(id);
      }
    }
    return tree;
  };
  const find = (type: unknown, predicate: (props: Element['props']) => boolean = () => true) => {
    const item = elements(render()).find((node) => node.type === type && predicate(node.props));
    assert.ok(item, `Missing ${String(type)}`); return item;
  };
  const group = (audience: audiences.PersonalDashboardAudience) => find('section', (props) => props.id === `manager-dashboard-group-${audience}`);
  const selectFiles = (id: string, files: File[]) => {
    find('input', (props) => props.id === id);
    const input = inputs.get(id)!; input.files = files; input.value = 'synthetic-selection';
  };
  const submit = (id: string) => {
    const form = find('form', (props) => elements(props.children).some((node) => node.type === 'input' && node.props.id === id));
    (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  };
  const row = (audience: audiences.PersonalDashboardAudience, id: number) => {
    const item = elements(group(audience)).find((node) => node.type === 'tr' && elements(node.props.children).some((node) => node.type === 'small'
      && Array.isArray(node.props.children) && node.props.children.includes(id)));
    assert.ok(item, `Missing ${audience} version #${id}`); return item;
  };
  const versionButton = (audience: audiences.PersonalDashboardAudience, id: number, title: string) => {
    const item = elements(row(audience, id)).find((node) => node.type === 'button' && text(node.props.children) === title);
    assert.ok(item, `Missing ${audience} version #${id} button ${title}`); return item;
  };
  const preview = (audience: audiences.PersonalDashboardAudience, id: number) => {
    const button = versionButton(audience, id, 'Предпросмотр');
    (button.props.onClick as () => void)();
  };
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); render(); };
  render();
  return { render, find, group, versionButton, selectFiles, submit, preview, settle, requests, confirmations, inputs, focusedInput: () => focusedInput };
}

test('management shows both independently labelled groups together without tabs and keeps common controls below them', () => {
  const html = renderToStaticMarkup(createElement(ManagerDashboardManagement, { overview: managementOverview(), busy: false, mutate: async () => null }));
  assert.doesNotMatch(html, /role="tab(?:list|panel)?"|manager-dashboard-tab-/);
  assert.match(html, /Менеджеры по развитию/);
  assert.match(html, /Менеджеры по сопровождению/);
  assert.match(html, /Only development manager/);
  assert.match(html, /Only support manager/);
  const view = management();
  for (const audience of ['development', 'support'] as const) {
    const group = view.group(audience);
    const otherAudience = audience === 'development' ? 'support' : 'development';
    assert.equal(group.props['aria-labelledby'], `manager-dashboard-heading-${audience}`);
    assert.equal(elements(group).filter((node) => node.props.id === `manager-dashboard-heading-${audience}`).length, 1);
    assert.match(text(group), new RegExp(`Only ${audience} manager`));
    assert.match(text(group), new RegExp(`${audience}-11.html`));
    assert.doesNotMatch(text(group), new RegExp(`Only ${otherAudience} manager|${otherAudience}-11.html|Общая загрузка|Журнал импорта|Проверить почту сейчас`));
    assert.equal(elements(group).filter((node) => node.props.id === `manager-dashboard-html-${audience}`).length, 1);
    assert.equal(elements(group).some((node) => node.props.id === 'manager-dashboard-snapshots'), false);
  }
  const tree = elements(view.render());
  assert.equal(tree.filter((node) => node.props.id === 'manager-dashboard-snapshots').length, 1);
  assert.equal(tree.filter((node) => node.type === 'button' && text(node.props.children) === 'Проверить почту сейчас').length, 1);
  assert.equal(tree.filter((node) => node.type === ManagerDashboardImportJournal).length, 1);
  assert.equal((html.match(/Журнал импорта/g) ?? []).length, 1);
  const journal = view.find(ManagerDashboardImportJournal);
  assert.deepEqual(journal.props.imports, managementOverview().imports);
  assert.equal(journal.props.nextCursor, null);
  const sharedInputIndex = tree.findIndex((node) => node.props.id === 'manager-dashboard-snapshots');
  const sharedJournalIndex = tree.findIndex((node) => node.type === ManagerDashboardImportJournal);
  assert.ok(sharedInputIndex > tree.findIndex((node) => node.props.id === 'manager-dashboard-html-support'));
  assert.ok(sharedJournalIndex > sharedInputIndex);
});

test('management remounts the journal when its first page or cursor changes, not on an unchanged overview refresh', () => {
  const overview = managementOverview();
  const original = management({ overview }).find(ManagerDashboardImportJournal) as Element & { key: string };
  const sameData = management({ overview: JSON.parse(JSON.stringify(overview)) as Manage }).find(ManagerDashboardImportJournal) as Element & { key: string };
  assert.equal(original.key, sameData.key);
  const changedRows = management({ overview: { ...overview, imports: [{ ...overview.imports[0], status: 'error' }, overview.imports[1]] } }).find(ManagerDashboardImportJournal) as Element & { key: string };
  assert.notEqual(original.key, changedRows.key);
  const changedCursor = management({ overview: { ...overview, importsNextCursor: 'older-page' } }).find(ManagerDashboardImportJournal) as Element & { key: string };
  assert.notEqual(original.key, changedCursor.key);
});

test('empty support HTML stays independent from existing development versions and both upload forms remain visible', () => {
  const overview = managementOverview();
  overview.groups[1] = { ...overview.groups[1], htmlVersions: [], activeHtmlVersionId: null, previousHtmlVersionId: null };
  const view = management({ overview });
  assert.match(text(view.group('support')), /Для этой группы HTML ещё не загружен/);
  assert.doesNotMatch(text(view.group('development')), /Для этой группы HTML ещё не загружен/);
  assert.match(text(view.group('development')), /development-11.html|Опубликована версия #11/);
  assert.equal(view.find('input', (props) => props.id === 'manager-dashboard-html-development').props.disabled, false);
  assert.equal(view.find('input', (props) => props.id === 'manager-dashboard-html-support').props.disabled, false);
  assert.equal(elements(view.render()).some((node) => node.type === parts.DashboardFrame), false);
});

test('one full-width preview stays outside both columns and publication or rollback targets its exact audience and revision', async () => {
  const view = management();
  const rollback = () => view.versionButton('support', 22, 'Вернуть группе');
  assert.equal(rollback().props.disabled, true);
  (rollback().props.onClick as () => void)();
  await view.settle();
  assert.equal(view.requests.length, 0, 'even a directly invoked handler must require a preview');
  view.preview('development', 12);
  assert.equal(view.find(parts.DashboardFrame).props.audience, 'development');
  const panel = view.find('section', (props) => props.id === 'manager-dashboard-html-preview');
  assert.equal(panel.props.tabIndex, -1);
  assert.equal(elements(panel).filter((node) => node.type === parts.DashboardFrame).length, 1);
  const grid = view.find('div', (props) => Array.isArray(props.children)
    && props.children.some((node: Element) => node?.props?.id === 'manager-dashboard-group-development')
    && props.children.some((node: Element) => node?.props?.id === 'manager-dashboard-group-support'));
  assert.equal(elements(grid).some((node) => node.type === parts.DashboardFrame), false);
  assert.equal(rollback().props.disabled, true, 'development preview cannot enable support rollback');
  (rollback().props.onClick as () => void)();
  await view.settle();
  assert.equal(view.requests.length, 0);
  (view.versionButton('development', 12, 'Опубликовать группе').props.onClick as () => void)();
  await view.settle();
  assert.equal(view.requests[0].path, '/publish');
  assert.deepEqual(JSON.parse(view.requests[0].init.body as string), { audience: 'development', versionId: 12, expectedActiveVersionId: 11 });
  view.preview('support', 22);
  const preview = view.find(parts.DashboardFrame);
  assert.equal(elements(view.render()).filter((node) => node.type === parts.DashboardFrame).length, 1);
  assert.equal(preview.props.audience, 'support');
  assert.equal(preview.props.preview, true);
  assert.equal(preview.props.versionId, 22);
  assert.equal(view.versionButton('development', 12, 'Опубликовать группе').props.disabled, true);
  (rollback().props.onClick as () => void)();
  await view.settle();
  assert.deepEqual(JSON.parse(view.requests[1].init.body as string), { audience: 'support', versionId: 22, expectedActiveVersionId: 21 });
  assert.match(view.confirmations[0], /Менеджеры по развитию/);
  assert.match(view.confirmations[1], /Менеджеры по сопровождению/);
  (view.find('button', (props) => text(props.children) === 'Закрыть').props.onClick as () => void)();
  assert.equal(elements(view.render()).some((node) => node.type === parts.DashboardFrame), false);
  assert.equal(rollback().props.disabled, true);
  assert.equal(view.focusedInput(), 'manager-dashboard-html-support');
});

test('publication preview gate checks audience as well as version ID', async () => {
  const overview = managementOverview();
  overview.groups[1].htmlVersions[1].id = 12;
  overview.groups[1].previousHtmlVersionId = 12;
  const view = management({ overview });
  view.preview('development', 12);
  const supportRollback = view.versionButton('support', 12, 'Вернуть группе');
  assert.equal(supportRollback.props.disabled, true);
  (supportRollback.props.onClick as () => void)();
  await view.settle();
  assert.equal(view.requests.length, 0);
});

test('independent HTML selections bind uploads to their caller group and serialize duplicate cross-group events', async () => {
  let finish!: (result: import('../src/features/admin/manager-dashboard/types').ManagerDashboardMutationResult) => void;
  const view = management({ mutate: () => new Promise((resolve) => { finish = resolve; }) });
  const developmentId = 'manager-dashboard-html-development';
  const supportId = 'manager-dashboard-html-support';
  view.selectFiles(developmentId, [new File(['<html>development</html>'], 'development-upload.html')]);
  view.selectFiles(supportId, [new File(['<html>support</html>'], 'support-upload.html')]);
  const stalePreview = view.versionButton('development', 12, 'Предпросмотр').props.onClick as () => void;
  const staleDevelopmentForm = view.find('form', (props) => elements(props.children).some((node) => node.props.id === developmentId));
  const staleSubmit = staleDevelopmentForm.props.onSubmit as (event: unknown) => void;
  view.submit(supportId);
  stalePreview();
  staleSubmit({ preventDefault() {} });
  view.submit(developmentId);
  view.submit(supportId);
  assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].path, '/html?audience=support');
  assert.equal((view.requests[0].init.body as FormData).get('file') instanceof File, true);
  assert.equal(((view.requests[0].init.body as FormData).get('file') as File).name, 'support-upload.html');
  assert.equal(view.find('input', (props) => props.id === developmentId).props.disabled, true);
  assert.equal(view.find('input', (props) => props.id === supportId).props.disabled, true);
  assert.equal(elements(view.render()).some((node) => node.type === parts.DashboardFrame), false);
  finish({ version: managementOverview().groups[1].htmlVersions[1] });
  await view.settle();
  assert.equal(view.find(parts.DashboardFrame).props.audience, 'support');
  assert.equal(view.find(parts.DashboardFrame).props.versionId, 22);
  assert.equal(view.inputs.get(supportId)!.value, '');
  assert.equal(view.inputs.get(developmentId)!.value, 'synthetic-selection');
  assert.equal(view.inputs.get(developmentId)!.files[0].name, 'development-upload.html');
  view.submit(developmentId);
  assert.equal(view.requests.length, 2);
  assert.equal(view.requests[1].path, '/html?audience=development');
  assert.equal(((view.requests[1].init.body as FormData).get('file') as File).name, 'development-upload.html');
  finish({ version: managementOverview().groups[0].htmlVersions[1] });
  await view.settle();
  assert.equal(view.find(parts.DashboardFrame).props.audience, 'development');
  assert.equal(view.inputs.get(developmentId)!.value, '');
});

test('invalid HTML errors remain in their own column and successful uploads do not clear another selection or error', async () => {
  const view = management({ mutate: async () => ({ version: managementOverview().groups[1].htmlVersions[1] }) });
  const developmentId = 'manager-dashboard-html-development';
  const supportId = 'manager-dashboard-html-support';
  view.selectFiles(developmentId, [new File(['not HTML'], 'bad.ktsp')]);
  view.selectFiles(supportId, [new File(['<html>support</html>'], 'support-upload.html')]);
  view.submit(developmentId);
  await view.settle();
  assert.equal(view.requests.length, 0);
  assert.match(text(view.group('development')), /Выберите непустой HTML-файл размером до 5 МБ/);
  assert.doesNotMatch(text(view.group('support')), /Выберите непустой HTML-файл размером до 5 МБ/);
  view.submit(supportId);
  await view.settle();
  assert.equal(view.requests[0].path, '/html?audience=support');
  assert.match(text(view.group('development')), /Выберите непустой HTML-файл размером до 5 МБ/);
  assert.equal(view.inputs.get(developmentId)!.value, 'synthetic-selection');
  assert.equal(view.inputs.get(supportId)!.value, '');
});

test('failed upload preserves both selected HTML files and releases the shared mutation lock for retry', async () => {
  const view = management({ mutate: async () => null });
  for (const audience of ['development', 'support'] as const) {
    view.selectFiles(`manager-dashboard-html-${audience}`, [new File(['<html>synthetic</html>'], `${audience}.html`)]);
  }
  view.submit('manager-dashboard-html-support');
  await view.settle();
  assert.equal(view.inputs.get('manager-dashboard-html-support')!.value, 'synthetic-selection');
  assert.equal(view.inputs.get('manager-dashboard-html-development')!.value, 'synthetic-selection');
  assert.equal(elements(view.render()).some((node) => node.type === parts.DashboardFrame), false);
  view.submit('manager-dashboard-html-development');
  await view.settle();
  assert.deepEqual(view.requests.map((request) => request.path), ['/html?audience=support', '/html?audience=development']);
});

test('mixed snapshot uploads and mailbox checks are common and never carry an audience parameter', async () => {
  const view = management();
  const files = [new File(['synthetic-development'], 'development.ktsp'), new File(['synthetic-support'], 'support.ktsp')];
  view.selectFiles('manager-dashboard-snapshots', files);
  view.submit('manager-dashboard-snapshots');
  await view.settle();
  assert.equal(view.requests[0].path, '/snapshots');
  const form = view.requests[0].init.body as FormData;
  assert.deepEqual([...form.keys()], ['files', 'files']);
  assert.deepEqual(form.getAll('files').map((file) => (file as File).name), ['development.ktsp', 'support.ktsp']);
  (view.find('button', (props) => text(props.children) === 'Проверить почту сейчас').props.onClick as () => void)();
  await view.settle();
  assert.equal(view.requests[1].path, '/check-email');
  assert.equal(view.requests[1].init.body, undefined);
  const results = view.find(parts.ImportResults, (props) => props.title === 'Результат последней операции');
  assert.deepEqual(results.props.results, managementOverview().imports);
});

test('external busy blocks uploads, previews, publications and shared controls for both visible groups', () => {
  const view = management({ busy: true });
  for (const [audience, versionId] of [['development', 12], ['support', 22]] as const) {
    const id = `manager-dashboard-html-${audience}`;
    view.selectFiles(id, [new File(['<html>synthetic</html>'], `${audience}.html`)]);
    assert.equal(view.find('input', (props) => props.id === id).props.disabled, true);
    assert.equal(view.versionButton(audience, versionId, 'Предпросмотр').props.disabled, true);
    view.submit(id);
    view.preview(audience, versionId);
    const publish = view.versionButton(audience, versionId, audience === 'development' ? 'Опубликовать группе' : 'Вернуть группе');
    assert.equal(publish.props.disabled, true);
    (publish.props.onClick as () => void)();
  }
  view.selectFiles('manager-dashboard-snapshots', [new File(['synthetic'], 'support.ktsp')]);
  view.submit('manager-dashboard-snapshots');
  const check = view.find('button', (props) => text(props.children) === 'Проверить почту сейчас');
  assert.equal(check.props.disabled, true);
  (check.props.onClick as () => void)();
  assert.equal(view.requests.length, 0);
  assert.equal(view.confirmations.length, 0);
  assert.equal(elements(view.render()).some((node) => node.type === parts.DashboardFrame), false);
});

test('support manager dashboard card keeps the shared manager-role guard', () => {
  assert.equal(isManagerRole('manager'), true);
  assert.equal(isManagerRole('support_manager'), true);
  assert.equal(isManagerRole('wholesale_admin'), false);
  assert.match(readFileSync(new URL('../src/app/admin/AdminPanel.tsx', import.meta.url), 'utf8'), /managerDashboardMode=\{[^\n]+isManagerRole\(sessionRole\) \? 'view' : null\}/);
});
