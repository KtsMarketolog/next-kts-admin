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
  let needsRender = false;
  const effectOnce = (effect: () => (() => void) | undefined) => {
    const slot = cursor++;
    if (!(slot in slots)) { slots[slot] = true; const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  };
  const memo = (factory: () => unknown, dependencies: unknown[]) => {
    const slot = cursor++;
    const previous = slots[slot] as { value: unknown; dependencies: unknown[] } | undefined;
    if (!previous || dependencies.some((dependency, index) => !Object.is(previous.dependencies[index], dependency))) {
      slots[slot] = { value: factory(), dependencies };
    }
    return (slots[slot] as { value: unknown }).value;
  };
  const react = {
    useState(initial: unknown) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], (next: unknown) => {
        const value = typeof next === 'function' ? next(slots[slot]) : next;
        needsRender ||= !Object.is(value, slots[slot]);
        slots[slot] = value;
      }];
    },
    useMemo: memo,
    useCallback(callback: unknown, dependencies: unknown[]) { return memo(() => callback, dependencies); },
    useRef(initial: unknown) {
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot];
    },
    useEffect: effectOnce,
    useLayoutEffect: effectOnce,
  };
  const cache: State = { react };
  const load = (name: string): State => {
    if (name in cache) return cache[name] as State;
    const filename = name.startsWith('@/') ? `src/${name.slice(2)}.ts` : `src/features/admin/model/${name}.ts`;
    if (filename in cache) return cache[filename] as State;
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
    cache[filename] = exports;
    return exports;
  };
  const hook = load(hookName)[hookName] as (options: State) => Form;
  const render = () => {
    let form: Form, passes = 0;
    do {
      cursor = 0;
      needsRender = false;
      form = hook({ actionLock: sharedLock, setBusy: (value: boolean) => busy.push(value), showStatus: (value: string) => messages.push(value), reloadAdminData: options.reload ?? (async () => {}) });
      assert.ok(++passes < 25, 'layout effects settle before user actions');
    } while (needsRender);
    return form;
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
  test(`${hook}: stalled response body is bounded and a duplicate click cannot resend the write`, async () => {
    let attempts = 0, signal: AbortSignal | undefined;
    const view = fixture(hook, { fetch: async (_url, init) => {
      attempts++; signal = init?.signal ?? undefined;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
    } });
    const form = view.render();
    await Promise.all([form[save](draft), form[save](draft)]);
    assert.equal(attempts, 1);
    assert.equal(signal?.aborted, true);
    assert.deepEqual(view.busy, [true, false]);
    assert.equal(view.sharedLock.current, false);
    assert.match(view.messages[0], /проверьте результат/);
  });
  test(`${hook}: missing acknowledgement never retries a confirmed save`, async () => {
    let reads = 0, writes = 0, reloads = 0;
    const view = fixture(hook, {
      fetch: async (_url, init) => {
        if (!init?.method || init.method === 'GET') { reads++; throw new Error('scoped read failed'); }
        writes++; return Response.json({ ok: true });
      },
      reload: async () => { reloads++; },
    });
    await view.render()[save](draft);
    assert.deepEqual(view.busy, [true, false]);
    assert.match(view.messages[0], /Изменения уже сохранены/);
    assert.doesNotMatch(view.messages[0], /^Не удалось сохранить/);
    assert.equal(reads, hook === 'useAdminPriceGroups' ? 1 : 0, 'versioned writes cannot acknowledge a later GET');
    assert.equal(writes, 1, 'failed read never retries a confirmed write');
    assert.equal(reloads, 0, 'no cross-section reload');
  });
  if (hook === 'useAdminPriceGroups') test(`${hook}: confirmed save plus stalled scoped read releases busy and aborts the read`, async () => {
    let reads = 0, writes = 0, readSignal: AbortSignal | undefined;
    const view = fixture(hook, { fetch: async (_url, init) => {
      if (!init?.method || init.method === 'GET') {
        reads++; readSignal = init?.signal ?? undefined;
        return new Promise(() => {});
      }
      writes++; return Response.json({ ok: true });
    } });
    await view.render()[save](draft);
    assert.deepEqual(view.busy, [true, false]);
    assert.equal(view.sharedLock.current, false);
    assert.match(view.messages[0], /Изменения уже сохранены/);
    assert.equal(reads, 1);
    assert.equal(writes, 1);
    assert.equal(readSignal?.aborted, true);
  });
}

const versionedCases = [
  ['useAdminSlides', 'setSlides', 'slides', 'updateSlide', 'saveSlide', 'reloadSlide', 'conflictIds', 'slides'],
  ['useAdminNews', 'setNews', 'news', 'updateNews', 'saveNews', 'reloadNews', 'conflictIds', 'news'],
  ['useAdminGroupCompanies', 'setGroupCompanies', 'groupCompanies', 'updateGroupCompany', 'saveGroupCompany', 'reloadGroupCompany', 'conflictIds', 'companies'],
  ['useAdminBrandPortfolio', 'setBrandCategories', 'brandCategories', 'updateBrandCategory', 'saveBrandCategory', 'reloadBrandCategory', 'categoryConflictIds', 'categories'],
  ['useAdminBrandPortfolio', 'setBrands', 'brands', 'updateBrand', 'saveBrand', 'reloadBrand', 'brandConflictIds', 'brands'],
] as const;

