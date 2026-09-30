import assert from 'node:assert/strict';
import test from 'node:test';
import { createCurrencyDashboardJob, currencyBaselineFromQuote, selectCurrencyFutures } from '../src/shared/lib/currencyDashboardJob';
import type { CurrencyBaselineDay, CurrencyBaselines } from '../src/shared/lib/currencyDashboardModel';
import type { CurrencySourceResult } from '../src/shared/lib/currencyDashboardSources';

const TIME = new Date('2026-09-30T05:30:05.000Z');
function futures(): CurrencySourceResult {
  return {
    securities: { columns: ['SECID', 'ASSETCODE', 'LASTTRADEDATE', 'PREVSETTLEPRICE'], data: [
      ['CEZ6', 'COPPER', '2026-12-15', 12000], ['CEH7', 'COPPER', '2027-03-16', 12100],
      ['BRV6', 'BR', '2026-10-01', 80], ['BRX6', 'BR', '2026-11-02', 81],
    ] },
    marketdata: { columns: ['SECID', 'LAST', 'VOLTODAY', 'TRADEDATE', 'TIME'], data: [
      ['CEZ6', 12020, 1000, '2026-09-30', '08:15:00'], ['CEH7', 12120, 1, '2026-09-30', '08:10:00'],
      ['BRV6', 80.5, 1000, '2026-09-30', '08:15:00'], ['BRX6', 81.5, 100, '2026-09-30', '08:15:00'],
    ] },
    _currencySource: { fetchedAt: TIME.toISOString(), stale: false, delayMinutes: 15 },
  };
}

function runner(options: { now?: Date; endTime?: Date; unavailable?: boolean; stale?: boolean; existing?: CurrencyBaselineDay; lock?: boolean } = {}) {
  const now = options.now ?? TIME;
  let clockCalls = 0;
  let releases = 0;
  const calls: { kind: string; force: boolean | undefined }[] = [];
  const saved: CurrencyBaselineDay[] = [];
  const baselines: CurrencyBaselines = options.existing ? { '2026-09-30': options.existing } : {};
  const run = createCurrencyDashboardJob({
    now: () => (++clockCalls > 1 && options.endTime ? options.endTime : now),
    acquireLock: async () => options.lock === false ? null : async () => { releases++; },
    getBaselines: async () => baselines,
    saveBaseline: async (date, day) => { saved.push(day); baselines[date] = { ...day, ...baselines[date] }; return baselines[date]; },
    getPremium: async () => 250,
    saveStatus: async () => {},
    getSource: async (kind, _params, request) => {
      calls.push({ kind, force: request?.force });
      if (kind === 'moex-futures') {
        if (options.unavailable) throw new Error('MOEX failed');
        const result = futures();
        result._currencySource.fetchedAt = now.toISOString();
        result._currencySource.stale = Boolean(options.stale);
        return result;
      }
      return { _currencySource: { fetchedAt: now.toISOString(), stale: false } };
    },
  });
  return { run, saved, calls, get releases() { return releases; } };
}

test('contract choice matches author, pins an existing same-day baseline, and never guesses RUB by price size', () => {
  const selected = selectCurrencyFutures(futures(), '2026-09-30');
  assert.equal(selected.COPPER?.secid, 'CEZ6');
  assert.equal(selected.BR?.secid, 'BRX6'); // near expiry: next contract
  const pinned = currencyBaselineFromQuote(selected.COPPER!, TIME)!;
  pinned.secid = 'CEH7';
  assert.equal(selectCurrencyFutures(futures(), '2026-09-30', { COPPER: pinned }).COPPER?.secid, 'CEH7');
  pinned.secid = 'MISSING';
  assert.equal(selectCurrencyFutures(futures(), '2026-09-30', { COPPER: pinned }).COPPER, undefined);
  const payload = futures();
  (payload.marketdata as { data: unknown[][] }).data[0][1] = 100000;
  assert.equal(selectCurrencyFutures(payload, '2026-09-30').COPPER?.unit, 'USD/t');
  assert.equal(selectCurrencyFutures(payload, '2026-09-30').COPPER?.last, 100000);
});

test('real last-trade timestamp and previous settlement fallback are not mislabeled live', () => {
  const quote = selectCurrencyFutures(futures(), '2026-09-30').COPPER!;
  const normal = currencyBaselineFromQuote(quote, TIME, 240)!;
  assert.equal(normal.price, 12020);
  assert.equal(normal.time, '08:30');
  assert.equal(normal.quoteAt, '2026-09-30T05:15:00.000Z');
  assert.equal(normal.stale, false);
  assert.equal(normal.premium, 240);
  const fallback = currencyBaselineFromQuote({ ...quote, last: null }, TIME)!;
  assert.equal(fallback.price, 12000);
  assert.equal(fallback.quoteAt, null);
  assert.equal(fallback.stale, true);
  assert.match(fallback.src, /предыдущая расчётная/);
  assert.equal(currencyBaselineFromQuote({ ...quote, last: null, previous: null }, TIME), null);
  assert.equal(currencyBaselineFromQuote({ ...quote, quoteAt: '2026-09-29T05:15:00Z' }, TIME)?.stale, true);
});

test('08:30 server job captures both assets once with premium, forced fresh fetch and cross-worker lock', async () => {
  const job = runner();
  const result = await job.run();
  assert.equal(result.ok, true);
  assert.equal(result.baseline.status, 'captured');
  assert.deepEqual(result.baseline.capturedAssets, ['COPPER', 'BR']);
  assert.equal(job.saved[0].COPPER?.premium, 250);
  assert.equal(job.saved[0].COPPER?.capturedAt, TIME.toISOString());
  assert.equal(job.calls.find((call) => call.kind === 'moex-futures')?.force, true);
  assert.equal(job.releases, 1);
  const again = await job.run();
  assert.equal(again.baseline.status, 'already-captured');
  assert.equal(job.saved.length, 1);
  const otherWorker = runner({ lock: false });
  assert.equal((await otherWorker.run()).skipped, 'running');
  assert.equal(otherWorker.calls.length, 0);
});

test('a late/restarted server never invents an 08:30 baseline', async () => {
  for (const now of [new Date('2026-09-30T05:31:00Z'), new Date('2026-09-30T10:30:00Z')]) {
    const job = runner({ now });
    const result = await job.run();
    assert.equal(result.baseline.status, 'missed');
    assert.equal(result.ok, false);
    assert.equal(job.saved.length, 0);
  }
  const before = runner({ now: new Date('2026-09-30T05:29:59Z') });
  assert.equal((await before.run()).baseline.status, 'pending');
  const slow = runner({ endTime: new Date('2026-09-30T05:31:01Z') });
  assert.equal((await slow.run()).baseline.status, 'missed');
  assert.equal(slow.saved.length, 0);
});

test('failed or cached market response does not create a fake fresh baseline', async () => {
  for (const options of [{ unavailable: true }, { stale: true }]) {
    const job = runner(options);
    const result = await job.run();
    assert.equal(result.baseline.status, 'unavailable');
    assert.equal(result.ok, false);
    assert.equal(job.saved.length, 0);
    assert.equal(job.releases, 1);
  }
});

test('partial capture fills missing asset without replacing copper and its historical premium', async () => {
  const copper = currencyBaselineFromQuote(selectCurrencyFutures(futures(), '2026-09-30').COPPER!, TIME, 240)!;
  const job = runner({ existing: { COPPER: copper } });
  const result = await job.run();
  assert.deepEqual(result.baseline.capturedAssets, ['BR']);
  assert.equal(job.saved[0].COPPER, undefined);
});
