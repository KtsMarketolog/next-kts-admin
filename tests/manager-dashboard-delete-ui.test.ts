import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';

import * as audiences from '../src/shared/lib/managerDashboardAudience';
import * as sharedJsonUpload from '../src/features/admin/manager-dashboard/sharedJsonUpload';
import type { ManagerDashboardMutationResult, ManagerDashboardOverview } from '../src/features/admin/manager-dashboard/types';

// Exercise the real management component and event handlers using synthetic
// versions. No dashboard files, user sessions, network or database are touched.
type Manage = Extract<ManagerDashboardOverview, { mode: 'manage' }>;
type Audience = audiences.PersonalDashboardAudience;
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
function overview(): Manage {
  return {
    mode: 'manage', mail: { enabled: true, configured: true }, imports: [], importsNextCursor: null,
    groups: (['development', 'support'] as const).map((audience, index) => ({
      audience, activeHtmlVersionId: index * 10 + 1, previousHtmlVersionId: index * 10 + 2,
      htmlVersions: [1, 2, 3, 4].map((offset) => ({
        id: index * 10 + offset, audience, originalName: `${audience}-${offset}.html`, fileSize: 100,
        createdAt: '2026-09-01T06:00:00Z', firstPublishedAt: offset === 4 ? null : '2026-09-01T06:00:00Z',
      })),
      managers: [{ id: index + 1, name: `Synthetic ${audience}`, email: `${audience}@example.test`, snapshot: {
        id: 100 + index, originalName: `synthetic-${audience}.ktsp`, issued: '2026-09-01', expires: '2999-12-31', receivedAt: '2026-09-01T06:00:00Z',
      } }],
    })),
    supportShared: {
      activeHtmlVersionId: 21, previousHtmlVersionId: 22,
      htmlVersions: [21, 22, 23].map((id) => ({
        id, audience: 'support', originalName: `shared-${id}.html`, fileSize: 100,
        createdAt: '2026-09-01T06:00:00Z', firstPublishedAt: id === 23 ? null : '2026-09-01T06:00:00Z',
      })),
      snapshot: { id: 201, originalName: 'synthetic-shared.ktsp', email: 'shared@example.test',
        issued: '2026-09-01', expires: '2999-12-31', receivedAt: '2026-09-01T06:00:00Z' },
      history: [],
    },
  };
}
const parts = {
  DashboardFrame() {}, SharedDashboardFrame() {}, ImportResults() {}, SnapshotStatus() {},
  formatDashboardDate: (value: string) => value,
};
function management(options: {
  overview?: Manage;
  busy?: boolean;
  confirm?: () => boolean;
  mutate?: (path: string, init: RequestInit) => Promise<ManagerDashboardMutationResult | null>;
} = {}) {
  const data = options.overview ?? overview();
  const slots: unknown[] = [];
  let cursor = 0;
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect() { cursor++; },
  };
  const modules: Record<string, unknown> = {
    react: hooks, 'react/jsx-runtime': jsx, './ManagerDashboard.module.scss': { default: {} },
    './ManagerDashboardParts': parts, '@/shared/lib/managerDashboardAudience': audiences,
    './ManagerDashboardImportJournal': { ManagerDashboardImportJournal() {} },
    './sharedJsonUpload': sharedJsonUpload,
  };
  const code = ts.transpileModule(readFileSync(new URL('../src/features/admin/manager-dashboard/ManagerDashboardManagement.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const testModule = { exports: {} as { ManagerDashboardManagement: (props: unknown) => Element } };
  const confirmations: string[] = [];
  new Function('require', 'module', 'exports', 'window', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`); return modules[name];
  }, testModule, testModule.exports, { confirm(message: string) {
    confirmations.push(message); return options.confirm?.() ?? true;
  } });
  const requests: Array<{ path: string; init: RequestInit; message: string }> = [];
  const render = () => {
    cursor = 0;
    return testModule.exports.ManagerDashboardManagement({ overview: data, busy: options.busy ?? false,
      mutate: async (path: string, init: RequestInit, message: string) => {
        requests.push({ path, init, message });
        return options.mutate ? options.mutate(path, init) : { message: 'Synthetic deletion succeeded' };
      } });
  };
  const button = (audience: Audience, id: number, label = 'Удалить') => {
    const group = elements(render()).find((node) => node.props.id === `manager-dashboard-group-${audience}`);
    assert.ok(group, `Missing ${audience} group`);
    const version = data.groups.find((item) => item.audience === audience)?.htmlVersions.find((item) => item.id === id);
    assert.ok(version, `Missing ${audience} version #${id}`);
    const row = elements(render()).find((node) => node.type === 'tr' && node.props['data-version-audience'] === audience && node.props['data-version-id'] === id);
    assert.ok(row, `Missing ${audience} version #${id} row`);
    const item = elements(row).find((node) => node.type === 'button' && text(node) === label);
    assert.ok(item, `Missing ${audience} version #${id} ${label} action`);
    return item;
  };
  const click = (audience: Audience, id: number, label = 'Удалить') => (button(audience, id, label).props.onClick as () => void)();
  const sharedButton = (id: number, label: string) => {
    const section = elements(render()).find((node) => node.props.id === 'manager-dashboard-shared-support');
    assert.ok(section, 'Missing shared support section');
    const version = data.supportShared?.htmlVersions.find((item) => item.id === id);
    assert.ok(version, `Missing shared version #${id}`);
    const row = elements(render()).find((node) => node.type === 'tr' && node.props['data-version-audience'] === 'support-shared' && node.props['data-version-id'] === id);
    assert.ok(row, `Missing shared version #${id} row`);
    const action = elements(row).find((node) => node.type === 'button' && text(node) === label);
    assert.ok(action, `Missing shared version #${id} ${label} action`);
    return action;
  };
  const clickShared = (id: number, label: string) => (sharedButton(id, label).props.onClick as () => void)();
  const preview = () => elements(render()).find((node) => node.type === parts.DashboardFrame);
  const sharedPreview = () => elements(render()).find((node) => node.type === parts.SharedDashboardFrame);
  const closePreview = () => {
    const close = elements(render()).find((node) => node.type === 'button' && text(node) === 'Закрыть');
    assert.ok(close, 'Missing preview close action');
    (close.props.onClick as () => void)();
  };
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); };
  render();
  return { render, button, click, sharedButton, clickShared, preview, sharedPreview, closePreview, settle, requests, confirmations, data };
}