for (const [hook, hydrate, rowsKey, update, save, reload, conflictsKey, listKey] of versionedCases) {
  const initial = { id: 1, revision: '1', title: 'Original', name: 'Original', imageUrl: '/one.png', isActive: true };
  const sibling = { ...initial, id: 2 };
  const rows = (view: ReturnType<typeof fixture>) => view.render()[rowsKey] as unknown as Array<typeof initial>;
  test(`${hook}/${save}: stale save preserves drafts and reload explicitly replaces only the conflicting row`, async () => {
    let gets = 0, writes = 0;
    const saved = { ...initial, revision: '2', isActive: false };
    const view = fixture(hook, { fetch: async (_url, init) => {
      if (!init?.method || init.method === 'GET') { gets++; return Response.json({ [listKey]: [saved, sibling] }); }
      writes++;
      assert.equal(JSON.parse(String(init.body)).revision, '1');
      return Response.json({ error: 'Данные уже изменены другим пользователем' }, { status: 409 });
    } });
    view.render()[hydrate]([initial, sibling]);
    view.render()[update](1, { title: 'My title', name: 'My title' });
    view.render()[update](2, { title: 'Other draft', name: 'Other draft' });
    await view.render()[save](rows(view)[0]);
    assert.equal(rows(view)[0].title, 'My title');
    assert.equal(rows(view)[0].revision, '1');
    assert.equal(rows(view)[0].isActive, true, 'keep the stale draft; never silently rebase');
    assert.equal(view.render().dirtyCount as unknown, 2);
    assert.equal((view.render()[conflictsKey] as unknown as Set<number>).has(1), true);
    assert.equal(gets, 0, 'conflict never silently refreshes');
    await view.render()[reload](1);
    assert.deepEqual(rows(view)[0], saved);
    assert.equal(rows(view)[1].title, 'Other draft');
    assert.equal(view.render().dirtyCount as unknown, 1);
    assert.equal((view.render()[conflictsKey] as unknown as Set<number>).has(1), false);
    assert.equal(gets, 1); assert.equal(writes, 1);
    assert.deepEqual(view.busy, [true, false, true, false]);
  });

  test(`${hook}/${save}: exact response revision is used and late typing survives`, async () => {
    let finish!: (response: Response) => void;
    const calls: string[] = [];
    const view = fixture(hook, { timeoutMs: 1000, fetch: async (_url, init) => {
      calls.push(init?.method ?? 'GET');
      return new Promise((resolve) => { finish = resolve; });
    } });
    view.render()[hydrate]([initial, sibling]);
    view.render()[update](1, { title: ' Submitted ', name: ' Submitted ' });
    const submitted = rows(view)[0];
    const pending = view.render()[save](submitted);
    view.render()[update](1, { title: 'New typing', name: 'New typing' });
    finish(Response.json({ ok: true, item: { ...submitted, title: 'Submitted', name: 'Submitted', revision: '2' } }));
    await pending;
    assert.equal(rows(view)[0].title, 'New typing');
    assert.equal(rows(view)[0].revision, '2');
    assert.equal(view.render().dirtyCount as unknown, 1);
    assert.deepEqual(calls, ['PUT'], 'a follow-up read could capture a newer competing revision');
    view.render()[hydrate]([{ ...initial, revision: '3', isActive: false }, sibling]);
    assert.equal(rows(view)[0].revision, '2');
    assert.equal(rows(view)[0].isActive, true);
  });
}

const reorders = [
  ['useAdminSlides', 'setSlides', 'slides', 'moveSlide', 'updateSlide', '/api/admin/slides/reorder'],
  ['useAdminNews', 'setNews', 'news', 'moveNews', 'updateNews', '/api/admin/news/reorder'],
  ['useAdminGroupCompanies', 'setGroupCompanies', 'groupCompanies', 'moveGroupCompany', 'updateGroupCompany', '/api/admin/group-companies/reorder'],
  ['useAdminBrandPortfolio', 'setBrandCategories', 'brandCategories', 'moveBrandCategory', 'updateBrandCategory', '/api/admin/brand-categories/reorder'],
] as const;
const originalOrder = [{ id: 1, sortOrder: 1, title: 'One' }, { id: 2, sortOrder: 2, title: 'Two' }];
const requestedOrder = [{ id: 2, sortOrder: 1 }, { id: 1, sortOrder: 2 }];

