/** Synthetic acceptance only. Run via scripts/test-admin-content-order-postgres.sh. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';

import type { AdminContentOrderItem, AdminContentOrderKind } from '../src/shared/lib/adminContentOrder';
import { query } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { AdminContentOrderConflictError, reorderAdminContent } from '../src/shared/lib/db/adminContentOrderRepo';

function guard() {
  assert.equal(process.env.KTS_CONTENT_ORDER_TEST, '1', 'Explicit isolated integration flag is required');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_content_order_integration');
  assert.equal(url.username, 'order_app');
  assert.equal(url.password, '', 'Test role has no application credentials');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-content-order-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55480');
}

type Row = { id: number; sort_order: number; updated_at: string; [key: string]: unknown };
const configurations: { kind: AdminContentOrderKind; table: string; insert: string; contentField: string }[] = [
  {
    kind: 'slides', table: 'hero_slides', contentField: 'title',
    insert: `insert into hero_slides (title,image_url,tablet_image_url,popup_text,link_url,sort_order,is_active)
      values ('Synthetic slide ' || $1, '/synthetic-' || $1, '/tablet-' || $1, 'Preserved popup ' || $1, '/target-' || $1, $2, $3) returning id`,
  },
  {
    kind: 'news', table: 'news_items', contentField: 'title',
    insert: `insert into news_items (title,image_url,date_label,link_url,sort_order,is_active)
      values ('Synthetic news ' || $1, '/synthetic-' || $1, 'Synthetic date', '/target-' || $1, $2, $3) returning id`,
  },
  {
    kind: 'group-companies', table: 'group_companies', contentField: 'link_url',
    insert: `insert into group_companies (image_url,link_url,sort_order,is_active)
      values ('/synthetic-' || $1, '/target-' || $1, $2, $3) returning id`,
  },
  {
    kind: 'brand-categories', table: 'brand_categories', contentField: 'title',
    insert: `insert into brand_categories (key,title,sort_order,is_active)
      values ('synthetic-' || $1, 'Synthetic category ' || $1, $2, $3) returning id`,
  },
];

// All interpolated identifiers come from the fixed test configuration above.
async function readRows(table: string): Promise<Row[]> {
  return (await query<{ row: Row }>(`select row_to_json(t) as row from ${table} t order by id`)).rows.map(({ row }) => row);
}

function content(rows: Row[]) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !['sort_order', 'updated_at'].includes(key))));
}

function order(ids: number[]): AdminContentOrderItem[] {
  return ids.map((id, index) => ({ id, sortOrder: index + 1 }));
}

function assertOrder(rows: Row[], expected: AdminContentOrderItem[]) {
  assert.deepEqual(rows.map(({ id, sort_order }) => ({ id, sortOrder: sort_order })), [...expected].sort((a, b) => a.id - b.id));
}

async function until(check: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Did not observe ${description}`);
}

async function pendingLocks(table: string, mode: string) {
  return Number((await query<{ count: string }>(`select count(*) from pg_locks where relation=$1::regclass and mode=$2 and not granted`, [table, mode])).rows[0].count);
}

function settle<T>(promise: Promise<T>) {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

async function connected<T>(run: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'synthetic-order-test' });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}

test('content reorder is one atomic operation in isolated PostgreSQL', { timeout: 120_000 }, async (t) => {
  guard();
  try {
    const existing = await query<{ present: string | null }>(`select to_regclass('public.hero_slides')::text as present`);
    assert.equal(existing.rows[0].present, null, 'Refuse any pre-existing application schema');
    await ensureSiteSchema();
    const role = await query('select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user');
    assert.deepEqual(role.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    await query('delete from brand_items');

    for (const configuration of configurations) {
      const { kind, table, insert, contentField } = configuration;
      await query(`delete from ${table}`);
      for (let index = 1; index <= 4; index++) await query(insert, [String(index), index, index !== 4]);
      const original = await readRows(table);
      const ids = original.map(({ id }) => id);
      const reverse = order([...ids].reverse());
      const rotate = order([...ids.slice(1), ids[0]]);

      await t.test(`${kind}: complete reorder preserves every content field, inactive row and child brand`, async () => {
        if (kind === 'brand-categories') {
          await query(`insert into brand_items (category_id,name,image_url,icon_key,sort_order,is_active)
            values ($1,'Synthetic preserved brand','/brand.svg','brand-icon',77,false)`, [ids[0]]);
        }
        const brandsBefore = await readRows('brand_items');
        assert.deepEqual(await reorderAdminContent(kind, reverse), reverse);
        const after = await readRows(table);
        assertOrder(after, reverse);
        assert.deepEqual(content(after), content(original));
        assert.deepEqual(await readRows('brand_items'), brandsBefore);
        assert.equal(after.length, original.length);
      });

      await t.test(`${kind}: identical reorder is a no-op, including update timestamps`, async () => {
        const before = await readRows(table);
        await reorderAdminContent(kind, reverse);
        assert.deepEqual(await readRows(table), before);
      });

      await t.test(`${kind}: failure after the first row rolls back the whole order`, async () => {
        const before = await readRows(table);
        await query('create sequence synthetic_order_fault_counter');
        await query(`create function synthetic_order_fail() returns trigger language plpgsql as $$
          begin
            if nextval('synthetic_order_fault_counter') = 2 then raise exception 'synthetic order second-row failure'; end if;
            return new;
          end $$`);
        await query(`create trigger synthetic_order_fault before update on ${table}
          for each row execute function synthetic_order_fail()`);
        try {
          await assert.rejects(reorderAdminContent(kind, order(ids)), /synthetic order second-row failure/);
          const calls = await query<{ last_value: string }>('select last_value from synthetic_order_fault_counter');
          assert.equal(Number(calls.rows[0].last_value), 2, 'The fault must happen after one row has already been updated');
          assert.deepEqual(await readRows(table), before);
        } finally {
          await query(`drop trigger synthetic_order_fault on ${table}`);
          await query('drop function synthetic_order_fail()');
          await query('drop sequence synthetic_order_fault_counter');
        }
      });

      await t.test(`${kind}: missing, unknown, extra and duplicate identifiers never write`, async () => {
        const before = await readRows(table);
        for (const proposed of [order(ids.slice(1)), order([ids[0], ids[1], ids[2], 999_999_999]), order([...ids, 999_999_999]), []]) {
          await assert.rejects(reorderAdminContent(kind, proposed), AdminContentOrderConflictError);
          assert.deepEqual(await readRows(table), before);
        }
        await assert.rejects(reorderAdminContent(kind, order([ids[0], ids[0], ids[2], ids[3]])));
        assert.deepEqual(await readRows(table), before);
      });

      await t.test(`${kind}: two concurrent complete orders serialize without mixed positions`, async () => {
        const before = await readRows(table);
        await connected(async (blocker) => {
          await blocker.query('begin');
          await blocker.query(`lock table ${table} in share row exclusive mode`);
          const first = settle(reorderAdminContent(kind, order(ids)));
          await until(async () => (await pendingLocks(table, 'ShareRowExclusiveLock')) === 1, 'first queued order');
          const second = settle(reorderAdminContent(kind, rotate));
          await until(async () => (await pendingLocks(table, 'ShareRowExclusiveLock')) === 2, 'second queued order');
          assert.deepEqual(await readRows(table), before, 'Public reads continue while writers wait');
          await blocker.query('commit');
          const outcomes = await Promise.all([first, second]);
          for (const outcome of outcomes) assert.equal(outcome.ok, true, outcome.ok ? undefined : String(outcome.error));
        });
        const after = await readRows(table);
        assertOrder(after, rotate);
        assert.deepEqual(content(after), content(before));
      });

      await t.test(`${kind}: text committed while an order waits is not overwritten`, async () => {
        await connected(async (editor) => {
          await editor.query('begin');
          await editor.query(`update ${table} set ${contentField}='Synthetic concurrent edit' where id=$1`, [ids[0]]);
          const reordered = settle(reorderAdminContent(kind, reverse));
          await until(async () => (await pendingLocks(table, 'ShareRowExclusiveLock')) === 1, 'order blocked behind content editor');
          await editor.query('commit');
          const outcome = await reordered;
          assert.equal(outcome.ok, true, outcome.ok ? undefined : String(outcome.error));
        });
        assert.equal((await readRows(table)).find(({ id }) => id === ids[0])?.[contentField], 'Synthetic concurrent edit');
        assertOrder(await readRows(table), reverse);
      });

      await t.test(`${kind}: concurrent create before membership check causes a conflict, not a partial order`, async () => {
        const before = await readRows(table);
        await connected(async (creator) => {
          await creator.query('begin');
          const created = await creator.query<{ id: string }>(insert, ['concurrent-create', 90, true]);
          const reordered = settle(reorderAdminContent(kind, order(ids)));
          await until(async () => (await pendingLocks(table, 'ShareRowExclusiveLock')) === 1, 'order blocked behind insert');
          await creator.query('commit');
          const outcome = await reordered;
          assert.equal(outcome.ok, false);
          if (!outcome.ok) assert.ok(outcome.error instanceof AdminContentOrderConflictError);
          const after = await readRows(table);
          assert.deepEqual(after.filter(({ id }) => ids.includes(id)), before);
          assert.equal(after.length, before.length + 1);
          await query(`delete from ${table} where id=$1`, [created.rows[0].id]);
        });
      });

      await t.test(`${kind}: create and delete cannot enter the middle of an order transaction`, async () => {
        // Hold an advisory gate inside UPDATE, after the real table lock and membership check.
        const gate = 731_413;
        await query(`create function synthetic_order_pause() returns trigger language plpgsql as $$
          begin perform pg_advisory_xact_lock(${gate}); return null; end $$`);
        await query(`create trigger synthetic_order_gate before update on ${table}
          for each statement execute function synthetic_order_pause()`);
        const before = await readRows(table);
        try {
          await connected(async (gateOwner) => connected(async (creator) => connected(async (deleter) => {
            await gateOwner.query('begin');
            await gateOwner.query('select pg_advisory_xact_lock($1)', [gate]);
            const reordered = settle(reorderAdminContent(kind, order(ids)));
            await until(async () => Number((await query<{ count: string }>(`select count(*) from pg_locks where locktype='advisory' and objid=$1 and not granted`, [gate])).rows[0].count) === 1, 'order inside UPDATE');
            const created = settle(creator.query<{ id: string }>(insert, ['after-order', 99, true]));
            const deleted = settle(deleter.query(`delete from ${table} where id=$1`, [ids[3]]));
            await until(async () => (await pendingLocks(table, 'RowExclusiveLock')) === 2, 'create and delete blocked by order');
            assert.deepEqual(await readRows(table), before);
            await gateOwner.query('commit');
            for (const outcome of await Promise.all([reordered, created, deleted])) {
              assert.equal(outcome.ok, true, outcome.ok ? undefined : String(outcome.error));
            }
          })));
          const after = await readRows(table);
          assertOrder(after.filter(({ id }) => ids.includes(id)), order(ids).filter(({ id }) => id !== ids[3]));
          assert.deepEqual(content(after.filter(({ id }) => ids.includes(id))), content(before.filter(({ id }) => id !== ids[3])));
          assert.equal(after.length, before.length, 'Only the explicit concurrent create/delete changes membership');
        } finally {
          await query(`drop trigger synthetic_order_gate on ${table}`);
          await query('drop function synthetic_order_pause()');
        }
      });

      await t.test(`${kind}: deletion committed before membership check causes conflict without resurrecting data`, async () => {
        const before = await readRows(table);
        const currentIds = before.map(({ id }) => id);
        await connected(async (deleter) => {
          await deleter.query('begin');
          await deleter.query(`delete from ${table} where id=$1`, [currentIds.at(-1)]);
          const reordered = settle(reorderAdminContent(kind, order([...currentIds].reverse())));
          await until(async () => (await pendingLocks(table, 'ShareRowExclusiveLock')) === 1, 'order blocked behind delete');
          await deleter.query('commit');
          const outcome = await reordered;
          assert.equal(outcome.ok, false);
          if (!outcome.ok) assert.ok(outcome.error instanceof AdminContentOrderConflictError);
        });
        assert.deepEqual(await readRows(table), before.slice(0, -1));
      });
    }
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
