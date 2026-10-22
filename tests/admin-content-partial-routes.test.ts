import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as recordVersion from '../src/shared/lib/recordVersion';

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

function route(resource: string, writer: string, denied = false, failure?: Error, revalidationFails = false) {
  const writes: unknown[][] = [];
  const revalidated: string[] = [];
  const cache = { revalidatePath: (path: string) => {
    if (revalidationFails) throw new Error('Synthetic cache failure');
    revalidated.push(path);
  } };
  const versionedSave = compile('src/shared/lib/adminContentSave.ts', {
    'next/cache': cache,
    './recordVersion': recordVersion,
  });
  const loaded = compile(`src/app/api/admin/${resource}/route.ts`, {
    'next/cache': cache,
    '@/shared/lib/adminContentSave': versionedSave,
    '@/shared/lib/adminAuth': { requireAdmin: async () => denied ? Response.json({ error: 'Forbidden' }, { status: 403 }) : null },
    '@/shared/lib/db': { [writer]: async (...args: unknown[]) => {
      writes.push(args);
      if (failure) throw failure;
      return { id: args[0], ...args[1] as object, revision: '2' };
    } },
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
  test(`${resource}: old per-row reorder is refused without any write`, async () => {
    const api = route(`${resource}/[id]`, writer);
    const response = await api.run({ sortOrder: 3 });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'ATOMIC_REORDER_REQUIRED');
    assert.deepEqual(api.writes, []);
    assert.deepEqual(api.revalidated, []);
  });

  test(`${resource}: a revision cannot disguise a non-atomic reorder as a content save`, async () => {
    const api = route(`${resource}/[id]`, writer);
    const response = await api.run({ sortOrder: 3, revision: '1' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'ATOMIC_REORDER_REQUIRED');
    assert.deepEqual(api.writes, []);
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
      assert.equal((await api.run({ sortOrder: value })).status, 409);
      assert.deepEqual(api.writes, []);
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
  assert.equal((await api.run({ revision: '1', title: ' Title ', imageUrl: ' /image.png ', popupTitle: ' Popup ', sortOrder: '7', isActive: false })).status, 200);
  assert.deepEqual(api.writes, [[17, {
    title: 'Title', imageUrl: '/image.png', tabletImageUrl: null, mobileImageUrl: null,
    popupImageUrl: null, popupTabletImageUrl: null, popupMobileImageUrl: null,
    popupTitle: 'Popup', popupText: null, linkUrl: null, isActive: false,
  }, '1']]);
});

test('news full update retains the existing field contract', async () => {
  const api = route('news/[id]', 'updateNewsItem');
  assert.equal((await api.run({ revision: '1', title: ' News ', imageUrl: ' /news.png ', date: ' Today ', linkUrl: ' /news ', sortOrder: '7', isActive: false })).status, 200);
  assert.deepEqual(api.writes, [[17, { title: 'News', imageUrl: '/news.png', date: 'Today', linkUrl: '/news', isActive: false }, '1']]);
});

test('company full update retains link normalization', async () => {
  const api = route('group-companies/[id]', 'updateGroupCompany');
  assert.equal((await api.run({ revision: '1', imageUrl: ' /company.png ', linkUrl: ' example.test ', sortOrder: '7', isActive: false })).status, 200);
  assert.deepEqual(api.writes, [[17, { imageUrl: '/company.png', linkUrl: 'https://example.test', isActive: false }, '1']]);
});

test('brand category full update retains field normalization', async () => {
  const api = route('brand-categories/[id]', 'updateBrandCategory');
  assert.equal((await api.run({ revision: '1', key: ' key ', title: ' Category ', sortOrder: '7', isActive: false })).status, 200);
  assert.deepEqual(api.writes, [[17, { key: 'key', title: 'Category', isActive: false }, '1']]);
});

for (const [resource, writer] of [...orderedResources, ['brands', 'updateBrandItem']] as const) {
  const body = { title: 'Title', name: 'Brand', categoryId: 1, imageUrl: '/image.png', isActive: true };
  test(`${resource}: missing/invalid revision fails closed before writes`, async () => {
    for (const revision of [undefined, null, 1, '', '0', '01', '-1', '1.2', '9223372036854775808']) {
      const api = route(`${resource}/[id]`, writer);
      const response = await api.run({ ...body, revision });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'RECORD_VERSION_CONFLICT');
      assert.deepEqual(api.writes, []);
      assert.deepEqual(api.revalidated, []);
    }
  });
  test(`${resource}: stale revision produces conflict without success or cache changes`, async () => {
    const api = route(`${resource}/[id]`, writer, false, new recordVersion.RecordVersionConflictError());
    const response = await api.run({ ...body, revision: '1' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'RECORD_VERSION_CONFLICT');
    assert.equal(api.writes[0][2], '1');
    assert.deepEqual(api.revalidated, []);
  });
  test(`${resource}: returns exact saved item and revision for form acknowledgement`, async () => {
    const api = route(`${resource}/[id]`, writer);
    const response = await api.run({ ...body, revision: '1' });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.ok, true);
    assert.equal(data.item.revision, '2');
    assert.equal(data.item.id, 17);
    assert.equal(data.item.isActive, true);
    assert.deepEqual(api.revalidated, ['/']);
  });
  test(`${resource}: authorization runs before valid versioned update`, async () => {
    const api = route(`${resource}/[id]`, writer, true);
    assert.equal((await api.run({ ...body, revision: '1' })).status, 403);
    assert.deepEqual(api.writes, []);
  });
  test(`${resource}: cache failure does not hide a successful commit or its revision`, async () => {
    const api = route(`${resource}/[id]`, writer, false, undefined, true);
    const response = await api.run({ ...body, revision: '1' });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.item.revision, '2');
    assert.match(data.warnings[0], /сохранена/);
  });
}

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
    '../recordVersion': recordVersion,
    './schema': { ensureSiteSchema: async () => {} },
    './client': { query: async (sql: string, values: unknown[]) => { queries.push({ sql, values }); return { rows: [{ id: '17', revision: '2' }] }; } },
  });
  return { queries, update: loaded.updateHeroSlide as (id: number, patch: Record<string, unknown>, revision: string) => Promise<unknown> };
}

test('slide repository order-only update never clears image, popup or link columns', async () => {
  const repo = slideRepository();
  await repo.update(17, { sortOrder: 3 }, '1');
  assert.equal(repo.queries.length, 1);
  assert.match(repo.queries[0].sql, /set sort_order = \$2/);
  assert.doesNotMatch(repo.queries[0].sql.split('returning')[0], /image_url|popup|link_url|title|is_active/);
  assert.deepEqual(repo.queries[0].values, [17, 3, '1']);
});

test('slide repository full update still clears explicitly empty nullable fields', async () => {
  const repo = slideRepository();
  await repo.update(17, { title: 'Title', imageUrl: '/image.png', popupTitle: null, sortOrder: 3, isActive: false }, '1');
  assert.equal(repo.queries.length, 1);
  assert.match(repo.queries[0].sql, /popup_title = \$9/);
  assert.equal(repo.queries[0].values[8], null);
  assert.equal(repo.queries[0].values[11], 3);
  assert.equal(repo.queries[0].values[12], false);
});