for (const [hook, hydrate, rowsKey, move, update, endpoint] of reorders) {
  test(`${hook}: one atomic reorder, no optimistic update, shared lock and late text draft preserved`, async () => {
    let finish!: (value: Response) => void;
    const calls: Array<{ url: string; body: unknown }> = [];
    const view = fixture(hook, { timeoutMs: 1000, fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Promise((resolve) => { finish = resolve; });
    } });
    view.render()[hydrate](originalOrder);
    view.render()[update](2, { title: 'Other draft' });
    const form = view.render();
    const pending = form[move](1, 2);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(view.busy, [true]);
    await form[move](1, 2);
    assert.deepEqual(calls, [{ url: endpoint, body: { items: requestedOrder } }]);
    assert.deepEqual((view.render()[rowsKey] as unknown as typeof originalOrder).map(({ id }) => id), [1, 2]);
    view.render()[update](1, { title: 'Typed while saving' });
    finish(Response.json({ ok: true, items: requestedOrder }));
    await pending;
    const rows = view.render()[rowsKey] as unknown as typeof originalOrder;
    assert.deepEqual(rows.map(({ id }) => id), [2, 1]);
    assert.equal(rows[0].title, 'Other draft');
    assert.equal(rows[1].title, 'Typed while saving');
    assert.deepEqual(view.busy, [true, false]);
    assert.equal(view.sharedLock.current, false);
    assert.equal(view.render().dirtyCount as unknown, 2);
  });

  for (const scenario of ['rejected', 'conflict', 'commit-unknown', 'network', 'timeout', 'invalid-json', 'missing-ack', 'truncated-ack', 'duplicate-ack', 'wrong-position', 'extra-item']) {
    test(`${hook}: ${scenario} never acknowledges part of an order or retries`, async () => {
      let calls = 0;
      const view = fixture(hook, { fetch: async () => {
        calls++;
        if (scenario === 'rejected') return Response.json({ error: 'Order rejected' }, { status: 500 });
        if (scenario === 'conflict') return Response.json({ error: 'Collection changed' }, { status: 409 });
        if (scenario === 'commit-unknown') return Response.json({ code: 'COMMIT_OUTCOME_UNKNOWN', saveState: 'unknown', error: 'Commit outcome unknown; verify before retrying' }, { status: 503 });
        if (scenario === 'network') throw new TypeError('offline');
        if (scenario === 'timeout') return new Promise(() => {});
        if (scenario === 'invalid-json') return new Response('{broken', { status: 200 });
        const items = scenario === 'truncated-ack' ? requestedOrder.slice(0, 1)
          : scenario === 'duplicate-ack' ? [requestedOrder[0], requestedOrder[0]]
          : scenario === 'wrong-position' ? originalOrder
          : scenario === 'extra-item' ? [...requestedOrder, { id: 3, sortOrder: 3 }]
          : undefined;
        return Response.json({ ok: true, items });
      } });
      view.render()[hydrate](originalOrder);
      await view.render()[move](1, 2);
      assert.deepEqual(view.render()[rowsKey], originalOrder);
      assert.equal(view.render().dirtyCount as unknown, 0);
      assert.equal(calls, 1);
      assert.deepEqual(view.busy, [true, false]);
      assert.equal(view.sharedLock.current, false);
      assert.ok(view.messages.length > 0);
      if (scenario === 'network' || scenario === 'timeout') assert.match(view.messages[0], /могло сохраниться/);
      if (scenario === 'commit-unknown') assert.match(view.messages[0], /Commit outcome unknown/);
      if (scenario.includes('ack') || ['invalid-json', 'wrong-position', 'extra-item'].includes(scenario)) assert.match(view.messages[0], /не подтвердил.*мог сохраниться/);
    });
  }
}

test('creation network failure retains the original draft and never reloads', async () => {
  let reloads = 0;
  const view = fixture('useAdminNews', { fetch: async () => { throw new Error('offline'); }, reload: async () => { reloads++; } });
  const draft = { title: 'Do not lose draft', imageUrl: '/selected.png', date: '2026-10-18' };
  view.render().setNewsDraft(draft);
  await view.render().createNews();
  assert.deepEqual(view.render().newsDraft, draft);
  assert.equal(reloads, 0);
});

test('successful content mutation reports cache-refresh warning without losing acknowledgement', async () => {
  const saved = { id: 1, revision: '2', title: 'Saved', isActive: false };
  const view = fixture('useAdminNews', { fetch: async () => Response.json({
    ok: true, item: saved, warnings: ['Обновление кеша требует повторения.'],
  }) });
  view.render().setNews([{ ...saved, revision: '1', title: 'Old' }]);
  view.render().updateNews(1, { title: 'Saved' });
  await view.render().saveNews({ ...saved, revision: '1' });
  assert.match(view.messages[0], /Новость сохранена.*Обновление кеша требует повторения/);
  assert.deepEqual(view.render().news, [saved]);
  assert.equal(view.render().dirtyCount as unknown, 0);
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
