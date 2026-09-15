import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';

import * as audiences from '../src/shared/lib/managerDashboardAudience';
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
  };
}
const parts = {
  DashboardFrame() {}, ImportResults() {}, SnapshotStatus() {},
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
    const row = elements(group).find((node) => node.type === 'tr' && elements(node).some((child) => child.type === 'strong' && text(child) === version.originalName));
    assert.ok(row, `Missing ${audience} version #${id} row`);
    const item = elements(row).find((node) => node.type === 'button' && text(node) === label);
    assert.ok(item, `Missing ${audience} version #${id} ${label} action`);
    return item;
  };
  const click = (audience: Audience, id: number, label = 'Удалить') => (button(audience, id, label).props.onClick as () => void)();
  const preview = () => elements(render()).find((node) => node.type === parts.DashboardFrame);
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); render(); };
  render();
  return { render, button, click, preview, settle, requests, confirmations, data };
}

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
