import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';

import * as pagination from '../src/shared/lib/managerDashboardImportPagination';
import type { ManagerDashboardImport } from '../src/features/admin/manager-dashboard/types';

// Render the real journal and exercise its handlers with synthetic pages only.
// No application session, real import records, server, or network is used.
const requireForJournal = createRequire(import.meta.url);
const previousStyleLoader = requireForJournal.extensions['.scss'];
requireForJournal.extensions['.scss'] = (module) => { module.exports = {}; };
const parts = requireForJournal('../src/features/admin/manager-dashboard/ManagerDashboardParts.tsx') as typeof import('../src/features/admin/manager-dashboard/ManagerDashboardParts');
const { ManagerDashboardImportJournal } = requireForJournal('../src/features/admin/manager-dashboard/ManagerDashboardImportJournal.tsx') as typeof import('../src/features/admin/manager-dashboard/ManagerDashboardImportJournal');
if (previousStyleLoader) requireForJournal.extensions['.scss'] = previousStyleLoader;
else delete requireForJournal.extensions['.scss'];

type JournalProps = {
  imports: ManagerDashboardImport[];
  nextCursor: string | null;
  busy: boolean;
  onAccessDenied?: () => void;
};
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
function imports(start = 100, count = 5): ManagerDashboardImport[] {
  return Array.from({ length: count }, (_, index) => ({
    id: start - index,
    originalName: `synthetic-${start - index}.ktsp`,
    status: 'imported',
    createdAt: '2026-09-01T06:00:00Z',
  }));
}
function response(rows: ManagerDashboardImport[], nextCursor: string | null, status = 200) {
  return new Response(JSON.stringify({ imports: rows, nextCursor }), { status, headers: { 'Content-Type': 'application/json' } });
}

