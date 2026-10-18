import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

type Action<T> = T | ((current: T) => T);
type Key = string | number;
type Draft<T extends object> = {
  value: T;
  setValue(action: Action<T>): void;
  hydrate(saved: T): void;
  accept(submitted: T, saved: T, fields?: Array<keyof T>): void;
  resetAfterSave(submitted: T): void;
  dirty: boolean;
};
type Collection<T extends object> = {
  items: T[];
  hydrate(saved: T[]): void;
  update(id: Key, patch: Partial<T>): void;
  accept(submitted: T, saved: T, fields?: Array<keyof T>): void;
  remove(id: Key): void;
  baseline(id: Key): T | undefined;
  dirtyKeys: Set<Key>;
};
type Helpers = {
  sameDraftValue(left: unknown, right: unknown): boolean;
  mergeSavedDraft<T extends object>(current: T, submitted: T, saved: T, fields?: Array<keyof T>): T;
  useAdminDraft<T extends object>(initial: T, scopeKey?: string): Draft<T>;
  useAdminDraftCollection<T extends object>(key: (row: T) => Key, scopeKey?: string): Collection<T>;
  discardAdminDraftWorkspace(prefix: string): void;
};

// Execute the production hook and model React's persistent slots, lazy state
// initialization, functional setters and dependency-aware memoization. No live
// API, database, localStorage or user data participates in these tests.
function hooks(browser = false) {
  let cursor = 0;
  let needsRender = false;
  const effects: Array<() => void> = [];
  const slots: unknown[] = [];
  const react = {
    useState<T>(initial: T | (() => T)) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? (initial as () => T)() : initial;
      const setState = (action: Action<T>) => {
        slots[slot] = typeof action === 'function' ? (action as (current: T) => T)(slots[slot] as T) : action;
        needsRender = true;
      };
      return [slots[slot], setState];
    },
    useRef(initial: unknown) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot];
    },
    useCallback(callback: unknown, deps: unknown[]) {
      const slot = cursor++;
      const previous = slots[slot] as { callback: unknown; deps: unknown[] } | undefined;
      if (!previous || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        slots[slot] = { callback, deps };
      }
      return (slots[slot] as { callback: unknown }).callback;
    },
    useMemo<T>(factory: () => T, deps: unknown[]) {
      const slot = cursor++;
      const previous = slots[slot] as { value: T; deps: unknown[] } | undefined;
      if (!previous || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        slots[slot] = { value: factory(), deps };
      }
      return (slots[slot] as { value: T }).value;
    },
    useLayoutEffect(callback: () => void | (() => void), deps: unknown[]) {
      const slot = cursor++;
      const previous = slots[slot] as { deps: unknown[]; cleanup?: () => void } | undefined;
      if (!previous || deps.length !== previous.deps.length || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        const next = { deps, cleanup: undefined as (() => void) | undefined };
        slots[slot] = next;
        effects.push(() => { previous?.cleanup?.(); next.cleanup = callback() || undefined; });
      }
    },
  };
  const code = ts.transpileModule(readFileSync('src/features/admin/model/useAdminDraftState.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} as Helpers };
  new Function('require', 'module', 'exports', 'window', code)((name: string) => {
    assert.equal(name, 'react');
    return react;
  }, loaded, loaded.exports, browser ? {} : undefined);
  return {
    helpers: loaded.exports,
    remount() {
      for (const slot of slots) (slot as { cleanup?: () => void })?.cleanup?.();
      slots.length = 0; effects.length = 0; cursor = 0;
    },
    renderWithoutEffects<T>(factory: (helpers: Helpers) => T) { cursor = 0; return factory(loaded.exports); },
    render<T>(factory: (helpers: Helpers) => T) {
      let result: T;
      do {
        needsRender = false; cursor = 0; result = factory(loaded.exports);
        while (effects.length) effects.shift()!();
      } while (needsRender);
      return result;
    },
  };
}

type Row = { id: number; title: string; imageUrl: string; sortOrder: number; isActive: boolean };
const row = (id: number, patch: Partial<Row> = {}): Row => ({ id, title: `Title ${id}`, imageUrl: `/image${id}.png`, sortOrder: id, isActive: true, ...patch });

function collection() {
  const fixture = hooks();
  const keyOf = (item: Row) => item.id;
  return () => fixture.render((helper) => helper.useAdminDraftCollection(keyOf));
}

test('three-way acknowledgement normalizes submitted values but preserves newer edits', () => {
  const { mergeSavedDraft } = hooks().helpers;
  const submitted = row(1, { title: ' Draft ', imageUrl: ' /new.png ' });
  const current = { ...submitted, title: 'New typing', isActive: false };
  const saved = { ...submitted, title: 'Draft', imageUrl: '/new.png' };
  assert.deepEqual(mergeSavedDraft(current, submitted, saved), { ...current, imageUrl: '/new.png' });
  assert.equal(current.imageUrl, ' /new.png ', 'Acknowledgement must not mutate the input');
});

test('single draft hydration refreshes clean fields and preserves unsaved edits', () => {
  const fixture = hooks();
  const render = () => fixture.render((helper) => helper.useAdminDraft({ phone: '', email: '', address: '' }));
  render().hydrate({ phone: 'Phone 1', email: 'Email 1', address: 'Address 1' });
  assert.equal(render().dirty, false);
  render().setValue((value) => ({ ...value, phone: 'Draft phone' }));
  render().hydrate({ phone: 'Server phone', email: 'Email 2', address: 'Address 2' });
  assert.deepEqual(render().value, { phone: 'Draft phone', email: 'Email 2', address: 'Address 2' });
  assert.equal(render().dirty, true);
  render().setValue((value) => ({ ...value, phone: 'Server phone' }));
  assert.equal(render().dirty, false);
});

test('single-field save acknowledges only that setting and retains other dirty fields', () => {
  const fixture = hooks();
  const render = () => fixture.render((helper) => helper.useAdminDraft({ phone: 'Phone', email: 'Email', address: 'Address' }));
  render().setValue((value) => ({ ...value, phone: ' New phone ', email: 'Unsaved email' }));
  const submitted = render().value;
  render().accept(submitted, { ...submitted, phone: 'New phone' }, ['phone']);
  assert.deepEqual(render().value, { phone: 'New phone', email: 'Unsaved email', address: 'Address' });
  assert.equal(render().dirty, true);
  render().setValue((value) => ({ ...value, email: 'Email' }));
  assert.equal(render().dirty, false, 'The saved phone is clean; the unsaved email is not implicitly acknowledged');
});

test('creation reset clears only submitted fields and keeps typing entered while saving', () => {
  const fixture = hooks();
  const render = () => fixture.render((helper) => helper.useAdminDraft({ title: '', imageUrl: '', isActive: true }));
  render().setValue({ title: 'Submitted', imageUrl: '/submitted.png', isActive: false });
  const submitted = render().value;
  render().setValue((value) => ({ ...value, title: 'Typed after click' }));
  render().resetAfterSave(submitted);
  assert.deepEqual(render().value, { title: 'Typed after click', imageUrl: '', isActive: true });
  assert.equal(render().dirty, true);
  render().resetAfterSave(render().value);
  assert.equal(render().dirty, false);
});

test('acknowledging one row preserves newer edits on that row and all other row drafts', () => {
  const render = collection();
  render().hydrate([row(1), row(2)]);
  render().update(1, { title: ' Submitted ', imageUrl: ' /new.png ' });
  render().update(2, { title: 'Other unsaved title' });
  const submitted = render().items[0];
  render().update(1, { title: 'Newer title', isActive: false });
  const saved = { ...submitted, title: 'Submitted', imageUrl: '/new.png' };
  render().accept(submitted, saved);
  assert.deepEqual(render().items, [
    { ...saved, title: 'Newer title', isActive: false },
    row(2, { title: 'Other unsaved title' }),
  ]);
  assert.deepEqual(render().baseline(1), saved);
  assert.deepEqual([...render().dirtyKeys], [1, 2]);
  render().update(1, { title: 'Submitted', isActive: true });
  assert.deepEqual([...render().dirtyKeys], [2]);
});

test('collection hydration merges clean fields without erasing local row drafts', () => {
  const render = collection();
  render().hydrate([row(1), row(2), row(3)]);
  render().update(1, { title: 'Unsaved title' });
  render().update(2, { imageUrl: '/unsaved.png' });
  render().hydrate([row(1, { title: 'Server title', imageUrl: '/server.png' }), row(2), row(3, { isActive: false }), row(4)]);
  assert.deepEqual(render().items, [
    row(1, { title: 'Unsaved title', imageUrl: '/server.png' }),
    row(2, { imageUrl: '/unsaved.png' }), row(3, { isActive: false }), row(4),
  ]);
  assert.deepEqual([...render().dirtyKeys], [1, 2]);
});

test('a later read omitting rows retains unsaved rows but drops clean missing rows', () => {
  const render = collection();
  render().hydrate([row(1), row(2), row(3)]);
  render().update(1, { title: 'Do not lose me' });
  render().hydrate([row(3)]);
  assert.deepEqual(render().items, [row(3), row(1, { title: 'Do not lose me' })]);
  assert.deepEqual(render().baseline(1), row(1));
  assert.equal(render().baseline(2), undefined);
  assert.deepEqual([...render().dirtyKeys], [1]);
});

test('partial reorder acknowledgements update order only and keep title drafts dirty', () => {
  const render = collection();
  render().hydrate([row(1), row(2), row(3)]);
  render().update(1, { title: 'Unsaved title' });
  const first = render().items[0], second = render().items[1];
  render().accept(first, { ...first, sortOrder: 2 }, ['sortOrder']);
  // Only successful batch writes are acknowledged; row 2's failed write is not.
  assert.equal(render().items[0].sortOrder, 2);
  assert.equal(render().items[1].sortOrder, second.sortOrder);
  assert.equal(render().baseline(1)?.title, 'Title 1');
  assert.equal(render().baseline(1)?.sortOrder, 2);
  assert.equal(render().items[0].title, 'Unsaved title');
  assert.deepEqual([...render().dirtyKeys], [1]);
  render().accept(second, { ...second, sortOrder: 1 }, ['sortOrder']);
  assert.equal(render().items[1].sortOrder, 1);
  assert.deepEqual([...render().dirtyKeys], [1]);
});

test('removing a confirmed row removes only that row and its baseline', () => {
  const render = collection();
  render().hydrate([row(1), row(2), row(3)]);
  render().update(2, { title: 'Keep draft' });
  render().remove(1);
  assert.deepEqual(render().items, [row(2, { title: 'Keep draft' }), row(3)]);
  assert.equal(render().baseline(1), undefined);
  assert.deepEqual(render().baseline(2), row(2));
  assert.deepEqual([...render().dirtyKeys], [2]);
  render().remove(999);
  assert.equal(render().items.length, 2);
});

test('accepting a newly created row appends it cleanly without resetting existing edits', () => {
  const render = collection();
  render().hydrate([row(1)]);
  render().update(1, { title: 'Keep existing draft' });
  render().accept(row(2), row(2));
  assert.deepEqual(render().items, [row(1, { title: 'Keep existing draft' }), row(2)]);
  assert.deepEqual([...render().dirtyKeys], [1]);
});

test('multiple updates before React renders use current state rather than a stale render closure', () => {
  const render = collection();
  const actions = render();
  actions.hydrate([row(1), row(2)]);
  actions.update(1, { title: 'First edit' });
  actions.update(2, { title: 'Second edit' });
  assert.deepEqual(render().items, [row(1, { title: 'First edit' }), row(2, { title: 'Second edit' })]);
  const fixture = hooks();
  const draft = () => fixture.render((helper) => helper.useAdminDraft({ count: 0 }));
  const setter = draft().setValue;
  setter((value) => ({ count: value.count + 1 }));
  setter((value) => ({ count: value.count + 1 }));
  assert.equal(draft().value.count, 2);
});

test('draft action identities stay stable after renders so data-load effects do not loop', () => {
  const render = collection();
  const first = render();
  first.hydrate([row(1)]);
  const second = render();
  for (const key of ['hydrate', 'update', 'accept', 'remove', 'baseline'] as const) {
    assert.equal(first[key], second[key], key);
  }
});

test('string-keyed price-group drafts preserve other groups on acknowledgement', () => {
  const fixture = hooks();
  const keyOf = (item: { title: string; imageUrl: string; productCount: number }) => item.title;
  const render = () => fixture.render((helper) => helper.useAdminDraftCollection(keyOf));
  render().hydrate([{ title: 'A', imageUrl: '/a.png', productCount: 2 }, { title: 'B', imageUrl: '/b.png', productCount: 3 }]);
  render().update('A', { imageUrl: '/new-a.png' });
  render().update('B', { imageUrl: '/new-b.png' });
  const saved = render().items[0];
  render().accept(saved, { ...saved, productCount: 4 });
  assert.deepEqual([...render().dirtyKeys], ['B']);
  assert.equal(render().items[1].imageUrl, '/new-b.png');
});

test('semantic equality ignores object key insertion order but preserves array order', () => {
  const { sameDraftValue } = hooks().helpers;
  assert.equal(sameDraftValue({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.equal(sameDraftValue({ nested: { a: 1, b: 2 } }, { nested: { b: 2, a: 1 } }), true);
  assert.equal(sameDraftValue([1, 2], [2, 1]), false);
});

test('reordered JSON keys in a server response do not mark a clean row dirty', () => {
  const render = collection();
  const initial = row(1);
  render().hydrate([initial]);
  render().hydrate([{ isActive: true, sortOrder: 1, imageUrl: '/image1.png', title: 'Title 1', id: 1 }]);
  assert.deepEqual(render().items, [initial]);
  assert.equal(render().dirtyKeys.size, 0);
});

test('browser workspace restores a dirty setting and baseline after remount', () => {
  const fixture = hooks(true);
  const render = () => fixture.render((helper) => helper.useAdminDraft({ phone: '', email: '' }, 'admin:1:settings'));
  render().hydrate({ phone: 'Server phone', email: 'Server email' });
  render().setValue((value) => ({ ...value, phone: 'Unsaved phone' }));
  fixture.remount();
  const beforeLayout = fixture.renderWithoutEffects((helper) => helper.useAdminDraft({ phone: '', email: '' }, 'admin:1:settings'));
  assert.deepEqual(beforeLayout.value, { phone: '', email: '' }, 'first render matches server HTML before cache restoration');
  assert.deepEqual(render().value, { phone: 'Unsaved phone', email: 'Server email' });
  assert.equal(render().dirty, true);
  render().hydrate({ phone: 'New server phone', email: 'New server email' });
  assert.deepEqual(render().value, { phone: 'Unsaved phone', email: 'New server email' });
  render().setValue((value) => ({ ...value, phone: 'New server phone' }));
  assert.equal(render().dirty, false);
});

test('browser workspace restores collection edits with a fresh three-way server merge', () => {
  const fixture = hooks(true), key = (item: Row) => item.id;
  const render = () => fixture.render((helper) => helper.useAdminDraftCollection(key, 'admin:1:slides'));
  render().hydrate([row(1), row(2)]);
  render().update(1, { title: 'Unsaved title' });
  fixture.remount();
  assert.deepEqual(render().items, [row(1, { title: 'Unsaved title' }), row(2)]);
  assert.deepEqual(render().baseline(1), row(1));
  render().hydrate([row(1, { imageUrl: '/fresh.png' }), row(2, { title: 'Server update' })]);
  assert.deepEqual(render().items, [row(1, { title: 'Unsaved title', imageUrl: '/fresh.png' }), row(2, { title: 'Server update' })]);
  assert.deepEqual([...render().dirtyKeys], [1]);
});

test('workspace namespaces isolate users and logout clears only the exact prefix', () => {
  const fixture = hooks(true);
  const render = (scope: string) => fixture.render((helper) => helper.useAdminDraft({ title: '' }, scope));
  render('admin:1:news').setValue({ title: 'User one draft' });
  fixture.remount();
  assert.equal(render('admin:10:news').value.title, '');
  render('admin:10:news').setValue({ title: 'User ten draft' });
  fixture.helpers.discardAdminDraftWorkspace('admin:1');
  fixture.remount();
  assert.equal(render('admin:1:news').value.title, '');
  fixture.remount();
  assert.equal(render('admin:10:news').value.title, 'User ten draft');
  fixture.helpers.discardAdminDraftWorkspace('admin:10:');
  fixture.remount();
  assert.equal(render('admin:10:news').value.title, '');
});

test('a session scope change restores only that user and ignores an old callback', () => {
  const fixture = hooks(true);
  const render = (scope?: string) => fixture.render((helper) => helper.useAdminDraft({ title: '' }, scope));
  render('admin:1:news').setValue({ title: 'User one draft' });
  const old = render('admin:1:news').setValue;
  assert.equal(render('admin:2:news').value.title, '');
  render('admin:2:news').setValue({ title: 'User two draft' });
  old({ title: 'Late user one response' });
  assert.equal(render('admin:2:news').value.title, 'User two draft');
  assert.equal(render('admin:1:news').value.title, 'User one draft');
  old({ title: 'Stale response after leaving and returning to user one' });
  assert.equal(render('admin:1:news').value.title, 'User one draft');
  assert.equal(render().value.title, '');
});

test('the first-render hydration callback remains usable after the layout restore', () => {
  const fixture = hooks(true);
  const render = (helper: Helpers) => helper.useAdminDraft({ phone: '' }, 'admin:1:settings');
  const firstRender = fixture.renderWithoutEffects(render);
  fixture.render(render);
  firstRender.hydrate({ phone: 'Initial server read' });
  assert.equal(fixture.render(render).value.phone, 'Initial server read');
  assert.equal(fixture.render(render).dirty, false);
});

test('server rendering never shares scoped draft state between mounts', () => {
  const fixture = hooks();
  const render = () => fixture.render((helper) => helper.useAdminDraft({ title: '' }, 'admin:1:news'));
  render().setValue({ title: 'Must not leak through server module memory' });
  fixture.remount();
  assert.equal(render().value.title, '');
  assert.equal(render().dirty, false);
});

test('logout invalidates late callbacks without freezing a different workspace', () => {
  const fixture = hooks(true);
  const render = () => fixture.render((helper) => ({
    one: helper.useAdminDraft({ title: '' }, 'admin:1:news'),
    ten: helper.useAdminDraft({ title: '' }, 'admin:10:news'),
  }));
  render().one.setValue({ title: 'User one draft' });
  render().ten.setValue({ title: 'User ten draft' });
  const stale = render().one.hydrate;
  fixture.helpers.discardAdminDraftWorkspace('admin:1');
  stale({ title: 'Late server response after logout' });
  render().ten.setValue({ title: 'Still editable' });
  fixture.remount();
  assert.equal(render().one.value.title, '');
  assert.equal(render().ten.value.title, 'Still editable');
});
