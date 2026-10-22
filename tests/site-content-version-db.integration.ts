/** Synthetic acceptance only. Run via scripts/test-site-content-version-postgres.sh. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';

import type { HeroSlide } from '../src/entities/site/model/defaultSlides';
import type { NewsItem } from '../src/entities/site/model/defaultNews';
import type { BrandCategory, BrandItem } from '../src/entities/site/model/defaultBrands';
import type { GroupCompany } from '../src/entities/site/model/defaultGroupCompanies';
import type { AdminContentOrderKind } from '../src/shared/lib/adminContentOrder';
import { RecordVersionConflictError } from '../src/shared/lib/recordVersion';
import { query, withTransaction } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { applySiteContentVersionMigration } from '../src/shared/lib/db/siteContentVersionMigration';
import { reorderAdminContent } from '../src/shared/lib/db/adminContentOrderRepo';
import { createHeroSlide, getHeroSlides, updateHeroSlide } from '../src/shared/lib/db/slidesRepo';
import { createNewsItem, getNewsItems, updateNewsItem } from '../src/shared/lib/db/newsRepo';
import {
  createBrandCategory, createBrandItem, getBrandCategories, getBrandItems,
  updateBrandCategory, updateBrandItem,
} from '../src/shared/lib/db/brandPortfolioRepo';
import { createGroupCompany, getGroupCompanies, updateGroupCompany } from '../src/shared/lib/db/groupCompaniesRepo';

function guard() {
  assert.equal(process.env.KTS_CONTENT_VERSION_TEST, '1', 'Explicit isolated integration flag is required');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_content_version_integration');
  assert.equal(url.username, 'content_version_app');
  assert.equal(url.password, '', 'Test role has no application credentials');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-content-version-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55504');
}

type ContentRecord = HeroSlide | NewsItem | BrandCategory | BrandItem | GroupCompany;
type ContentPatch = Partial<ContentRecord>;
type RawRow = { id: number; revision: number | string; [key: string]: unknown };
type Configuration = {
  name: string;
  table: string;
  field: 'title' | 'name' | 'linkUrl';
  sqlField: 'title' | 'name' | 'link_url';
  orderKind?: AdminContentOrderKind;
  create: () => Promise<number>;
  read: () => Promise<ContentRecord[]>;
  update: (id: number, patch: ContentPatch, revision: string) => Promise<ContentRecord>;
};

function revision(item: ContentRecord) {
  assert.equal(typeof item.revision, 'string', 'Revisions must not be rounded through JavaScript numbers');
  assert.match(item.revision!, /^[1-9][0-9]*$/);
  return item.revision!;
}

async function find(configuration: Configuration, id: number) {
  const item = (await configuration.read()).find((candidate) => candidate.id === id);
  assert.ok(item, `${configuration.name} row ${id} must exist`);
  return item;
}

// All interpolated identifiers come from the fixed configurations below.
async function rawRows(table: string) {
  return (await query<{ row: RawRow }>(`select row_to_json(t) as row from ${table} t order by id`)).rows.map(({ row }) => row);
}

async function until(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Did not observe ${description}`);
}

async function connected<T>(run: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'synthetic-content-version-test' });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}

test('content saves reject stale forms atomically in isolated PostgreSQL', { timeout: 120_000 }, async (t) => {
  guard();
  try {
    const existing = await query<{ present: string | null }>(`select to_regclass('public.hero_slides')::text as present`);
    assert.equal(existing.rows[0].present, null, 'Refuse any pre-existing application schema');
    await ensureSiteSchema();
    const role = await query('select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user');
    assert.deepEqual(role.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    assert.equal((await query(`select id from schema_migrations where id='202610220004_site_content_write_versions'`)).rowCount, 1);
    await t.test('legacy migration adds versions without changing existing content, activation, dates or order', async () => {
      await withTransaction(async (client) => {
        await client.query('create schema synthetic_content_legacy');
        await client.query('set local search_path to synthetic_content_legacy, public');
        const tables = ['hero_slides', 'news_items', 'brand_categories', 'brand_items', 'group_companies'];
        for (const table of tables) {
          await client.query(`create table ${table} (
            id bigint primary key, title text, image_url text, is_active boolean, sort_order integer,
            created_at timestamptz, updated_at timestamptz
          )`);
          await client.query(`insert into ${table} values
            (41, 'Synthetic legacy active', '/synthetic/legacy.png', true, 71, '2020-01-01 00:00:00+00', '2021-01-01 00:00:00+00'),
            (42, 'Synthetic legacy inactive', null, false, 3, '2020-01-01 00:00:00+00', '2022-01-01 00:00:00+00')`);
        }
        const before = await Promise.all(tables.map((table) => client.query(`select * from ${table} order by id`)));
        await applySiteContentVersionMigration(client);
        for (let index = 0; index < tables.length; index++) {
          const after = await client.query(`select * from ${tables[index]} order by id`);
          assert.deepEqual(after.rows, before[index].rows.map((row) => ({ ...row, revision: '1' })));
          await client.query(`update ${tables[index]} set title='Synthetic migrated edit' where id=41`);
          assert.equal((await client.query(`select revision::text from ${tables[index]} where id=41`)).rows[0].revision, '2');
        }
        await client.query('drop schema synthetic_content_legacy cascade');
      });
    });
    let sequence = 0;
    const next = () => String(++sequence);
    const categoryId = await createBrandCategory({ key: 'synthetic-brand-parent', title: 'Synthetic parent', sortOrder: 1, isActive: true });
    const configurations: Configuration[] = [
      {
        name: 'slides', table: 'hero_slides', field: 'title', sqlField: 'title', orderKind: 'slides',
        create: () => createHeroSlide({
          title: `Synthetic slide ${next()}`, imageUrl: '/synthetic/main.png', tabletImageUrl: '/synthetic/tablet.png',
          mobileImageUrl: '/synthetic/mobile.png', popupImageUrl: '/synthetic/popup.png',
          popupTabletImageUrl: '/synthetic/popup-tablet.png', popupMobileImageUrl: '/synthetic/popup-mobile.png',
          popupTitle: 'Synthetic popup', popupText: 'Synthetic multiline\ntext', linkUrl: '/synthetic/target', sortOrder: 1, isActive: true,
        }),
        read: getHeroSlides,
        update: (id, patch, expected) => updateHeroSlide(id, patch as Partial<HeroSlide>, expected),
      },
      {
        name: 'news', table: 'news_items', field: 'title', sqlField: 'title', orderKind: 'news',
        create: () => createNewsItem({ date: 'Synthetic date', title: `Synthetic news ${next()}`, imageUrl: '/synthetic/news.png', linkUrl: '/synthetic/news', sortOrder: 1, isActive: true }),
        read: getNewsItems,
        update: (id, patch, expected) => updateNewsItem(id, patch as Partial<NewsItem>, expected),
      },
      {
        name: 'brand categories', table: 'brand_categories', field: 'title', sqlField: 'title', orderKind: 'brand-categories',
        create: () => createBrandCategory({ key: `synthetic-category-${next()}`, title: 'Synthetic category', sortOrder: 1, isActive: true }),
        read: getBrandCategories,
        update: (id, patch, expected) => updateBrandCategory(id, patch as Partial<BrandCategory>, expected),
      },
      {
        name: 'brands', table: 'brand_items', field: 'name', sqlField: 'name',
        create: () => createBrandItem({ categoryId, name: `Synthetic brand ${next()}`, imageUrl: '/synthetic/brand.png', iconKey: 'synthetic-icon', sortOrder: 1, isActive: true }),
        read: getBrandItems,
        update: (id, patch, expected) => updateBrandItem(id, patch as Partial<BrandItem>, expected),
      },
      {
        name: 'group companies', table: 'group_companies', field: 'linkUrl', sqlField: 'link_url', orderKind: 'group-companies',
        create: () => createGroupCompany({ imageUrl: `/synthetic/company-${next()}.png`, linkUrl: '/synthetic/company', sortOrder: 1, isActive: true }),
        read: getGroupCompanies,
        update: (id, patch, expected) => updateGroupCompany(id, patch as Partial<GroupCompany>, expected),
      },
    ];

    for (const configuration of configurations) {
      const { name, table, field, sqlField } = configuration;

      await t.test(`${name}: disabling cannot be reversed by a stale complete form`, async () => {
        const id = await configuration.create();
        const stale = await find(configuration, id);
        const saved = await configuration.update(id, { ...stale, isActive: false }, revision(stale));
        assert.equal(saved.isActive, false);
        assert.equal(BigInt(revision(saved)), BigInt(revision(stale)) + BigInt(1));
        assert.deepEqual(await find(configuration, id), saved, 'Save returns the actual committed version');
        const before = await rawRows(table);
        await assert.rejects(configuration.update(id, { ...stale, [field]: 'Synthetic stale overwrite' }, revision(stale)), RecordVersionConflictError);
        assert.deepEqual(await rawRows(table), before, 'A conflict must preserve all fields, timestamps and other records');
        const refreshed = await configuration.update(id, { ...saved, [field]: 'Synthetic accepted title' }, revision(saved));
        assert.equal(refreshed.isActive, false, 'Refresh and retry retains the disabled state');
        assert.equal(BigInt(revision(refreshed)), BigInt(revision(saved)) + BigInt(1));
      });

      await t.test(`${name}: two simultaneous saves of one revision have exactly one winner`, async () => {
        const id = await configuration.create();
        const stale = await find(configuration, id);
        await connected(async (blocker) => {
          await blocker.query('begin');
          await blocker.query(`lock table ${table} in share mode`);
          // Attach rejection handlers before either request can be unblocked.
          const results = Promise.allSettled([
            configuration.update(id, { ...stale, [field]: 'Synthetic contender A' }, revision(stale)),
            configuration.update(id, { ...stale, [field]: 'Synthetic contender B' }, revision(stale)),
          ]);
          await until(async () => Number((await query<{ count: string }>(
            `select count(*) from pg_locks where relation=$1::regclass and mode='RowExclusiveLock' and not granted`, [table],
          )).rows[0].count) === 2, 'both content writes queued behind the test gate');
          await blocker.query('commit');
          const outcomes = await results;
          const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
          const losers = outcomes.filter((outcome) => outcome.status === 'rejected');
          assert.equal(winners.length, 1);
          assert.equal(losers.length, 1);
          assert.ok(losers[0].reason instanceof RecordVersionConflictError);
          assert.deepEqual(await find(configuration, id), winners[0].value);
          assert.equal(BigInt(revision(winners[0].value)), BigInt(revision(stale)) + BigInt(1));
        });
      });

      await t.test(`${name}: missing, malformed, stale and deleted revisions never write`, async () => {
        const id = await configuration.create();
        const item = await find(configuration, id);
        const before = await rawRows(table);
        for (const invalid of [undefined, null, '', 1, '0', '-1', '1e0', '01', '9223372036854775808', '2']) {
          await assert.rejects(configuration.update(id, { ...item, [field]: 'Synthetic forbidden update' }, invalid as string), RecordVersionConflictError);
          assert.deepEqual(await rawRows(table), before);
        }
        await query(`delete from ${table} where id=$1`, [id]);
        const afterDelete = await rawRows(table);
        await assert.rejects(configuration.update(id, item, revision(item)), RecordVersionConflictError);
        assert.deepEqual(await rawRows(table), afterDelete, 'Saving a deleted form must not recreate the record');
      });

      await t.test(`${name}: an older writer without revision handling still invalidates loaded forms`, async () => {
        const id = await configuration.create();
        const stale = await find(configuration, id);
        await query(`update ${table} set ${sqlField}='Synthetic legacy writer', is_active=false where id=$1`, [id]);
        const current = await find(configuration, id);
        assert.equal(BigInt(revision(current)), BigInt(revision(stale)) + BigInt(1));
        const before = await rawRows(table);
        await assert.rejects(configuration.update(id, stale, revision(stale)), RecordVersionConflictError);
        assert.deepEqual(await rawRows(table), before);
        assert.equal(current.isActive, false);
      });

      if (configuration.orderKind) {
        await t.test(`${name}: reordering does not conflict with or get reverted by a content-only save`, async () => {
          const id = await configuration.create();
          const loaded = await find(configuration, id);
          const before = await configuration.read();
          const order = [...before.filter((item) => item.id !== id).reverse(), loaded]
            .map((item, index) => ({ id: item.id!, sortOrder: index + 1 }));
          await reorderAdminContent(configuration.orderKind!, order);
          const afterOrder = await configuration.read();
          for (const item of afterOrder) assert.equal(revision(item), revision(before.find((row) => row.id === item.id)!));
          const expectedPosition = order.find((item) => item.id === id)!.sortOrder;
          assert.notEqual(expectedPosition, loaded.sortOrder, 'The fixture must actually move the edited row');
          assert.equal((await find(configuration, id)).sortOrder, expectedPosition);
          // Normal PUT routes deliberately omit sortOrder: only the dedicated reorder route owns it.
          const contentPatch = { ...loaded };
          delete (contentPatch as Partial<ContentRecord>).sortOrder;
          const saved = await configuration.update(id, { ...contentPatch, [field]: 'Synthetic edited after order' }, revision(loaded));
          assert.equal(saved.sortOrder, expectedPosition);
          assert.equal(BigInt(revision(saved)), BigInt(revision(loaded)) + BigInt(1));
        });
      } else {
        await t.test(`${name}: manually editing a brand position invalidates its old form`, async () => {
          const id = await configuration.create();
          const loaded = await find(configuration, id);
          const saved = await configuration.update(id, { ...loaded, sortOrder: 72 }, revision(loaded));
          assert.equal(BigInt(revision(saved)), BigInt(revision(loaded)) + BigInt(1));
          await assert.rejects(configuration.update(id, { ...loaded, [field]: 'Synthetic stale brand' }, revision(loaded)), RecordVersionConflictError);
          assert.equal((await find(configuration, id)).sortOrder, 72);
        });
      }
    }

    await t.test('bigint revisions remain exact beyond Number.MAX_SAFE_INTEGER', async () => {
      const inserted = await query<{ id: string }>(`insert into news_items
        (title, image_url, revision) values ('Synthetic bigint news', '/synthetic/bigint.png', 9007199254740993) returning id`);
      const id = Number(inserted.rows[0].id);
      const item = (await getNewsItems()).find((row) => row.id === id)!;
      assert.equal(revision(item), '9007199254740993');
      const saved = await updateNewsItem(id, { ...item, title: 'Synthetic exact version' }, revision(item));
      assert.equal(revision(saved), '9007199254740994');
      await assert.rejects(updateNewsItem(id, item, revision(item)), RecordVersionConflictError);
      assert.deepEqual((await getNewsItems()).find((row) => row.id === id), saved);
    });

    await t.test('slides: order-only and stale changes preserve nullable images, popup text and links', async () => {
      const slides = configurations[0];
      const id = await slides.create();
      const initial = await find(slides, id) as HeroSlide;
      const sorted = await updateHeroSlide(id, { sortOrder: 123 }, revision(initial));
      assert.deepEqual(sorted, { ...initial, sortOrder: 123 });
      const withNulls = await updateHeroSlide(id, {
        ...sorted, tabletImageUrl: null, popupImageUrl: null, popupText: null, linkUrl: null,
      }, revision(sorted));
      assert.equal(withNulls.tabletImageUrl, null);
      assert.equal(withNulls.popupImageUrl, null);
      assert.equal(withNulls.popupText, null);
      assert.equal(withNulls.linkUrl, null);
      assert.equal(withNulls.mobileImageUrl, initial.mobileImageUrl);
      const before = await rawRows('hero_slides');
      await assert.rejects(updateHeroSlide(id, { ...initial, title: 'Synthetic stale nullable overwrite' }, revision(initial)), RecordVersionConflictError);
      assert.deepEqual(await rawRows('hero_slides'), before);
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