test('shared JSON preview uses only the selected HTML data revision and explains automatic loading', () => {
  const data = overview();
  const shared = data.supportShared!;
  shared.htmlVersions[0].format = 'route-planner-v1';
  shared.htmlVersions[1].format = 'route-planner-v1';
  const view = management({ overview: data });
  view.clickShared(21, 'Предпросмотр общего HTML');
  assert.equal(view.sharedPreview()?.props.revision, 0, 'preview starts without data');
  assert.equal(view.sharedPreview()?.props.preview, true);
  assert.equal(view.sharedPreview()?.props.snapshotId, undefined, 'the server selects the JSON for the preview HTML');
  assert.match(text(view.render()), /Общий JSON, привязанный к этой версии HTML, загружается автоматически/);
  assert.match(text(view.render()), /Личные данные менеджеров не загружаются/);
  assert.doesNotMatch(text(view.render()), /Общие и личные данные не загружаются/);

  shared.jsonSnapshot = { id: 301, htmlVersionId: 21, originalName: 'shared.json', fileSize: 100,
    sha256: 'a'.repeat(64), savedAt: '2026-09-17T05:00:00Z', receivedAt: '2026-09-17T06:00:00Z', status: 'active' };
  assert.equal(view.sharedPreview()?.props.revision, 301, 'first JSON upload refreshes the open HTML');
  shared.jsonSnapshot = { ...shared.jsonSnapshot, id: 302 };
  assert.equal(view.sharedPreview()?.props.revision, 302, 'replacement JSON refreshes the same HTML');

  view.clickShared(22, 'Предпросмотр общего HTML');
  assert.equal(view.sharedPreview()?.props.revision, 0, 'another HTML never inherits the active HTML JSON revision');
  assert.equal(view.sharedPreview()?.props.versionId, 22);
  shared.jsonSnapshot = { ...shared.jsonSnapshot, id: 303 };
  assert.equal(view.sharedPreview()?.props.revision, 0, 'unrelated JSON uploads leave another HTML preview alone');
});

