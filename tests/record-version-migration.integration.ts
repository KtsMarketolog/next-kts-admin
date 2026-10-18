/** Synthetic legacy tables only; scripts/test-purchaser-postgres.sh owns this disposable cluster. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { applyRecordVersionMigration } from '../src/shared/lib/db/recordVersionMigration';

test('record revision migration preserves legacy business rows and bounds bulk invalidation work', async () => {
  assert.equal(process.env.KTS_PURCHASER_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_purchaser_integration');
  assert.equal(url.username, 'purchaser_app');
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-purchaser-postgres\.[A-Za-z0-9]+\/socket$/);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const schema = `revision_fixture_${randomUUID().replaceAll('-', '')}`;
    await client.query(`create schema ${schema}`);
    await client.query(`set local search_path to ${schema}, pg_catalog`);
    await client.query(`
      create table admin_users (id bigint primary key, name text, is_active boolean, password_hash text,
        password_ciphertext text, updated_at timestamptz not null default now());
      create table wholesale_managers (id bigint primary key, name text, is_active boolean, password_hash text,
        password_ciphertext text, display_password text, updated_at timestamptz not null default now());
      create table wholesale_price_lists (id bigint primary key, title text, manager_id bigint references wholesale_managers(id),
        token text, comment text, is_active boolean, updated_at timestamptz not null default now());
      create table wholesale_price_list_items (id bigint primary key, price_list_id bigint references wholesale_price_lists(id) on delete cascade,
        custom_wholesale_price numeric(14,2), visible boolean, settings jsonb);
      create table wholesale_price_list_group_stock_settings (id bigint primary key,
        price_list_id bigint references wholesale_price_lists(id) on delete cascade, price_group text, show_stock_numbers boolean);
      create table saved_grants (user_id bigint references admin_users(id), dashboard_key text);
      insert into admin_users values (1,'Synthetic unchanged administrator',true,'synthetic-admin-hash','synthetic-cipher',now());
      insert into wholesale_managers values (1,'Synthetic unchanged manager',false,'synthetic-manager-hash','synthetic-cipher','',now());
      insert into wholesale_price_lists values (1,'Synthetic retained price',1,'synthetic-token','retain comment',true,now()),
        (2,'Synthetic second price',1,'synthetic-other-token','retain comment too',false,now());
      insert into wholesale_price_list_items select g,1,123.45,true,'{"retained":"unknown field"}'::jsonb from generate_series(1,7500) g;
      insert into wholesale_price_list_group_stock_settings values (1,1,'Synthetic stock group',true);
      insert into saved_grants values (1,'manager:development');
    `);
    const tables = ['admin_users', 'wholesale_managers', 'wholesale_price_lists', 'wholesale_price_list_items', 'wholesale_price_list_group_stock_settings', 'saved_grants'];
    const businessState = async () => {
      const state: Array<{ table: string; rows: unknown[] }> = [];
      for (const table of tables) {
        const result = await client.query(`select to_jsonb(t) - 'revision' as row from ${table} t order by to_jsonb(t)::text`);
        state.push({ table, rows: result.rows });
      }
      return state;
    };
    const before = await businessState();
    await applyRecordVersionMigration(client);
    assert.deepEqual(await businessState(), before, 'Migration must not change prices, saved settings, credentials or grants');
    for (const table of tables.slice(0, 3)) {
      assert.ok((await client.query(`select revision::text from ${table}`)).rows.every((row) => row.revision === '1'));
    }

    await client.query("update admin_users set password_ciphertext='synthetic-repaired-copy' where id=1");
    assert.equal((await client.query('select revision::text from admin_users where id=1')).rows[0].revision, '1');
    await client.query("update wholesale_managers set password_ciphertext='synthetic-repaired-copy',display_password='' where id=1");
    assert.equal((await client.query('select revision::text from wholesale_managers where id=1')).rows[0].revision, '1');
    await client.query("update admin_users set password_hash='synthetic-new-password-hash' where id=1");
    assert.equal((await client.query('select revision::text from admin_users where id=1')).rows[0].revision, '2');
    await client.query('update wholesale_managers set is_active=true where id=1');
    assert.equal((await client.query('select revision::text from wholesale_managers where id=1')).rows[0].revision, '2');

    await client.query('update wholesale_price_list_items set custom_wholesale_price=234.56 where price_list_id=1');
    assert.equal((await client.query('select revision::text from wholesale_price_lists where id=1')).rows[0].revision, '2',
      'A 7,500-row statement must touch its parent once, not once per product');
    await client.query('update wholesale_price_list_items set price_list_id=2 where id=1');
    assert.deepEqual((await client.query('select id::text,revision::text from wholesale_price_lists order by id')).rows,
      [{ id: '1', revision: '3' }, { id: '2', revision: '2' }], 'Moving a child invalidates both old and new parents');
    await client.query('update wholesale_price_list_group_stock_settings set show_stock_numbers=false where id=1');
    assert.equal((await client.query('select revision::text from wholesale_price_lists where id=1')).rows[0].revision, '4');
    await client.query('delete from wholesale_price_list_items where price_list_id=2');
    assert.equal((await client.query('select revision::text from wholesale_price_lists where id=2')).rows[0].revision, '3');
    await client.query('insert into wholesale_price_list_items values(9001,2,456.78,false,\'{}\')');
    assert.equal((await client.query('select revision::text from wholesale_price_lists where id=2')).rows[0].revision, '4');
    await client.query('delete from wholesale_price_lists where id=2');
    assert.equal((await client.query('select count(*)::text as n from wholesale_price_list_items where price_list_id=2')).rows[0].n, '0');
    await client.query('update wholesale_price_list_items set visible=false where id=-1');
    assert.equal((await client.query('select revision::text from wholesale_price_lists where id=1')).rows[0].revision, '4',
      'An empty statement must not invalidate unrelated forms');
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
    await pool.end();
  }
});
