import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

type PutHandler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;

function compile(filename: string, modules: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}

function route(resource: string, writer: string, denied = false) {
  const writes: unknown[][] = [];
  const revalidated: string[] = [];
  const loaded = compile(`src/app/api/admin/${resource}/route.ts`, {
    'next/cache': { revalidatePath: (path: string) => revalidated.push(path) },
    '@/shared/lib/adminAuth': { requireAdmin: async () => denied ? Response.json({ error: 'Forbidden' }, { status: 403 }) : null },
    '@/shared/lib/db': { [writer]: async (...args: unknown[]) => { writes.push(args); } },
  });
  const runRaw = (body: string) => (loaded.PUT as PutHandler)(
    new Request(`https://example.test/api/admin/${resource.replace('[id]', '17')}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body,
    }),
    { params: Promise.resolve({ id: '17' }) },
  );
  return { writes, revalidated, run: (body: unknown) => runRaw(JSON.stringify(body)), runRaw };
}

const orderedResources = [
  ['slides', 'updateHeroSlide'],
  ['news', 'updateNewsItem'],
  ['group-companies', 'updateGroupCompany'],
  ['brand-categories', 'updateBrandCategory'],
] as const;

for (const [resource, writer] of orderedResources) {
  test(`${resource}: explicit order-only update writes no content fields`, async () => {
    const api = route(`${resource}/[id]`, writer);
    const response = await api.run({ sortOrder: 3 });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(api.writes, [[17, { sortOrder: 3 }]]);
    assert.deepEqual(api.revalidated, ['/']);
  });

  test(`${resource}: order-only requests require a bounded integer without coercion`, async () => {
    for (const value of ['3', '', null, true, [], {}, -1, 0.5, 2_147_483_648]) {
      const api = route(`${resource}/[id]`, writer);
      const response = await api.run({ sortOrder: value });
      assert.equal(response.status, 400, JSON.stringify(value));
      assert.deepEqual(api.writes, []);
      assert.deepEqual(api.revalidated, []);
    }
    for (const value of [0, 2_147_483_647]) {
      const api = route(`${resource}/[id]`, writer);
      assert.equal((await api.run({ sortOrder: value })).status, 200);
    }
  });

  test(`${resource}: malformed request bodies cannot write`, async () => {
    for (const body of ['{', 'null', '[]', 'true', '"text"']) {
      const api = route(`${resource}/[id]`, writer);
      assert.equal((await api.runRaw(body)).status, 400, body);
      assert.deepEqual(api.writes, []);
      assert.deepEqual(api.revalidated, []);
    }
  });

  test(`${resource}: authorization still runs before order-only writes`, async () => {
    const api = route(`${resource}/[id]`, writer, true);
    assert.equal((await api.run({ sortOrder: 3 })).status, 403);
    assert.deepEqual(api.writes, []);
    assert.deepEqual(api.revalidated, []);
  });
}

test('slide full update retains whitespace normalization and explicit nullable field clearing', async () => {
  const api = route('slides/[id]', 'updateHeroSlide');
  assert.equal((await api.run({ title: ' Title ', imageUrl: ' /image.png ', popupTitle: ' Popup ', sortOrder: '7', isActive: false })).status, 200);
  assert.deepEqual(api.writes, [[17, {
    title: 'Title', imageUrl: '/image.png', tabletImageUrl: null, mobileImageUrl: null,
    popupImageUrl: null, popupTabletImageUrl: null, popupMobileImageUrl: null,
    popupTitle: 'Popup', popupText: null, linkUrl: null, sortOrder: 7, isActive: false,
  }]]);
});

test('news full update retains the existing field contract', async () => {
  const api = route('news/[id]', 'updateNewsItem');
  assert.equal((await api.run({ title: ' News ', imageUrl: ' /news.png ', date: ' Today ', linkUrl: ' /news ', sortOrder: '7', isActive: false })).status, 200);
  assert.deepEqual(api.writes, [[17, { title: 'News', imageUrl: '/news.png', date: 'Today', linkUrl: '/news', sortOrder: 7, isActive: false }]]);
});

test('company full update retains link normalization', async () => {
  const api = route('group-companies/[id]', 'updateGroupCompany');
  assert.equal((await api.run({ imageUrl: ' /company.png ', linkUrl: ' example.test ', sortOrder: '7', isActive: false })).status, 200);
  assert.deepEqual(api.writes, [[17, { imageUrl: '/company.png', linkUrl: 'https://example.test', sortOrder: 7, isActive: false }]]);
});

test('brand category full update retains field normalization', async () => {
  const api = route('brand-categories/[id]', 'updateBrandCategory');
  assert.equal((await api.run({ key: ' key ', title: ' Category ', sortOrder: '7', isActive: false })).status, 200);
  assert.deepEqual(api.writes, [[17, { key: 'key', title: 'Category', sortOrder: 7, isActive: false }]]);
});

for (const key of ['phone', 'email', 'address'] as const) {
  test(`settings: saving ${key} writes and returns only that field`, async () => {
    const api = route('settings', 'updateSiteSettings');
    const response = await api.run({ [key]: ' Changed value ' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { [key]: 'Changed value' });
    assert.deepEqual(api.writes, [[{ [key]: 'Changed value' }]]);
  });
}

test('settings: legacy full and multi-field updates remain supported', async () => {
  const api = route('settings', 'updateSiteSettings');
  assert.equal((await api.run({ phone: ' Phone ', email: ' Email ', address: ' Address ' })).status, 200);
  assert.equal((await api.run({ phone: ' Phone2 ', email: ' Email2 ' })).status, 200);
  assert.deepEqual(api.writes, [[{ phone: 'Phone', email: 'Email', address: 'Address' }], [{ phone: 'Phone2', email: 'Email2' }]]);
});

test('settings: invalid supplied fields reject the entire request before any write', async () => {
  for (const body of [{}, { unknown: 'text' }, { email: '' }, { email: 12 }, { email: null }, { phone: 'valid', address: '  ' }, null, []]) {
    const api = route('settings', 'updateSiteSettings');
    assert.equal((await api.run(body)).status, 400, JSON.stringify(body));
    assert.deepEqual(api.writes, []);
  }
  const api = route('settings', 'updateSiteSettings');
  assert.equal((await api.runRaw('{')).status, 400);
  assert.deepEqual(api.writes, []);
});

test('settings: partial updates do not bypass authorization', async () => {
  const api = route('settings', 'updateSiteSettings', true);
  assert.equal((await api.run({ phone: 'Phone' })).status, 403);
  assert.deepEqual(api.writes, []);
});

function slideRepository() {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const loaded = compile('src/shared/lib/db/slidesRepo.ts', {
    './schema': { ensureSiteSchema: async () => {} },
    './client': { query: async (sql: string, values: unknown[]) => { queries.push({ sql, values }); return { rows: [] }; } },
  });
  return { queries, update: loaded.updateHeroSlide as (id: number, patch: Record<string, unknown>) => Promise<void> };
}

test('slide repository order-only update never clears image, popup or link columns', async () => {
  const repo = slideRepository();
  await repo.update(17, { sortOrder: 3 });
  assert.equal(repo.queries.length, 1);
  assert.match(repo.queries[0].sql, /set sort_order = \$2/);
  assert.doesNotMatch(repo.queries[0].sql, /image_url|popup|link_url|title|is_active/);
  assert.deepEqual(repo.queries[0].values, [17, 3]);
});

test('slide repository full update still clears explicitly empty nullable fields', async () => {
  const repo = slideRepository();
  await repo.update(17, { title: 'Title', imageUrl: '/image.png', popupTitle: null, sortOrder: 3, isActive: false });
  assert.equal(repo.queries.length, 1);
  assert.match(repo.queries[0].sql, /popup_title = \$9/);
  assert.equal(repo.queries[0].values[8], null);
  assert.equal(repo.queries[0].values[11], 3);
  assert.equal(repo.queries[0].values[12], false);
});