test('legacy shared and personal previews keep data-free copy and ignore shared JSON changes', () => {
  const view = management();
  view.clickShared(21, 'Предпросмотр общего HTML');
  assert.match(text(view.render()), /Общие и личные данные не загружаются/);
  assert.equal(view.sharedPreview()?.props.revision, 0);
  view.data.supportShared!.jsonSnapshot = { id: 301, htmlVersionId: 21, originalName: 'shared.json', fileSize: 100,
    sha256: 'a'.repeat(64), savedAt: '2026-09-17T05:00:00Z', receivedAt: '2026-09-17T06:00:00Z', status: 'active' };
  assert.equal(view.sharedPreview()?.props.revision, 0, 'JSON metadata never enables refresh of a password preview');

  view.click('development', 1, 'Предпросмотр');
  assert.match(text(view.render()), /Личные данные менеджеров не загружаются/);
  assert.doesNotMatch(text(view.render()), /Общий JSON, привязанный/);
  assert.deepEqual(view.preview()?.props, { audience: 'development', versionId: 1, preview: true });
  view.data.supportShared!.jsonSnapshot = { ...view.data.supportShared!.jsonSnapshot!, id: 302 };
  assert.deepEqual(view.preview()?.props, { audience: 'development', versionId: 1, preview: true });
});

test('management exposes named delete controls for both groups and protects their active HTML versions', async () => {
  const view = management();
  for (const [audience, first] of [['development', 1], ['support', 11]] as const) {
    const active = view.button(audience, first);
    assert.equal(active.props.disabled, true);
    assert.match(String(active.props.title), /[Сс]начала.*опубликуйте|опубликовать.*друг/i);
    (active.props.onClick as () => void)();
    for (const id of [first + 1, first + 2, first + 3]) {
      const button = view.button(audience, id);
      assert.equal(button.props.disabled, false, 'previous, archived and draft versions are removable without a preview');
      assert.match(String(button.props['aria-label']), new RegExp(`${audience}-${id - first + 1}\\.html`));
      assert.match(String(button.props['aria-label']), new RegExp(`#${id}`));
      assert.ok(String(button.props['aria-label']).includes(audiences.PERSONAL_DASHBOARD_AUDIENCE_LABELS[audience]));
    }
  }
  await view.settle();
  assert.equal(view.confirmations.length, 0, 'invoking a disabled active handler cannot even ask for deletion');
  assert.equal(view.requests.length, 0);
});