function journal(options: {
  props?: Partial<JournalProps>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
} = {}) {
  const props: JournalProps = { imports: imports(), nextCursor: '96', busy: false, ...options.props };
  const slots: unknown[] = [];
  const effectSlots = new Set<number>();
  let cursor = 0;
  let mounted = true;
  let dirty = false;
  let updatesAfterUnmount = 0;
  let effects: Array<() => void> = [];
  type Effect = { deps: unknown[] | undefined; cleanup?: () => void };
  const hooks = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next: unknown) => {
        if (!mounted) { updatesAfterUnmount++; return; }
        slots[index] = typeof next === 'function' ? next(slots[index]) : next;
        dirty = true;
      }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(callback: () => void | (() => void), deps?: unknown[]) {
      const index = cursor++;
      const previous = slots[index] as Effect | undefined;
      if (previous && deps && previous.deps && deps.length === previous.deps.length
        && deps.every((value, position) => Object.is(value, previous.deps![position]))) return;
      effectSlots.add(index);
      effects.push(() => {
        previous?.cleanup?.();
        const cleanup = callback();
        slots[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined } satisfies Effect;
      });
    },
  };
  const modules: Record<string, unknown> = {
    react: hooks, 'react/jsx-runtime': jsx, './ManagerDashboard.module.scss': { default: {} },
    './ManagerDashboardParts': parts,
    '@/shared/lib/managerDashboardImportPagination': pagination,
  };
  const code = ts.transpileModule(readFileSync(new URL('../src/features/admin/manager-dashboard/ManagerDashboardImportJournal.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const testModule = { exports: {} as { ManagerDashboardImportJournal: (props: JournalProps) => Element } };
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    requests.push({ url: String(url), init });
    return options.fetch ? options.fetch(String(url), init) : response(imports(95), null);
  };
  new Function('require', 'module', 'exports', 'fetch', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`); return modules[name];
  }, testModule, testModule.exports, fetch);
  const render = () => {
    assert.equal(mounted, true, 'cannot render an unmounted journal');
    let tree: Element;
    let rounds = 0;
    do {
      cursor = 0;
      dirty = false;
      tree = testModule.exports.ManagerDashboardImportJournal(props);
      const queued = effects; effects = [];
      queued.forEach((effect) => effect());
      assert.ok(++rounds < 10, 'effects must settle without a render loop');
    } while (dirty);
    return tree;
  };
  const find = (type: unknown, predicate: (props: Element['props']) => boolean = () => true) => {
    const item = elements(render()).find((node) => node.type === type && predicate(node.props));
    assert.ok(item, `Missing ${String(type)}`); return item;
  };
  const rows = () => elements(render()).filter((node) => node.type === parts.ImportResults)
    .flatMap((node) => node.props.results as ManagerDashboardImport[]);
  const button = () => find('button', (props) => /Показать ещё|Загружаем/.test(text(props.children)));
  const more = () => (button().props.onClick as () => void)();
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); if (mounted) render(); };
  const unmount = () => {
    mounted = false;
    effectSlots.forEach((index) => (slots[index] as Effect | undefined)?.cleanup?.());
  };
  render();
  return { render, find, rows, button, more, settle, unmount, requests, updatesAfterUnmount: () => updatesAfterUnmount };
}

test('journal initially shows only the supplied five rows and requests the next five on demand', async () => {
  const view = journal();
  assert.equal(view.rows().length, 5);
  assert.deepEqual(view.rows().map((row) => row.id), [100, 99, 98, 97, 96]);
  assert.equal(view.requests.length, 0);
  view.more();
  await view.settle();
  assert.equal(view.requests.length, 1);
  const url = new URL(view.requests[0].url, 'https://example.test');
  assert.equal(url.pathname, '/api/admin/manager-dashboard/imports');
  assert.deepEqual([...url.searchParams], [['before', '96']]);
  assert.equal(view.requests[0].init.cache, 'no-store');
  assert.equal(view.requests[0].init.credentials, 'same-origin');
  assert.equal(view.requests[0].init.method ?? 'GET', 'GET');
  assert.deepEqual(view.rows().map((row) => row.id), [100, 99, 98, 97, 96, 95, 94, 93, 92, 91]);
  assert.equal(elements(view.render()).some((node) => node.type === 'button'), false, 'end of journal has no next-page action');
});

test('subsequent requests use the returned cursor and a short final page ends pagination', async () => {
  let page = 0;
  const view = journal({ fetch: async () => ++page === 1 ? response(imports(95), '91') : response(imports(90, 2), null) });
  view.more();
  await view.settle();
  assert.equal(view.rows().length, 10);
  view.more();
  await view.settle();
  assert.equal(new URL(view.requests[1].url, 'https://example.test').searchParams.get('before'), '91');
  assert.equal(view.rows().length, 12);
  assert.equal(elements(view.render()).some((node) => node.type === 'button'), false);
});

test('empty journal or a complete first page does not offer a next-page action', () => {
  for (const rows of [[], imports()]) {
    const html = renderToStaticMarkup(createElement(ManagerDashboardImportJournal, { imports: rows, nextCursor: null, busy: false }));
    assert.match(html, /Журнал импорта/);
    assert.doesNotMatch(html, /Показать ещё|<button/);
    if (rows.length === 0) assert.match(html, /Загрузок пока не было/);
    else assert.equal((html.match(/synthetic-\d+\.ktsp/g) ?? []).length, 5);
  }
});

test('immediate double clicks issue only one request and preserve existing rows while loading', async () => {
  let finish!: (response: Response) => void;
  const view = journal({ fetch: () => new Promise((resolve) => { finish = resolve; }) });
  const staleClick = view.button().props.onClick as () => void;
  staleClick();
  staleClick();
  view.more();
  assert.equal(view.requests.length, 1);
  assert.equal(view.rows().length, 5);
  assert.equal(view.button().props.disabled, true);
  assert.match(text(view.button()), /Загружаем/);
  finish(response(imports(95), null));
  await view.settle();
  assert.equal(view.rows().length, 10);
});

test('failed page request preserves visible rows and cursor and can be retried', async () => {
  let attempt = 0;
  const view = journal({ fetch: async () => {
    if (++attempt === 1) throw new Error('Synthetic connection failure');
    return response(imports(95), null);
  } });
  view.more();
  await view.settle();
  assert.equal(view.rows().length, 5);
  assert.equal(view.button().props.disabled, false);
  assert.ok(text(view.find('p', (props) => props.role === 'alert')));
  view.more();
  await view.settle();
  assert.equal(view.requests[0].url, view.requests[1].url);
  assert.equal(view.rows().length, 10);
  assert.equal(elements(view.render()).some((node) => node.props.role === 'alert'), false);
});

test('external busy prevents both a next-page click and direct invocation of its handler', () => {
  const view = journal({ props: { busy: true } });
  assert.equal(view.button().props.disabled, true);
  view.more();
  assert.equal(view.requests.length, 0);
  assert.equal(view.rows().length, 5);
});

test('access denial clears private rows and notifies the parent without further pagination', async () => {
  for (const status of [401, 403]) {
    let denied = 0;
    const view = journal({ props: { onAccessDenied: () => { denied++; } }, fetch: async () => response([], null, status) });
    view.more();
    await view.settle();
    assert.equal(denied, 1);
    assert.equal(view.rows().length, 0);
    assert.equal(elements(view.render()).some((node) => node.type === 'button'), false);
  }
});

test('first-page replacement unmounts and aborts the old journal; late responses cannot append stale rows', async () => {
  let finish!: (response: Response) => void;
  const oldView = journal({ fetch: () => new Promise((resolve) => { finish = resolve; }) });
  oldView.more();
  const signal = oldView.requests[0].init.signal;
  assert.ok(signal instanceof AbortSignal);
  oldView.unmount();
  assert.equal(signal.aborted, true);
  const newView = journal({ props: { imports: imports(200), nextCursor: '196' } });
  finish(response(imports(95), '91'));
  await oldView.settle();
  assert.equal(oldView.updatesAfterUnmount(), 0);
  assert.deepEqual(newView.rows().map((row) => row.id), [200, 199, 198, 197, 196]);
  assert.equal(newView.requests.length, 0);
});

test('unmount while the JSON body is still being read also prevents stale state updates', async () => {
  let finish!: (body: unknown) => void;
  let parsing = false;
  const delayed = response([], null);
  delayed.json = () => new Promise((resolve) => { parsing = true; finish = resolve; });
  const view = journal({ fetch: async () => delayed });
  view.more();
  await view.settle();
  assert.equal(parsing, true);
  view.unmount();
  finish({ imports: imports(95), nextCursor: '91' });
  await view.settle();
  assert.equal(view.updatesAfterUnmount(), 0);
});

test('oversized pages, invalid IDs, and non-advancing cursors are rejected without losing existing records', async () => {
  for (const payload of [
    { imports: imports(95, 6), nextCursor: '90' },
    { imports: [{ ...imports(95, 1)[0], id: 'not-an-id' }], nextCursor: null },
    { imports: imports(95), nextCursor: '96' },
    { imports: imports(95), nextCursor: '97' },
    { imports: [], nextCursor: '91' },
  ]) {
    const view = journal({ fetch: async () => new Response(JSON.stringify(payload), { status: 200 }) });
    view.more();
    await view.settle();
    assert.deepEqual(view.rows().map((row) => row.id), [100, 99, 98, 97, 96]);
    assert.ok(text(view.find('p', (props) => props.role === 'alert')));
    assert.equal(view.button().props.disabled, false);
  }
});

test('string IDs above the JavaScript safe integer range keep exact cursors and are not merged through numeric rounding', async () => {
  const first = { ...imports(100, 1)[0], id: '9007199254740996' };
  const next = { ...imports(95, 1)[0], id: '9007199254740995' };
  assert.equal(Number(first.id), Number(next.id), 'synthetic IDs deliberately collide if converted to Number');
  const view = journal({
    props: { imports: [first], nextCursor: first.id },
    fetch: async () => response([next], next.id),
  });
  view.more();
  await view.settle();
  assert.deepEqual(view.rows().map((row) => row.id), [first.id, next.id]);
  assert.equal(new URL(view.requests[0].url, 'https://example.test').searchParams.get('before'), first.id);
  view.more();
  assert.equal(new URL(view.requests[1].url, 'https://example.test').searchParams.get('before'), next.id);
  await view.settle();
});

test('duplicate records are deduplicated across and within pages even when IDs change from numbers to strings', async () => {
  const duplicate = { ...imports(96, 1)[0], id: '96' };
  const repeated = { ...imports(95, 1)[0], id: '95' };
  const view = journal({ fetch: async () => response([duplicate, repeated, repeated, ...imports(94, 2)], '93') });
  view.more();
  await view.settle();
  assert.deepEqual(view.rows().map((row) => String(row.id)), ['100', '99', '98', '97', '96', '95', '94', '93']);
});
