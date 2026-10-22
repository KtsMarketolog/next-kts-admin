import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as recordVersion from '../src/shared/lib/recordVersion';

type ContentRecord = Record<string, unknown> & { id: number; revision: string };
type ContentRepo = Record<string, (...args: unknown[]) => Promise<ContentRecord | ContentRecord[]>>;
type Fixture = {
  file: string;
  table: string;
  getter: string;
  writer: string;
  row: Record<string, unknown>;
  expected: ContentRecord;
  fields: Record<string, unknown>;
};

const revision = '9007199254740993';
const commonRow = { id: '17', revision, sort_order: 8, is_active: false };
const commonItem = { id: 17, revision, sortOrder: 8, isActive: false };
const fixtures: Fixture[] = [
  {
    file: 'newsRepo', table: 'news_items', getter: 'getNewsItems', writer: 'updateNewsItem',
    row: { ...commonRow, date_label: 'Today', title: 'Saved news', image_url: '/news.jpg', link_url: '/news' },
    expected: { ...commonItem, date: 'Today', title: 'Saved news', imageUrl: '/news.jpg', linkUrl: '/news' },
    fields: { title: 'Submitted news', isActive: false },
  },
  {
    file: 'slidesRepo', table: 'hero_slides', getter: 'getHeroSlides', writer: 'updateHeroSlide',
    row: {
      ...commonRow, title: 'Saved slide', image_url: '/slide.jpg', tablet_image_url: '/tablet.jpg',
      mobile_image_url: '/mobile.jpg', popup_image_url: '/popup.jpg', popup_tablet_image_url: null,
      popup_mobile_image_url: null, popup_title: 'Popup', popup_text: 'Saved text', link_url: null,
    },
    expected: {
      ...commonItem, title: 'Saved slide', imageUrl: '/slide.jpg', tabletImageUrl: '/tablet.jpg',
      mobileImageUrl: '/mobile.jpg', popupImageUrl: '/popup.jpg', popupTabletImageUrl: null,
      popupMobileImageUrl: null, popupTitle: 'Popup', popupText: 'Saved text', linkUrl: null,
    },
    fields: { title: 'Submitted slide', isActive: false, popupTitle: null },
  },
  {
    file: 'brandPortfolioRepo', table: 'brand_categories', getter: 'getBrandCategories', writer: 'updateBrandCategory',
    row: { ...commonRow, key: 'saved', title: 'Saved category' },
    expected: { ...commonItem, key: 'saved', title: 'Saved category' },
    fields: { key: 'submitted', title: 'Submitted category', isActive: false },
  },
  {
    file: 'brandPortfolioRepo', table: 'brand_items', getter: 'getBrandItems', writer: 'updateBrandItem',
    row: { ...commonRow, category_id: '5', name: 'Saved brand', image_url: '/brand.jpg', icon_key: 'saved-icon' },
    expected: { ...commonItem, categoryId: 5, name: 'Saved brand', imageUrl: '/brand.jpg', iconKey: 'saved-icon' },
    fields: { categoryId: 5, name: 'Submitted brand', sortOrder: 8, isActive: false },
  },
  {
    file: 'groupCompaniesRepo', table: 'group_companies', getter: 'getGroupCompanies', writer: 'updateGroupCompany',
    row: { ...commonRow, image_url: '/company.jpg', link_url: 'https://example.test/' },
    expected: { ...commonItem, imageUrl: '/company.jpg', linkUrl: 'https://example.test/' },
    fields: { imageUrl: '/submitted.jpg', linkUrl: 'https://example.test/', isActive: false },
  },
];