test('delete confirmation cancellation leaves preview, versions and snapshots unchanged', async () => {
  const view = management({ confirm: () => false });
  const before = structuredClone(view.data);
  view.click('development', 2, 'Предпросмотр');
  view.click('development', 2);
  await view.settle();
  assert.equal(view.requests.length, 0);
  assert.equal(view.preview()?.props.versionId, 2);
  assert.deepEqual(view.data, before);
  assert.equal(view.confirmations.length, 1);
  const confirmation = view.confirmations[0];
  assert.match(confirmation, /development-2\.html/);
  assert.match(confirmation, /#2/);
  assert.match(confirmation, /Менеджеры по развитию/);
  assert.match(confirmation, /необратим/);
  assert.match(confirmation, /повторной загрузк/);
  assert.match(confirmation, /другая группа/);
  assert.match(confirmation, /личные снимки/);
});

test('confirmed deletion targets only the exact HTML id and group, without a snapshot operation', async () => {
  for (const [audience, id] of [['development', 3], ['support', 14]] as const) {
    const view = management();
    const before = structuredClone(view.data);
    view.click(audience, id);
    await view.settle();
    assert.equal(view.requests.length, 1);
    const request = view.requests[0];
    const url = new URL(request.path, 'https://example.test');
    assert.equal(url.pathname, '/html');
    assert.deepEqual([...url.searchParams].sort(), [['audience', audience], ['id', String(id)]]);
    assert.equal(request.init.method, 'DELETE');
    assert.equal(request.init.body, undefined);
    assert.ok(request.message.includes(audiences.PERSONAL_DASHBOARD_AUDIENCE_LABELS[audience]));
    assert.match(request.message, new RegExp(`#${id}`));
    assert.deepEqual(view.data, before, 'handler does not mutate parent overview or data records locally');
  }
});

test('successful deletion closes only the preview of its exact version and group', async () => {
  for (const [previewAudience, previewId, deleteAudience, deleteId, closes] of [
    ['development', 2, 'development', 2, true],
    ['development', 3, 'development', 2, false],
    ['support', 12, 'development', 2, false],
    ['support', 12, 'support', 12, true],
  ] as const) {
    const view = management();
    view.click(previewAudience, previewId, 'Предпросмотр');
    view.click(deleteAudience, deleteId);
    await view.settle();
    assert.equal(view.requests.length, 1);
    if (closes) assert.equal(view.preview(), undefined);
    else {
      assert.equal(view.preview()?.props.audience, previewAudience);
      assert.equal(view.preview()?.props.versionId, previewId);
    }
  }
});

test('same numeric version id in a different group cannot clear that other group preview', async () => {
  const data = overview();
  data.groups[1].htmlVersions[1].id = 2;
  data.groups[1].previousHtmlVersionId = 2;
  const view = management({ overview: data });
  view.click('support', 2, 'Предпросмотр');
  view.click('development', 2);
  await view.settle();
  assert.equal(view.preview()?.props.audience, 'support');
  assert.equal(view.preview()?.props.versionId, 2);
});

test('failed deletion preserves the selected preview and releases the lock for retry', async () => {
  let attempt = 0;
  const view = management({ mutate: async () => ++attempt === 1 ? null : { message: 'Synthetic success' } });
  view.click('support', 12, 'Предпросмотр');
  view.click('support', 12);
  await view.settle();
  assert.equal(view.preview()?.props.audience, 'support');
  assert.equal(view.preview()?.props.versionId, 12);
  assert.equal(view.button('support', 12).props.disabled, false);
  view.click('support', 12);
  await view.settle();
  assert.equal(view.requests.length, 2);
  assert.equal(view.requests[0].path, view.requests[1].path);
  assert.equal(view.preview(), undefined);
});

test('external busy blocks deletion, including direct invocation before rendering another state', async () => {
  const view = management({ busy: true });
  for (const [audience, id] of [['development', 2], ['support', 12]] as const) {
    assert.equal(view.button(audience, id).props.disabled, true);
    view.click(audience, id);
  }
  await view.settle();
  assert.equal(view.requests.length, 0);
  assert.equal(view.confirmations.length, 0);
});

test('same-tick double clicks and cross-group actions share the deletion mutation lock', async () => {
  let finish!: (result: ManagerDashboardMutationResult | null) => void;
  const view = management({ mutate: () => new Promise((resolve) => { finish = resolve; }) });
  view.click('development', 2, 'Предпросмотр');
  const staleDelete = view.button('development', 2).props.onClick as () => void;
  const staleOtherDelete = view.button('support', 12).props.onClick as () => void;
  const staleOtherPreview = view.button('support', 12, 'Предпросмотр').props.onClick as () => void;
  staleDelete();
  staleDelete();
  staleOtherDelete();
  staleOtherPreview();
  view.click('support', 12);
  assert.equal(view.requests.length, 1);
  assert.equal(view.confirmations.length, 1);
  assert.equal(view.preview()?.props.audience, 'development');
  assert.equal(view.preview()?.props.versionId, 2);
  assert.equal(view.button('development', 2).props.disabled, true);
  assert.equal(view.button('support', 12).props.disabled, true);
  finish({ message: 'Synthetic success' });
  await view.settle();
  assert.equal(view.preview(), undefined);
  assert.equal(view.button('support', 12).props.disabled, false);
  view.click('support', 12);
  assert.equal(view.requests.length, 2);
  finish(null);
  await view.settle();
});

test('both personal groups publish drafts, archives and rollbacks without opening a preview', async () => {
  for (const [audience, active] of [['development', 1], ['support', 11]] as const) {
    for (const offset of [1, 2, 3]) {
      const view = management();
      const before = structuredClone(view.data);
      const id = active + offset;
      const label = offset === 1 ? 'Вернуть группе' : 'Опубликовать группе';
      assert.equal(view.preview(), undefined);
      assert.equal(view.button(audience, id, label).props.disabled, false);
      assert.doesNotMatch(String(view.button(audience, id, label).props.title), /[Сс]начала.*предпросмотр/);
      view.click(audience, id, label);
      await view.settle();
      assert.equal(view.requests.length, 1);
      assert.equal(view.requests[0].path, '/publish');
      assert.equal(view.requests[0].init.method, 'POST');
      assert.deepEqual(JSON.parse(view.requests[0].init.body as string), { audience, versionId: id, expectedActiveVersionId: active });
      assert.equal(view.confirmations.length, 1);
      assert.ok(view.confirmations[0].includes(audiences.PERSONAL_DASHBOARD_AUDIENCE_LABELS[audience]));
      assert.match(view.confirmations[0], new RegExp(`#${id}`));
      assert.ok(view.confirmations[0].includes(`${audience}-${offset + 1}.html`));
      assert.match(view.confirmations[0], /личные файлы данных менеджеров сохранятся/);
      assert.deepEqual(view.data, before, 'publication request never rewrites local snapshots or other publications');
    }
  }
});

test('personal publication still works after closing its preview and with another group preview open', async () => {
  for (const [audience, id, other, otherId, active] of [
    ['development', 4, 'support', 14, 1], ['support', 14, 'development', 4, 11],
  ] as const) {
    for (const mode of ['closed', 'other-group'] as const) {
      const view = management();
      view.click(audience, id, 'Предпросмотр');
      if (mode === 'closed') view.closePreview();
      else view.click(other, otherId, 'Предпросмотр');
      assert.equal(view.button(audience, id, 'Опубликовать группе').props.disabled, false);
      view.click(audience, id, 'Опубликовать группе');
      await view.settle();
      assert.equal(view.requests.length, 1);
      assert.deepEqual(JSON.parse(view.requests[0].init.body as string), { audience, versionId: id, expectedActiveVersionId: active });
      assert.equal(view.preview()?.props.audience, mode === 'closed' ? undefined : other);
      assert.equal(view.preview()?.props.versionId, mode === 'closed' ? undefined : otherId);
    }
  }
});

test('shared publication and rollback do not need a preview or inherit the personal publication identity', async () => {
  for (const id of [22, 23]) {
    for (const previewState of ['none', 'closed', 'personal'] as const) {
      const data = overview();
      data.groups[1].htmlVersions[3].id = id;
      const view = management({ overview: data });
      const before = structuredClone(data);
      const label = id === 22 ? 'Вернуть общий HTML' : 'Опубликовать общий HTML';
      if (previewState === 'closed') {
        view.clickShared(id, 'Предпросмотр общего HTML');
        assert.equal(view.sharedPreview()?.props.versionId, id);
        view.closePreview();
      } else if (previewState === 'personal') view.click('support', id, 'Предпросмотр');
      assert.equal(view.sharedButton(id, label).props.disabled, false);
      view.clickShared(id, label);
      await view.settle();
      assert.equal(view.requests.length, 1);
      assert.equal(view.requests[0].path, '/shared/publish');
      assert.equal(view.requests[0].init.method, 'POST');
      assert.deepEqual(JSON.parse(view.requests[0].init.body as string), { versionId: id, expectedActiveVersionId: 21 });
      assert.equal(view.confirmations.length, 1);
      assert.ok(view.confirmations[0].includes(`shared-${id}.html`));
      assert.match(view.confirmations[0], /всех менеджеров по сопровождению/);
      assert.match(view.confirmations[0], /Личные дашборды и личные файлы менеджеров сохранятся/);
      assert.equal(view.preview()?.props.audience, previewState === 'personal' ? 'support' : undefined);
      assert.equal(view.sharedPreview(), undefined);
      assert.deepEqual(data, before);
    }
  }
});

test('cancelling direct publication leaves both personal groups and shared state unchanged', async () => {
  const view = management({ confirm: () => false });
  const before = structuredClone(view.data);
  view.click('development', 4, 'Опубликовать группе');
  view.click('support', 12, 'Вернуть группе');
  view.clickShared(23, 'Опубликовать общий HTML');
  await view.settle();
  assert.equal(view.confirmations.length, 3);
  assert.equal(view.requests.length, 0);
  assert.equal(view.preview(), undefined);
  assert.equal(view.sharedPreview(), undefined);
  assert.deepEqual(view.data, before);
  assert.equal(view.button('development', 4, 'Опубликовать группе').props.disabled, false);
  assert.equal(view.sharedButton(23, 'Опубликовать общий HTML').props.disabled, false);
});

test('external busy blocks direct publication for both personal groups and shared HTML before confirmation', async () => {
  const view = management({ busy: true });
  const actions = [view.button('development', 4, 'Опубликовать группе'), view.button('support', 12, 'Вернуть группе'),
    view.sharedButton(23, 'Опубликовать общий HTML')];
  for (const action of actions) {
    assert.equal(action.props.disabled, true);
    (action.props.onClick as () => void)();
  }
  await view.settle();
  assert.equal(view.confirmations.length, 0);
  assert.equal(view.requests.length, 0);
});

test('direct publication serializes same-tick double clicks across personal and shared HTML with exact CAS targets', async () => {
  for (const first of ['development', 'support', 'shared'] as const) {
    let finish!: (result: ManagerDashboardMutationResult | null) => void;
    const view = management({ mutate: () => new Promise((resolve) => { finish = resolve; }) });
    const stale = {
      development: view.button('development', 4, 'Опубликовать группе').props.onClick as () => void,
      support: view.button('support', 12, 'Вернуть группе').props.onClick as () => void,
      shared: view.sharedButton(23, 'Опубликовать общий HTML').props.onClick as () => void,
    };
    stale[first]();
    stale[first]();
    for (const click of Object.values(stale)) click();
    await view.settle();
    assert.equal(view.confirmations.length, 1);
    assert.equal(view.requests.length, 1);
    assert.equal(view.requests[0].path, first === 'shared' ? '/shared/publish' : '/publish');
    assert.deepEqual(JSON.parse(view.requests[0].init.body as string), first === 'shared'
      ? { versionId: 23, expectedActiveVersionId: 21 }
      : { audience: first, versionId: first === 'development' ? 4 : 12, expectedActiveVersionId: first === 'development' ? 1 : 11 });
    assert.equal(view.button('development', 4, 'Опубликовать группе').props.disabled, true);
    assert.equal(view.button('support', 12, 'Вернуть группе').props.disabled, true);
    assert.equal(view.sharedButton(23, 'Опубликовать общий HTML').props.disabled, true);
    finish(null);
    await view.settle();
    assert.equal(view.button('development', 4, 'Опубликовать группе').props.disabled, false);
    assert.equal(view.sharedButton(23, 'Опубликовать общий HTML').props.disabled, false);
    stale[first]();
    assert.equal(view.requests.length, 2, 'failed publication releases the common guard for retry');
    assert.equal(view.confirmations.length, 2);
    assert.deepEqual(view.requests[1].init, view.requests[0].init);
    finish({ message: 'Synthetic publication succeeded' });
    await view.settle();
  }
});
