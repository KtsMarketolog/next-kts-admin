import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { PriceBuildError } from '../src/shared/lib/priceBuild/errors';
import { createPriceSnapshotQuery } from '../src/shared/lib/priceBuild/snapshotDeadline';

const errorCode = (code: string) => (error: unknown) => error instanceof PriceBuildError && error.code === code;
function fakeClient(run: (sql: string, params?: unknown[]) => Promise<unknown>): Pick<PoolClient, 'query'> {
  return { query: run as PoolClient['query'] };
}

test('snapshot query retains result/parameters and bounds SQL and lock budgets separately for every statement', async t => {
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  const calls: { sql: string; params?: unknown[] }[] = [];
  const result = { rows: [{ id: '1' }], rowCount: 1, command: 'SELECT', fields: [], oid: 0 };
  const client = fakeClient(async (sql, params) => { calls.push({ sql, params }); return result; });
  const query = createPriceSnapshotQuery(client, { signal: new AbortController().signal, deadlineAt: 70_000 });
  assert.equal(await query<{ id: string }>('select $1 as id', ['1']), result);
  assert.deepEqual(calls[0], { sql: "SET LOCAL statement_timeout = '30000ms'; SET LOCAL lock_timeout = '5000ms'", params: undefined });
  assert.deepEqual(calls[1], { sql: 'select $1 as id', params: ['1'] });
  now = 68_999;
  await query('select 2');
  assert.equal(calls[2].sql, "SET LOCAL statement_timeout = '1001ms'; SET LOCAL lock_timeout = '1001ms'");
});

test('expired, aborted and invalid snapshot deadlines never send any SQL', async t => {
  t.mock.method(Date, 'now', () => 10_000);
  let calls = 0;
  const client = fakeClient(async () => { calls += 1; return {}; });
  for (const deadlineAt of [NaN, Infinity, -Infinity]) {
    assert.throws(() => createPriceSnapshotQuery(client, { signal: new AbortController().signal, deadlineAt }), errorCode('PRICE_BUILD_FAILED'));
  }
  await assert.rejects(createPriceSnapshotQuery(client, { signal: new AbortController().signal, deadlineAt: 10_000 })('select 1'), errorCode('PRICE_BUILD_TIMEOUT'));
  await assert.rejects(createPriceSnapshotQuery(client, { signal: AbortSignal.abort(), deadlineAt: 20_000 })('select 1'), errorCode('PRICE_BUILD_ABORTED'));
  assert.equal(calls, 0);
});

test('cancellation or deadline during SET prevents the data query from starting', async t => {
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  for (const cause of ['cancel', 'deadline']) {
    now = 10_000;
    const controller = new AbortController(); let calls = 0;
    const query = createPriceSnapshotQuery(fakeClient(async () => {
      calls += 1;
      if (cause === 'cancel') controller.abort(); else now = 11_000;
      return {};
    }), { signal: controller.signal, deadlineAt: 11_000 });
    await assert.rejects(query('select 1'), errorCode(cause === 'cancel' ? 'PRICE_BUILD_ABORTED' : 'PRICE_BUILD_TIMEOUT'));
    assert.equal(calls, 1);
  }
});

test('in-flight SQL is awaited after cancellation; no next query or worker can start', async () => {
  const controller = new AbortController(); let calls = 0;
  let finish!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const query = createPriceSnapshotQuery(fakeClient(async () => {
    if (++calls === 1) return {};
    markStarted();
    await new Promise<void>(resolve => { finish = resolve; });
    return {};
  }), { signal: controller.signal, deadlineAt: Date.now() + 30_000 });
  let settled = false; let workerStarted = false;
  const pending = query('select 1').then(() => { workerStarted = true; }).finally(() => { settled = true; });
  const rejection = assert.rejects(pending, errorCode('PRICE_BUILD_ABORTED'));
  await started; controller.abort(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  finish(); await rejection;
  assert.equal(workerStarted, false);
  await assert.rejects(query('select 2'), errorCode('PRICE_BUILD_ABORTED'));
  assert.equal(calls, 2);
});

test('deadline after successful SQL discards its result; server statement timeout is typed even before overall deadline', async t => {
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  const expired = createPriceSnapshotQuery(fakeClient(async () => {
    if (++calls === 2) now = 11_000;
    return { rows: [] };
  }), { signal: new AbortController().signal, deadlineAt: 11_000 });
  await assert.rejects(expired('select 1'), errorCode('PRICE_BUILD_TIMEOUT'));
  await assert.rejects(expired('select 2'), errorCode('PRICE_BUILD_TIMEOUT'));
  assert.equal(calls, 2);
  calls = 0;
  const timedOut = createPriceSnapshotQuery(fakeClient(async () => {
    if (++calls === 2) throw Object.assign(new Error('statement timeout'), { code: '57014' });
    return {};
  }), { signal: new AbortController().signal, deadlineAt: 70_000 });
  await assert.rejects(timedOut('select pg_sleep(60)'), errorCode('PRICE_BUILD_TIMEOUT'));
});

test('ordinary SQL errors retain identity when cancellation/deadline did not occur', async () => {
  const databaseError = Object.assign(new Error('synthetic SQL error'), { code: '42P01' });
  const query = createPriceSnapshotQuery(fakeClient(async sql => {
    if (sql.startsWith('SET LOCAL')) return {};
    throw databaseError;
  }), { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 });
  await assert.rejects(query('select * from absent'), error => error === databaseError);
});
