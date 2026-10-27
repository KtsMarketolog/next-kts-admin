/** Run only with scripts/test-personal-dashboard-postgres.sh and this disposable test bundle. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { applySupportSharedJsonLimitMigration } from '../src/shared/lib/db/supportSharedJsonLimitMigration';
import { SUPPORT_SHARED_JSON_MAX_BYTES } from '../src/shared/lib/supportSharedRoutePlannerLimits';

test('existing 100 MiB route-planner tables safely upgrade to 500 MiB without changing data or pointers', async () => {
  assert.equal(process.env.KTS_PERSONAL_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_personal_integration');
  assert.equal(url.username, 'personal_app');
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-personal-postgres\.[A-Za-z0-9]+\/socket$/);
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`
      create temp table support_shared_dashboard_json_snapshots (
        id bigint primary key, html_version_id bigint not null, file_size bigint not null check (file_size between 1 and 104857600),
        sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'), storage_path text not null,
        unique (html_version_id,id)
      );
      create temp table support_shared_dashboard_json_state (
        html_version_id bigint primary key, active_snapshot_id bigint, previous_snapshot_id bigint,
        foreign key (html_version_id,active_snapshot_id) references support_shared_dashboard_json_snapshots(html_version_id,id),
        foreign key (html_version_id,previous_snapshot_id) references support_shared_dashboard_json_snapshots(html_version_id,id)
      );
      create temp table unrelated_prices (id bigint primary key, price numeric not null, stock integer not null);
      insert into support_shared_dashboard_json_snapshots values (1,7,104857600,repeat('a',64),'retained-current'),
        (2,7,100,repeat('b',64),'retained-previous'), (3,6,50,repeat('c',64),'retained-previous-html');
      insert into support_shared_dashboard_json_state values (7,1,2),(6,3,null);
      insert into unrelated_prices values(1,123.45,7);
    `);
    const before = {
      snapshots: (await client.query('select * from support_shared_dashboard_json_snapshots order by id')).rows,
      pointers: (await client.query('select * from support_shared_dashboard_json_state order by html_version_id')).rows,
      prices: (await client.query('select * from unrelated_prices')).rows,
    };
    async function rejectsQuery(sql: string, parameters: unknown[], code: string) {
      await client.query('savepoint rejected_write');
      try { await assert.rejects(client.query(sql, parameters), { code }); }
      finally { await client.query('rollback to savepoint rejected_write'); }
    }
    await rejectsQuery('update support_shared_dashboard_json_snapshots set file_size=$1 where id=1', [104857601], '23514');
    await applySupportSharedJsonLimitMigration(client);
    await applySupportSharedJsonLimitMigration(client);
    assert.deepEqual((await client.query('select * from support_shared_dashboard_json_snapshots order by id')).rows, before.snapshots);
    assert.deepEqual((await client.query('select * from support_shared_dashboard_json_state order by html_version_id')).rows, before.pointers);
    assert.deepEqual((await client.query('select * from unrelated_prices')).rows, before.prices);
    await client.query('update support_shared_dashboard_json_snapshots set file_size=$1 where id=1', [104857601]);
    await client.query('update support_shared_dashboard_json_snapshots set file_size=$1 where id=1', [SUPPORT_SHARED_JSON_MAX_BYTES]);
    for (const size of [0, -1, SUPPORT_SHARED_JSON_MAX_BYTES + 1]) {
      await rejectsQuery('update support_shared_dashboard_json_snapshots set file_size=$1 where id=1', [size], '23514');
    }
    await rejectsQuery('update support_shared_dashboard_json_snapshots set sha256=$1 where id=1', ['invalid'], '23514');
    await rejectsQuery('update support_shared_dashboard_json_state set active_snapshot_id=3 where html_version_id=7', [], '23503');
    assert.deepEqual((await client.query('select * from support_shared_dashboard_json_state order by html_version_id')).rows, before.pointers);
    assert.deepEqual((await client.query('select * from unrelated_prices')).rows, before.prices);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
    await pool.end();
  }
});
