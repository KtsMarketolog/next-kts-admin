/** Synthetic acceptance only. Run via scripts/test-site-content-bootstrap-postgres.sh. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { Client, Pool } from 'pg';

import { DEFAULT_BRAND_CATEGORIES, DEFAULT_BRAND_ITEMS } from '../src/entities/site/model/defaultBrands';
import { DEFAULT_GROUP_COMPANIES } from '../src/entities/site/model/defaultGroupCompanies';
import { DEFAULT_HERO_SLIDES } from '../src/entities/site/model/defaultSlides';
import { DEFAULT_NEWS } from '../src/entities/site/model/defaultNews';
import { query } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { completeInitialSiteContentBootstrap, reserveInitialSiteContentBootstrap } from '../src/shared/lib/db/schemaSeeds';

const execFileAsync = promisify(execFile);
const tables = ['hero_slides', 'news_items', 'brand_categories', 'brand_items', 'group_companies'] as const;

function guard() {
  assert.equal(process.env.KTS_SITE_CONTENT_TEST, '1', 'Explicit isolated integration flag is required');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, 'localhost');
  assert.ok(['/kts_site_content_runtime', '/kts_site_content_bootstrap'].includes(url.pathname));
  assert.equal(url.username, 'content_app');
  assert.equal(url.password, '', 'Test role has no application credentials');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-site-content-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55481');
}

async function rows(table: typeof tables[number]) {
  return (await query<{ row: Record<string, unknown> }>(`select row_to_json(t) as row from ${table} t order by id`)).rows.map(({ row }) => row);
}

async function snapshot() {
  return Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await rows(table)])));
}

async function assertEmpty() {
  for (const table of tables) assert.deepEqual(await rows(table), [], `${table} must stay empty`);
}

async function runFreshProcess() {
  guard();
  const result = await execFileAsync(process.execPath, ['--import', 'tsx', '-e', `
    const { ensureSiteSchema } = require('./src/shared/lib/db/schema.ts');
    ensureSiteSchema().then(async () => {
      await globalThis.__ktsPgPool?.end();
      process.stdout.write('schema-ready');
    }).catch(async (error) => {
      process.stderr.write(String(error));
      await globalThis.__ktsPgPool?.end();
      process.exitCode = 1;
    });
  `], { cwd: process.cwd(), env: process.env, timeout: 30_000 });
  assert.match(result.stdout, /schema-ready/);
}

async function resetRuntime() {
  await globalThis.__ktsPgPool?.end();
  globalThis.__ktsPgPool = undefined;
  globalThis.__ktsSiteSchemaReady = undefined;
}

async function removeContent() {
  // Every identifier is from the fixed allowlist, within the guarded scratch DB.
  guard();
  await query('delete from brand_items');
  await query('delete from brand_categories');
  await query('delete from hero_slides');
  await query('delete from news_items');
  await query('delete from group_companies');
}

async function addCustomizedContent() {
  await query(`insert into hero_slides (title,image_url,popup_text,sort_order,is_active)
    values ('Synthetic customized slide','/custom-slide.svg','Do not change',37,false)`);
  await query(`insert into news_items (title,image_url,date_label,sort_order,is_active)
    values ('Synthetic customized news','/custom-news.svg','Custom date',29,false)`);
  await query(`insert into brand_categories (key,title,sort_order,is_active)
    values ('synthetic-custom','Synthetic customized category',43,false)`);
  await query(`insert into brand_items (category_id,name,image_url,icon_key,sort_order,is_active)
    select id,'Synthetic customized brand','/custom-brand.svg','custom-icon',31,false
    from brand_categories where key='synthetic-custom'`);
  await query(`insert into group_companies (image_url,link_url,sort_order,is_active)
    values ('/custom-group.svg','/custom-target',19,false)`);
}

test('normal schema initialization never resurrects site content in isolated PostgreSQL', { timeout: 120_000 }, async (t) => {
  guard();
  try {
    assert.equal((await query<{ present: string | null }>(`select to_regclass('public.hero_slides')::text as present`)).rows[0].present, null,
      'Refuse any pre-existing application schema');
    const role = await query('select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user');
    assert.deepEqual(role.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false });

    await t.test('fresh normal startup creates schema and settings without demonstration content', async () => {
      await ensureSiteSchema();
      await assertEmpty();
      const settings = await query(`select key from site_settings where key in ('phone','email','address') order by key`);
      assert.deepEqual(settings.rows.map(({ key }) => key), ['address', 'email', 'phone']);
    });

    await t.test('repeated and concurrent ensures do not populate an intentionally empty installation', async () => {
      globalThis.__ktsSiteSchemaReady = undefined;
      await Promise.all(Array.from({ length: 8 }, () => ensureSiteSchema()));
      await Promise.all([runFreshProcess(), runFreshProcess()]);
      await assertEmpty();
    });

    await t.test('customized and inactive content survives startup byte-for-byte, including dates', async () => {
      await addCustomizedContent();
      await query(`update site_settings set value='Synthetic customized phone' where key='phone'`);
      const before = await snapshot();
      await runFreshProcess();
      assert.deepEqual(await snapshot(), before);
      assert.equal((await query(`select value from site_settings where key='phone'`)).rows[0].value, 'Synthetic customized phone');
    });

    await t.test('deleting only child brands cannot regenerate them under retained categories', async () => {
      await query('delete from brand_items');
      const before = await snapshot();
      await runFreshProcess();
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await rows('brand_items'), []);
      assert.equal((await rows('brand_categories')).length, 1);
    });

    for (const table of ['hero_slides', 'news_items', 'brand_categories', 'group_companies'] as const) {
      await t.test(`deleting all ${table} remains empty after a real process restart`, async () => {
        await query(`delete from ${table}`);
        const before = await snapshot();
        await runFreshProcess();
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(await rows(table), []);
      });
    }

    await t.test('all deliberately cleared sections remain empty across another restart', async () => {
      await removeContent();
      await resetRuntime();
      await ensureSiteSchema();
      await runFreshProcess();
      await assertEmpty();
    });

    await t.test('manual bootstrap cannot reinterpret an existing empty installation as a fresh database', async () => {
      const before = await snapshot();
      await assert.rejects(reserveInitialSiteContentBootstrap(), /База уже инициализирована/);
      await assert.rejects(completeInitialSiteContentBootstrap());
      assert.deepEqual(await snapshot(), before);
      assert.equal((await query<{ present: string | null }>(`select to_regclass('public.site_content_bootstrap')::text as present`)).rows[0].present, null);
    });
  } finally {
    await resetRuntime();
  }
});

async function marker() {
  return (await query(`select row_to_json(t) as row from site_content_bootstrap t order by id`)).rows.map(({ row }) => row);
}

async function until(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Did not observe ${description}`);
}

test('explicit first-install content bootstrap is atomic, one-time and concurrency-safe', { timeout: 120_000 }, async (t) => {
  guard();
  await resetRuntime();
  const originalUrl = process.env.DATABASE_URL;
  const url = new URL(originalUrl!);
  url.pathname = '/kts_site_content_bootstrap';
  process.env.DATABASE_URL = url.toString();
  guard();
  try {
    assert.equal((await query<{ present: string | null }>(`select to_regclass('public.hero_slides')::text as present`)).rows[0].present, null,
      'Bootstrap tests require their separate fresh scratch database');

    await t.test('concurrent explicit reservations create exactly one durable pending marker', async () => {
      const outcomes = await Promise.all(Array.from({ length: 6 }, () => reserveInitialSiteContentBootstrap()));
      assert.deepEqual(outcomes, Array(6).fill('pending'));
      const saved = await marker();
      assert.equal(saved.length, 1);
      assert.equal(saved[0].state, 'pending');
      assert.equal(saved[0].completed_at, null);
      await ensureSiteSchema();
      await assertEmpty();
      await runFreshProcess();
      await assertEmpty();
      assert.deepEqual(await marker(), saved, 'Normal startup cannot complete the manual reservation');
    });

    await t.test('pending bootstrap refuses customized or inactive content without touching it', async () => {
      await addCustomizedContent();
      const before = await snapshot();
      const reserved = await marker();
      await assert.rejects(completeInitialSiteContentBootstrap(), /В разделах уже есть контент/);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await marker(), reserved);
      await removeContent();
    });

    await t.test('content created concurrently cannot be mixed with startup defaults', async () => {
      const creator = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'synthetic-content-creator' });
      await creator.connect();
      try {
        await creator.query('begin');
        await creator.query(`insert into hero_slides (title,image_url) values ('Synthetic concurrent content','/concurrent.svg')`);
        // Attach rejection handler immediately while this operation waits for the table lock.
        const completion = completeInitialSiteContentBootstrap().then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        await until(async () => Number((await query<{ count: string }>(`select count(*) from pg_locks
          where relation='hero_slides'::regclass and mode='ShareRowExclusiveLock' and not granted`)).rows[0].count) === 1,
        'bootstrap waiting behind concurrent content insert');
        await creator.query('commit');
        const outcome = await completion;
        assert.equal(outcome.ok, false);
        if (!outcome.ok) assert.match(String(outcome.error), /В разделах уже есть контент/);
        const after = await rows('hero_slides');
        assert.equal(after.length, 1);
        assert.equal(after[0].title, 'Synthetic concurrent content');
        for (const table of tables.filter((table) => table !== 'hero_slides')) assert.deepEqual(await rows(table), []);
        assert.equal((await marker())[0].state, 'pending');
      } finally {
        await creator.query('rollback').catch(() => {});
        await creator.end();
        await removeContent();
      }
    });

    await t.test('failure in the final content section rolls back all preceding sections and leaves marker pending', async () => {
      await query('create sequence synthetic_content_fault_counter');
      await query(`create function synthetic_content_fail() returns trigger language plpgsql as $$
        begin
          if exists (select 1 from hero_slides) and exists (select 1 from news_items)
            and exists (select 1 from brand_categories) and exists (select 1 from brand_items) then
            perform nextval('synthetic_content_fault_counter');
          end if;
          raise exception 'synthetic last-section failure';
        end $$`);
      await query(`create trigger synthetic_content_fault before insert on group_companies
        for each row execute function synthetic_content_fail()`);
      const reserved = await marker();
      try {
        await assert.rejects(completeInitialSiteContentBootstrap(), /synthetic last-section failure/);
        const counter = await query(`select is_called from synthetic_content_fault_counter`);
        assert.equal(counter.rows[0].is_called, true, 'The failure must occur after preceding sections have been inserted');
        await assertEmpty();
        assert.deepEqual(await marker(), reserved);
      } finally {
        await query('drop trigger synthetic_content_fault on group_companies');
        await query('drop function synthetic_content_fail()');
        await query('drop sequence synthetic_content_fault_counter');
      }
    });

    await t.test('failure writing completion marker also rolls back every content table', async () => {
      await query(`create function synthetic_marker_fail() returns trigger language plpgsql as $$
        begin raise exception 'synthetic marker failure'; end $$`);
      await query(`create trigger synthetic_marker_fault before update on site_content_bootstrap
        for each row execute function synthetic_marker_fail()`);
      const reserved = await marker();
      try {
        await assert.rejects(completeInitialSiteContentBootstrap(), /synthetic marker failure/);
        await assertEmpty();
        assert.deepEqual(await marker(), reserved);
      } finally {
        await query('drop trigger synthetic_marker_fault on site_content_bootstrap');
        await query('drop function synthetic_marker_fail()');
      }
    });

    await t.test('concurrent manual completion inserts each default exactly once', async () => {
      const outcomes = await Promise.all(Array.from({ length: 6 }, () => completeInitialSiteContentBootstrap()));
      assert.equal(outcomes.filter((outcome) => outcome === 'seeded').length, 1);
      assert.equal(outcomes.filter((outcome) => outcome === 'already-complete').length, 5);
      const expectedCounts = {
        hero_slides: DEFAULT_HERO_SLIDES.length,
        news_items: DEFAULT_NEWS.length,
        brand_categories: DEFAULT_BRAND_CATEGORIES.length,
        brand_items: DEFAULT_BRAND_ITEMS.length,
        group_companies: DEFAULT_GROUP_COMPANIES.length,
      };
      for (const table of tables) assert.equal((await rows(table)).length, expectedCounts[table]);
      assert.equal((await marker())[0].state, 'complete');
      assert.ok((await marker())[0].completed_at);
      const before = await snapshot();
      const completed = await marker();
      await runFreshProcess();
      assert.deepEqual(await snapshot(), before);
      assert.equal(await reserveInitialSiteContentBootstrap(), 'complete');
      assert.equal(await completeInitialSiteContentBootstrap(), 'already-complete');
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await marker(), completed);
    });

    for (const table of ['brand_items', 'brand_categories', 'hero_slides', 'news_items', 'group_companies'] as const) {
      await t.test(`completed bootstrap never resurrects deleted ${table}, even when called manually again`, async () => {
        await query(`delete from ${table}`);
        const before = await snapshot();
        const completed = await marker();
        assert.equal(await reserveInitialSiteContentBootstrap(), 'complete');
        assert.equal(await completeInitialSiteContentBootstrap(), 'already-complete');
        await runFreshProcess();
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual(await marker(), completed);
        assert.deepEqual(await rows(table), []);
      });
    }
  } finally {
    await resetRuntime();
    process.env.DATABASE_URL = originalUrl;
  }
});

async function inSyntheticSchema(name: string, run: (quotedSchema: string) => Promise<void>) {
  guard();
  const quotedSchema = `"${name.replaceAll('"', '""')}"`;
  await query(`create schema ${quotedSchema}`);
  await resetRuntime();
  // One controlled session preserves SET search_path for every callback query.
  // No application pool configuration or external database is used by this test.
  globalThis.__ktsPgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await query(`set search_path to ${quotedSchema}`);
    assert.equal((await query(`select current_schema() as name`)).rows[0].name, name);
    await run(quotedSchema);
  } finally {
    await resetRuntime();
  }
}

test('bootstrap respects exact mixed-case and quoted schema names', { timeout: 30_000 }, async (t) => {
  guard();
  try {
    const publicBefore = await snapshot();
    for (const name of ['SyntheticMixedCase', 'Synthetic"QuotedSchema']) {
      await t.test(`reservation and complete bootstrap work in ${JSON.stringify(name)}`, async () => {
        await inSyntheticSchema(name, async (schema) => {
          assert.equal(await reserveInitialSiteContentBootstrap(), 'pending');
          assert.equal(await reserveInitialSiteContentBootstrap(), 'pending');
          assert.equal((await marker()).length, 1);
          // Use identical real content-column definitions in this isolated namespace.
          // LIKE copies defaults/indexes, not public content or application data.
          for (const table of tables) {
            await query(`create table ${schema}.${table} (like public.${table} including all)`);
          }
          await query(`alter table ${schema}.brand_items add foreign key (category_id) references ${schema}.brand_categories(id)`);
          await assertEmpty();
          assert.equal(await completeInitialSiteContentBootstrap(), 'seeded');
          assert.equal((await rows('hero_slides')).length, DEFAULT_HERO_SLIDES.length);
          assert.equal((await rows('news_items')).length, DEFAULT_NEWS.length);
          assert.equal((await rows('brand_categories')).length, DEFAULT_BRAND_CATEGORIES.length);
          assert.equal((await rows('brand_items')).length, DEFAULT_BRAND_ITEMS.length);
          assert.equal((await rows('group_companies')).length, DEFAULT_GROUP_COMPANIES.length);
          const completed = await marker();
          assert.equal(await reserveInitialSiteContentBootstrap(), 'complete');
          assert.equal(await completeInitialSiteContentBootstrap(), 'already-complete');
          assert.deepEqual(await marker(), completed);
        });
        assert.deepEqual(await snapshot(), publicBefore, 'Quoted-schema bootstrap must not populate public tables');
      });
    }

    await t.test('an existing relation in a quoted schema is detected and refuses bootstrap', async () => {
      await inSyntheticSchema('Existing"MixedSchema', async (schema) => {
        await query(`create table ${schema}.existing_customer_content (value text not null)`);
        await query(`insert into ${schema}.existing_customer_content values ('Synthetic preserved value')`);
        await assert.rejects(reserveInitialSiteContentBootstrap(), /База уже инициализирована/);
        assert.deepEqual((await query(`select value from ${schema}.existing_customer_content`)).rows, [{ value: 'Synthetic preserved value' }]);
        const markerExists = await query(`select exists (
          select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname=current_schema() and c.relname='site_content_bootstrap') as present`);
        assert.equal(markerExists.rows[0].present, false);
      });
      assert.deepEqual(await snapshot(), publicBefore);
    });
  } finally {
    await resetRuntime();
  }
});
