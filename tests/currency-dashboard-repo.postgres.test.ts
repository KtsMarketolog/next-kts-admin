import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';

import { applyCurrencyDashboardMigration } from '../src/shared/lib/db/currencyDashboardMigration';
import { markSiteSchemaReady } from '../src/shared/lib/db/schema';
import {
  CurrencySnapshotConflictError, CurrencySnapshotPreviousMissingError, getCurrencyBaselines,
  readCurrencyCache, readCurrencySnapshot, rollbackCurrencySnapshot, saveCurrencyBaseline,
  writeCurrencyCache, writeCurrencySnapshot,
} from '../src/shared/lib/db/currencyDashboardRepo';
import type { CurrencyBaseline, CurrencySnapshot } from '../src/shared/lib/currencyDashboardModel';

// Explicit synthetic socket-only cluster only; never connect to the ambient DATABASE_URL.
const testUrl = process.env.KTS_CURRENCY_TEST_DATABASE_URL;
const enabled = process.env.KTS_CURRENCY_POSTGRES_TEST === '1' && Boolean(testUrl);

test('currency PostgreSQL persistence is atomic, versioned and isolated from market history', { skip: !enabled }, async (t) => {
  const url = new URL(testUrl!);
  assert.equal(url.pathname, '/kts_currency_integration');
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-currency-postgres\.[^/]+\/socket$/);
  assert.equal(url.hostname, 'localhost');
  process.env.DATABASE_URL = testUrl;
  const pool = new Pool({ connectionString: testUrl });
  const client = await pool.connect();
  try { await applyCurrencyDashboardMigration(client); } finally { client.release(); }
  markSiteSchemaReady();
  const input = (price: number): CurrencySnapshot => ({ at: '2026-01-01T00:00:00.000Z', version: 'V21', data: {
    kts_cu: { prem: 240, rows: [{ date: '2026-09-30', price }], lmci: null, lmciDate: null },
  } });
  const baseline: CurrencyBaseline = { price: 100, time: '08:30', src: 'MOEX', secid: 'BR-12.26', capturedAt: '2026-09-30T05:30:00Z', quoteAt: null, stale: true };
  try {
    await t.test('first write uses database time and maintains current plus exactly one previous', async () => {
      assert.deepEqual(await readCurrencySnapshot(), { revision: 0, current: null, previous: null });
      const first = await writeCurrencySnapshot(input(100), 0, 'admin:1');
      assert.equal(first.revision, 1);
      assert.equal(first.previous, null);
      assert.equal(first.current!.at, first.current!.savedAt);
      assert.notEqual(first.current!.at, input(100).at);
      assert.equal(first.current!.actor, 'admin:1');
      const second = await writeCurrencySnapshot(input(200), 1, 'admintop:2');
      assert.equal(second.previous!.data.kts_cu!.rows[0].price, 100);
      assert.equal(second.current!.data.kts_cu!.rows[0].price, 200);
      const third = await writeCurrencySnapshot(input(300), 2, 'admin:1');
      assert.equal(third.previous!.data.kts_cu!.rows[0].price, 200);
      assert.equal((await pool.query('select count(*)::int as count from currency_dashboard_state')).rows[0].count, 1);
    });
    await t.test('concurrent writers have one winner, no lost update and no partial previous-state change', async () => {
      const before = await readCurrencySnapshot();
      const attempts = await Promise.allSettled([400, 500, 600].map((price) => writeCurrencySnapshot(input(price), before.revision, `admin:${price}`)));
      assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
      for (const result of attempts) if (result.status === 'rejected') assert.ok(result.reason instanceof CurrencySnapshotConflictError);
      const after = await readCurrencySnapshot();
      assert.equal(after.revision, before.revision + 1);
      assert.deepEqual(after.previous, before.current);
      await assert.rejects(writeCurrencySnapshot(input(1), before.revision, 'admin:1'), CurrencySnapshotConflictError);
      assert.deepEqual(await readCurrencySnapshot(), after);
    });
    await t.test('rollback increments revision, preserves displaced current and rejects stale clients', async () => {
      const before = await readCurrencySnapshot();
      const rolled = await rollbackCurrencySnapshot(before.revision, 'admin:rollback');
      assert.equal(rolled.revision, before.revision + 1);
      assert.deepEqual(rolled.current!.data, before.previous!.data);
      assert.deepEqual(rolled.previous, before.current);
      assert.equal(rolled.current!.actor, 'admin:rollback');
      await assert.rejects(rollbackCurrencySnapshot(before.revision, 'admin:1'), CurrencySnapshotConflictError);
      assert.deepEqual(await readCurrencySnapshot(), rolled);
    });
    await t.test('invalid snapshots and missing previous never change state', async () => {
      const before = await readCurrencySnapshot();
      await assert.rejects(writeCurrencySnapshot({ ...input(1), data: { kts_base: {} } }, before.revision, 'admin:1'));
      assert.deepEqual(await readCurrencySnapshot(), before);
      await pool.query('update currency_dashboard_state set previous_snapshot=null where id=1');
      const single = await readCurrencySnapshot();
      await assert.rejects(rollbackCurrencySnapshot(single.revision, 'admin:1'), CurrencySnapshotPreviousMissingError);
      assert.deepEqual(await readCurrencySnapshot(), single);
    });
    await t.test('source caches reject older overwrites and outlive snapshot saves/rollback', async () => {
      assert.equal(await readCurrencyCache('cbr:2026-01-01'), null);
      await writeCurrencyCache('cbr:2026-01-01', { USD: 100 }, '2026-01-01T12:00:00Z');
      await writeCurrencyCache('cbr:2026-01-01', { USD: 50 }, '2026-01-01T11:00:00Z');
      assert.deepEqual(await readCurrencyCache('cbr:2026-01-01'), { value: { USD: 100 }, fetchedAt: '2026-01-01T12:00:00.000Z' });
      const state = await readCurrencySnapshot();
      await writeCurrencySnapshot(input(700), state.revision, 'admin:1');
      await rollbackCurrencySnapshot(state.revision + 1, 'admin:1');
      assert.equal((await readCurrencyCache('cbr:2026-01-01'))!.fetchedAt, '2026-01-01T12:00:00.000Z');
    });
    await t.test('baseline first-write wins per asset and missing instruments can be filled later', async () => {
      const first = await saveCurrencyBaseline('2026-09-30', { BR: baseline });
      assert.equal(first.BR!.price, 100);
      const second = await saveCurrencyBaseline('2026-09-30', { BR: { ...baseline, price: 999 }, COPPER: { ...baseline, price: 10000, secid: 'COPPER-12.26', premium: 240 } });
      assert.equal(second.BR!.price, 100);
      assert.equal(second.COPPER!.price, 10000);
      await Promise.all([200, 300].map((price) => saveCurrencyBaseline('2026-10-01', { BR: { ...baseline, price } })));
      const all = await getCurrencyBaselines();
      assert.equal(all['2026-09-30'].BR!.price, 100);
      assert.ok([200, 300].includes(all['2026-10-01'].BR!.price));
      assert.equal((await pool.query('select count(*)::int as count from currency_dashboard_baselines')).rows[0].count, 3);
    });
  } finally {
    await pool.end();
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
