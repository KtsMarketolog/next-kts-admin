import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

import * as model from '../src/shared/lib/currencyDashboardModel';

type Repo = typeof import('../src/shared/lib/db/currencyDashboardRepo');
type Row = { revision: string; current_snapshot: model.StoredCurrencySnapshot | null; previous_snapshot: model.StoredCurrencySnapshot | null };

/** SQL-contract unit harness, not a substitute for the opt-in real PostgreSQL concurrency suite. */
function harness() {
  let row: Row = { revision: '0', current_snapshot: null, previous_snapshot: null };
  const cache = new Map<string, { value: unknown; fetched_at: Date }>();
  const bases = new Map<string, { date: string; asset: string; value: model.CurrencyBaseline }>();
  const calls: string[] = [];
  let failUpdate = false;
  let tail: Promise<unknown> = Promise.resolve();
  const now = '2026-09-30T10:00:00.000Z';
  const query = async (raw: string, params: unknown[] = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    calls.push(sql);
    if (sql.startsWith('select revision::text')) return { rows: [structuredClone(row)] };
    if (sql === 'select clock_timestamp() as now') return { rows: [{ now: new Date(now) }] };
    if (sql.startsWith('update currency_dashboard_state set')) {
      row = { revision: String(Number(row.revision) + 1), current_snapshot: JSON.parse(params[0] as string), previous_snapshot: row.current_snapshot };
      if (failUpdate) throw new Error('synthetic database write failure');
      return { rows: [structuredClone(row)] };
    }
    if (sql.startsWith('select value,fetched_at')) {
      const value = cache.get(params[0] as string);
      return { rows: value ? [structuredClone(value)] : [] };
    }
    if (sql.startsWith('insert into currency_dashboard_cache')) {
      assert.match(sql, /where excluded\.fetched_at > currency_dashboard_cache\.fetched_at/);
      const key = params[0] as string;
      const timestamp = new Date(params[2] as string);
      if (!cache.has(key) || cache.get(key)!.fetched_at < timestamp) cache.set(key, { value: JSON.parse(params[1] as string), fetched_at: timestamp });
      return { rows: [] };
    }
    if (sql.startsWith('insert into currency_dashboard_baselines')) {
      assert.match(sql, /on conflict\(date,asset\) do nothing/);
      const [date, asset, value] = params as string[];
      const key = `${date}:${asset}`;
      if (!bases.has(key)) bases.set(key, { date, asset, value: JSON.parse(value) });
      return { rows: [] };
    }
    if (sql.startsWith('select date::text,asset,value')) return { rows: structuredClone([...bases.values()].filter((base) => !params.length || base.date === params[0])) };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  const withTransaction = async <T,>(action: (client: { query: typeof query }) => Promise<T>): Promise<T> => {
    const task = tail.then(async () => {
      const before = structuredClone(row);
      try { return await action({ query }); }
      catch (error) { row = before; throw error; }
    });
    tail = task.catch(() => {});
    return task;
  };
  const source = readFileSync(new URL('../src/shared/lib/db/currencyDashboardRepo.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const output = { exports: {} as Repo };
  runInNewContext(compiled, { module: output, exports: output.exports, require(id: string) {
    if (id === '../currencyDashboardModel') return model;
    if (id === './client') return { query, withTransaction };
    if (id === './schema') return { ensureSiteSchema: async () => {} };
    throw new Error(`Unexpected dependency ${id}`);
  }, Date, JSON, Number, Error });
  return { repo: output.exports, calls, failWrites: () => { failUpdate = true; }, now };
}

const snapshot = (premium: number): model.CurrencySnapshot => ({ at: '2026-01-01T00:00:00Z', version: 'V21', data: {
  kts_cu: { prem: premium, rows: [], lmci: null, lmciDate: null },
} });
const base: model.CurrencyBaseline = { price: 100, time: '08:30', src: 'MOEX', secid: 'BR-12.26', capturedAt: '2026-09-30T05:30:00Z', quoteAt: null, stale: false };

test('currency repository locks singleton state and uses server timestamp with only one previous', async () => {
  const { repo, calls, now } = harness();
  const empty = await repo.readCurrencySnapshot();
  assert.equal(empty.revision, 0);
  assert.equal(empty.current, null);
  const first = await repo.writeCurrencySnapshot(snapshot(1), 0, 'admin:1');
  assert.equal(first.revision, 1);
  assert.equal(first.current!.at, now);
  assert.equal(first.current!.savedAt, now);
  assert.equal(first.current!.actor, 'admin:1');
  await repo.writeCurrencySnapshot(snapshot(2), 1, 'admintop:2');
  const third = await repo.writeCurrencySnapshot(snapshot(3), 2, 'admin:1');
  assert.equal(third.current!.data.kts_cu!.prem, 3);
  assert.equal(third.previous!.data.kts_cu!.prem, 2);
  assert.equal(calls.filter((sql) => sql.endsWith('for update')).length, 3);
});

test('currency repository stale concurrent requests lose CAS without changing previous snapshot', async () => {
  const { repo } = harness();
  await repo.writeCurrencySnapshot(snapshot(1), 0, 'admin:1');
  const attempts = await Promise.allSettled([2, 3, 4].map((n) => repo.writeCurrencySnapshot(snapshot(n), 1, 'admin:1')));
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  for (const result of attempts) if (result.status === 'rejected') {
    assert.ok(result.reason instanceof repo.CurrencySnapshotConflictError);
    assert.equal(result.reason.currentRevision, 2);
  }
  const state = await repo.readCurrencySnapshot();
  assert.equal(state.revision, 2);
  assert.equal(state.previous!.data.kts_cu!.prem, 1);
});

test('currency repository rollback is revisioned and unavailable rollback leaves state intact', async () => {
  const { repo } = harness();
  await assert.rejects(repo.rollbackCurrencySnapshot(0, 'admin:1'), repo.CurrencySnapshotPreviousMissingError);
  await repo.writeCurrencySnapshot(snapshot(1), 0, 'admin:1');
  await assert.rejects(repo.rollbackCurrencySnapshot(1, 'admin:1'), repo.CurrencySnapshotPreviousMissingError);
  await repo.writeCurrencySnapshot(snapshot(2), 1, 'admin:1');
  const rolled = await repo.rollbackCurrencySnapshot(2, 'admintop:2');
  assert.equal(rolled.revision, 3);
  assert.equal(rolled.current!.data.kts_cu!.prem, 1);
  assert.equal(rolled.previous!.data.kts_cu!.prem, 2);
  assert.equal(rolled.current!.actor, 'admintop:2');
  await assert.rejects(repo.writeCurrencySnapshot(snapshot(99), 2, 'admin:1'), repo.CurrencySnapshotConflictError);
  assert.equal((await repo.readCurrencySnapshot()).revision, 3);
});

test('currency repository validation failures and transaction errors preserve current/previous', async () => {
  const { repo, calls, failWrites } = harness();
  await repo.writeCurrencySnapshot(snapshot(1), 0, 'admin:1');
  const before = JSON.stringify(await repo.readCurrencySnapshot());
  const count = calls.length;
  await assert.rejects(repo.writeCurrencySnapshot({ ...snapshot(2), data: { kts_base: {} } }, 1, 'admin:1'), model.CurrencyDashboardValidationError);
  assert.equal(calls.length, count);
  failWrites();
  await assert.rejects(repo.writeCurrencySnapshot(snapshot(2), 1, 'admin:1'), /synthetic/);
  assert.equal(JSON.stringify(await repo.readCurrencySnapshot()), before);
});

test('currency source cache rejects older writes and is not touched by manual snapshot retention', async () => {
  const { repo } = harness();
  await repo.writeCurrencyCache('cbr:2026-01-01', { USD: 100 }, '2026-01-01T12:00:00Z');
  await repo.writeCurrencyCache('cbr:2026-01-01', { USD: 50 }, '2026-01-01T11:00:00Z');
  await repo.writeCurrencySnapshot(snapshot(1), 0, 'admin:1');
  await repo.writeCurrencySnapshot(snapshot(2), 1, 'admin:1');
  await repo.rollbackCurrencySnapshot(2, 'admin:1');
  assert.equal(JSON.stringify(await repo.readCurrencyCache('cbr:2026-01-01')), JSON.stringify({ value: { USD: 100 }, fetchedAt: '2026-01-01T12:00:00.000Z' }));
  assert.equal(await repo.readCurrencyCache('missing'), null);
});

test('currency baseline writes preserve existing assets while adding missing ones', async () => {
  const { repo } = harness();
  await repo.saveCurrencyBaseline('2026-09-30', { BR: base });
  const day = await repo.saveCurrencyBaseline('2026-09-30', { BR: { ...base, price: 999 }, COPPER: { ...base, secid: 'COPPER-12.26', price: 10000, premium: 240 } });
  assert.equal(day.BR!.price, 100);
  assert.equal(day.COPPER!.price, 10000);
  const stored = await repo.getCurrencyBaselines();
  assert.equal(stored['2026-09-30'].BR!.price, 100);
  await assert.rejects(repo.saveCurrencyBaseline('2025-12-31', { BR: base }), model.CurrencyDashboardValidationError);
});