/** Compile only a repository; every IO edge is a stub and unknown imports fail. */
function repo(fixture: Fixture, rows: Record<string, unknown>[] = [fixture.row], failure?: Error) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  let schemaChecks = 0;
  const modules: Record<string, unknown> = {
    '../recordVersion': recordVersion,
    './schema': { ensureSiteSchema: async () => { schemaChecks++; } },
    './client': {
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (failure) throw failure;
        return { rows, rowCount: rows.length };
      },
    },
  };
  const source = readFileSync(new URL(`../src/shared/lib/db/${fixture.file}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} as ContentRepo };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    assert.ok(name in modules, `Unexpected repository dependency: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  return { api: loaded.exports, queries, schemaChecks: () => schemaChecks };
}

for (const fixture of fixtures) {
  test(`${fixture.table}: reads include exact bigint revision and all saved fields`, async () => {
    const loaded = repo(fixture);
    assert.deepEqual(await loaded.api[fixture.getter](), [fixture.expected]);
    assert.equal(loaded.schemaChecks(), 1);
    assert.equal(loaded.queries.length, 1);
    assert.match(loaded.queries[0].sql, /select id, revision::text,/);
    assert.match(loaded.queries[0].sql, new RegExp(`from ${fixture.table}\\b`));
    assert.match(loaded.queries[0].sql, /order by/);
    assert.doesNotMatch(loaded.queries[0].sql, /where is_active/);

    await loaded.api[fixture.getter]({ activeOnly: true });
    assert.match(loaded.queries[1].sql, /where is_active = true/);
  });

  test(`${fixture.table}: update compares revision atomically and returns exactly the committed row`, async () => {
    const loaded = repo(fixture);
    const expectedRevision = '9007199254740992';
    const saved = await loaded.api[fixture.writer](17, fixture.fields, expectedRevision);
    assert.deepEqual(saved, fixture.expected);
    assert.equal(loaded.schemaChecks(), 1);
    assert.equal(loaded.queries.length, 1, 'No pre-read or follow-up read can replace the CAS acknowledgement');
    const { sql, params } = loaded.queries[0];
    assert.match(sql, new RegExp(`^update ${fixture.table}\\b`));
    assert.match(sql, /where id = \$1 and revision = \$\d+::bigint\s+returning id, revision::text,/);
    assert.equal(params?.[0], 17);
    assert.equal(params?.at(-1), expectedRevision);
    assert.equal(typeof params?.at(-1), 'string', 'Never round a bigint through a JavaScript number');
    assert.ok(params?.includes(false), 'Explicit disabled state must not be discarded by truthiness');
  });

  test(`${fixture.table}: invalid or missing revision fails before all database IO`, async () => {
    for (const expected of [undefined, null, 1, '', '0', '01', '-1', '1.2', ' 1', '9223372036854775808']) {
      const loaded = repo(fixture);
      await assert.rejects(loaded.api[fixture.writer](17, fixture.fields, expected), recordVersion.RecordVersionConflictError);
      assert.equal(loaded.schemaChecks(), 0);
      assert.deepEqual(loaded.queries, []);
    }
  });

  test(`${fixture.table}: stale or deleted rows cannot report a successful save`, async () => {
    const loaded = repo(fixture, []);
    await assert.rejects(loaded.api[fixture.writer](17, fixture.fields, '1'), (error: unknown) => {
      assert.ok(error instanceof recordVersion.RecordVersionConflictError);
      assert.equal(error.code, 'RECORD_VERSION_CONFLICT');
      assert.equal(error.status, 409);
      return true;
    });
    assert.equal(loaded.queries.length, 1);
  });

  test(`${fixture.table}: an actual database failure is not mislabeled as a version conflict`, async () => {
    const failure = new Error('Synthetic database failure');
    const loaded = repo(fixture, [], failure);
    await assert.rejects(loaded.api[fixture.writer](17, fixture.fields, '1'), (error) => error === failure);
  });
}

test('slide order-only repository updates still require the loaded revision and retain nullable content', async () => {
  const fixture = fixtures.find((item) => item.table === 'hero_slides')!;
  const loaded = repo(fixture);
  assert.deepEqual(await loaded.api.updateHeroSlide(17, { sortOrder: 8 }, '1'), fixture.expected);
  assert.equal(loaded.queries.length, 1);
  assert.deepEqual(loaded.queries[0].params, [17, 8, '1']);
  assert.match(loaded.queries[0].sql, /set sort_order = \$2, updated_at = now\(\) where id = \$1 and revision = \$3::bigint/);
  assert.doesNotMatch(loaded.queries[0].sql, /(?:popup|tablet|mobile|link)_\w+\s*=/);
  const stale = repo(fixture, []);
  await assert.rejects(stale.api.updateHeroSlide(17, { sortOrder: 8 }, '1'), recordVersion.RecordVersionConflictError);
});
