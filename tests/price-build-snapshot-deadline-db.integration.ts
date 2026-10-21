/** Disposable local database only; run with scripts/test-price-build-postgres.sh. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';
import { PriceBuildError } from '../src/shared/lib/priceBuild/errors';
import { createPriceSnapshotQuery } from '../src/shared/lib/priceBuild/snapshotDeadline';

function guard() {
  assert.equal(process.env.KTS_PRICE_BUILD_TEST, '1'); assert.equal(process.env.NODE_ENV, 'test');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, 'localhost'); assert.equal(url.pathname, '/kts_price_build_integration');
  assert.equal(url.username, 'price_build_app'); assert.equal(url.password, '');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['host', 'port']);
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-price-build-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55487');
}
const errorCode = (code: string) => (error: unknown) => error instanceof PriceBuildError && error.code === code;

test('price snapshot SQL deadlines and cancellation use real PostgreSQL completion', { timeout: 10_000 }, async t => {
  guard();
  const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2_000, statement_timeout: 2_000 });
  await client.connect();
  try {
    await t.test('SET timeout permits repeatable-read/read-only isolation before first read and never persists past transaction', async () => {
      const before = (await client.query('show statement_timeout')).rows[0].statement_timeout;
      await client.query('begin');
      const query = createPriceSnapshotQuery(client, { signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 });
      await query('set transaction isolation level repeatable read read only');
      const settings = await query<{ isolation: string; read_only: string; statement_ms: string; lock_ms: string }>(
        `select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only,
          current_setting('statement_timeout') as statement_ms, current_setting('lock_timeout') as lock_ms`,
      );
      assert.deepEqual(settings.rows[0], { isolation: 'repeatable read', read_only: 'on', statement_ms: '30s', lock_ms: '5s' });
      await client.query('commit');
      assert.equal((await client.query('show statement_timeout')).rows[0].statement_timeout, before);
    });

    await t.test('long SQL receives server cancellation by the remaining job deadline and does not start following work', async () => {
      await client.query('begin read only');
      const query = createPriceSnapshotQuery(client, { signal: new AbortController().signal, deadlineAt: Date.now() + 150 });
      let continued = false;
      await assert.rejects(query('select pg_sleep(2)').then(() => { continued = true; }), errorCode('PRICE_BUILD_TIMEOUT'));
      assert.equal(continued, false);
      // PostgreSQL aborted the transaction itself; this was not merely an
      // application timer returning while a long database statement kept going.
      await assert.rejects(client.query('select 1'), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === '25P02'));
      await client.query('rollback');
      assert.equal((await client.query('select 1 as value')).rows[0].value, 1);
    });

    await t.test('abort during SQL is reported after SQL completion and no subsequent query is allowed', async () => {
      await client.query('begin read only');
      const controller = new AbortController();
      const query = createPriceSnapshotQuery(client, { signal: controller.signal, deadlineAt: Date.now() + 2_000 });
      const pending = query('select pg_sleep(0.15)');
      const rejected = assert.rejects(pending, errorCode('PRICE_BUILD_ABORTED'));
      const timer = setTimeout(() => controller.abort(), 30);
      try { await rejected; } finally { clearTimeout(timer); }
      await assert.rejects(query('select 1'), errorCode('PRICE_BUILD_ABORTED'));
      // The SQL has really completed and this connection is safe to roll back.
      await client.query('rollback');
      assert.equal((await client.query('select 2 as value')).rows[0].value, 2);
    });
  } finally {
    await client.query('rollback').catch(() => undefined);
    await client.end();
  }
});
