import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

type State = Record<string, unknown>;
type Form = Record<string, (...args: unknown[]) => unknown>;

function fixture(hookName: string, options: { fetch: typeof fetch; reload?: () => Promise<void>; timeoutMs?: number }) {
  let cursor = 0;
  const slots: unknown[] = [], cleanups: Array<() => void> = [];
  const busy: boolean[] = [], messages: string[] = [];
  const sharedLock = { current: false };
  const react = {
    useState(initial: unknown) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (next: unknown) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }];
    },
    useRef(initial: unknown) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot];
    },
    useEffect(effect: () => (() => void) | undefined) {
      const slot = cursor++;
      if (!(slot in slots)) { slots[slot] = true; const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
    },
  };
  const cache: State = { react };
  const load = (name: string): State => {
    if (name in cache) return cache[name] as State;
    const filename = name.startsWith('@/') ? `src/${name.slice(2)}.ts` : `src/features/admin/model/${name}.ts`;
    const source = readFileSync(filename, 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports: State = {};
    new Function('require', 'exports', 'fetch', 'window', 'confirm', code)(
      (dependency: string) => load(dependency.startsWith('./') ? dependency.slice(2) : dependency), exports,
      options.fetch, { setTimeout: () => 1 }, () => true,
    );
    if (filename.endsWith('/adminRequest.ts')) {
      const original = exports.adminRequest as (url: string, init: RequestInit, requestOptions: State) => Promise<Response>;
      exports.adminRequest = (url: string, init: RequestInit, requestOptions: State) => original(url, init, { ...requestOptions, timeoutMs: options.timeoutMs ?? 20 });
      const originalRun = exports.runWithRequestTimeout as (work: unknown, requestOptions: State) => Promise<unknown>;
      exports.runWithRequestTimeout = (work: unknown, requestOptions: State) => originalRun(work, { ...requestOptions, timeoutMs: options.timeoutMs ?? 20 });
    }
    cache[name] = exports;
    return exports;
  };
  const hook = load(hookName)[hookName] as (options: State) => Form;
  const render = () => {
    cursor = 0;
    return hook({ actionLock: sharedLock, setBusy: (value: boolean) => busy.push(value), showStatus: (value: string) => messages.push(value), reloadAdminData: options.reload ?? (async () => {}) });
  };
  return { render, busy, messages, sharedLock, unmount: () => cleanups.forEach((cleanup) => cleanup()) };
}

const cases = [
  ['useAdminSlides', 'saveSlide', { id: 1, title: 'Draft', imageUrl: '/slide.png' }],
  ['useAdminNews', 'saveNews', { id: 2, title: 'Draft', imageUrl: '/news.png' }],
  ['useAdminGroupCompanies', 'saveGroupCompany', { id: 3, imageUrl: '/company.png' }],
  ['useAdminBrandPortfolio', 'saveBrand', { id: 4, name: 'Draft', categoryId: 1 }],
  ['useAdminPriceGroups', 'savePriceGroup', { title: 'Draft', imageUrl: '/group.png' }],
] as const;

for (const [hook, save, draft] of cases) {
  test(`${hook}: network rejection always releases busy and reports uncertain outcome`, async () => {
    const view = fixture(hook, { fetch: async () => { throw new TypeError('offline'); } });
    await view.render()[save](draft);
    assert.deepEqual(view.busy, [true, false]);
    assert.equal(view.sharedLock.current, false);
    assert.match(view.messages[0], /могло сохраниться/);
  });
  test(`${hook}: hung fetch is bounded, aborted, and double click does not send twice`, async () => {
    let attempts = 0, signal: AbortSignal | undefined;
    const view = fixture(hook, { fetch: async (_url, init) => { attempts++; signal = init?.signal ?? undefined; return new Promise(() => {}); } });
    const form = view.render();
    await Promise.all([form[save](draft), form[save](draft)]);
    assert.equal(attempts, 1);
    assert.equal(signal?.aborted, true);
    assert.deepEqual(view.busy, [true, false]);
    assert.match(view.messages[0], /проверьте результат/);
  });
  test(`${hook}: confirmed save plus failed reload is not reported as failed save`, async () => {
    const view = fixture(hook, { fetch: async () => Response.json({ ok: true }), reload: async () => { throw new Error('reload failed'); } });
    await view.render()[save](draft);
    assert.deepEqual(view.busy, [true, false]);
    assert.match(view.messages[0], /Изменения уже сохранены/);
    assert.doesNotMatch(view.messages[0], /^Не удалось сохранить/);
  });
}

test('slide reorder waits for every write, keeps lock while sibling is pending, and describes partial success', async () => {
  let finish!: (value: Response) => void;
  let calls = 0;
  const view = fixture('useAdminSlides', { timeoutMs: 1000, fetch: async () => {
    calls++;
    if (calls === 1) throw new TypeError('offline');
    return new Promise((resolve) => { finish = resolve; });
  } });
  view.render().setSlides([{ id: 1, sortOrder: 1 }, { id: 2, sortOrder: 2 }]);
  const form = view.render();
  const pending = form.moveSlide(1, 2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(view.busy, [true]);
  await form.saveSlide({ id: 1 });
  assert.equal(calls, 2, 'save cannot overlap a reorder');
  finish(Response.json({ ok: true }));
  await pending;
  assert.deepEqual(view.busy, [true, false]);
  assert.match(view.messages[0], /подтверждено 1 из 2/);
});

test('creation network failure retains the original draft and never reloads', async () => {
  let reloads = 0;
  const view = fixture('useAdminNews', { fetch: async () => { throw new Error('offline'); }, reload: async () => { reloads++; } });
  const draft = { title: 'Do not lose draft', imageUrl: '/selected.png', date: '2026-10-18' };
  view.render().setNewsDraft(draft);
  await view.render().createNews();
  assert.deepEqual(view.render().newsDraft, draft);
  assert.equal(reloads, 0);
});

test('confirmed save with a permanently stalled reload releases busy and warns instead of failing save', async () => {
  const view = fixture('useAdminNews', { fetch: async () => Response.json({ ok: true }), reload: async () => new Promise(() => {}) });
  await view.render().saveNews({ id: 1 });
  assert.deepEqual(view.busy, [true, false]);
  assert.match(view.messages[0], /Изменения уже сохранены/);
});

test('unmount aborts pending mutation and suppresses stale success callbacks', async () => {
  let signal: AbortSignal | undefined;
  const view = fixture('useAdminSlides', { fetch: async (_url, init) => { signal = init?.signal ?? undefined; return new Promise(() => {}); } });
  const pending = view.render().saveSlide({ id: 1 });
  view.unmount();
  await pending;
  assert.equal(signal?.aborted, true);
  assert.equal(view.sharedLock.current, false);
  assert.deepEqual(view.messages, []);
});
