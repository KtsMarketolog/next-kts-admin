import assert from 'node:assert/strict';
import test from 'node:test';
import { createCurrencyDashboardJob } from '../src/shared/lib/currencyDashboardJob';
import type { CurrencyBaselineDay, CurrencyBaselines } from '../src/shared/lib/currencyDashboardModel';
import { createCurrencySourceClient } from '../src/shared/lib/currencyDashboardSources';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function futures(copper: number) {
  return {
    securities: { columns: ['SECID', 'ASSETCODE', 'LASTTRADEDATE', 'PREVSETTLEPRICE'], data: [
      ['CEZ6', 'COPPER', '2026-12-17', 12000], ['BRX6', 'BR', '2026-11-02', 80],
    ] },
    marketdata: { columns: ['SECID', 'LAST', 'UPDATETIME', 'VOLTODAY', 'TRADEDATE', 'TIME'], data: [
      ['CEZ6', copper, '08:15:10', 1000, '2026-09-30', '08:15:10'],
      ['BRX6', 81, '08:15:10', 1000, '2026-09-30', '08:15:10'],
    ] },
  };
}

for (const temporaryFailure of [false, true]) {
  test(`08:30 job racing a page cache read captures a real observation${temporaryFailure ? ' after retry' : ''}`, async (t) => {
    const cacheRead = deferred();
    const forcedStarted = deferred();
    t.after(() => cacheRead.resolve());
    let clock = Date.parse('2026-09-30T05:30:10.000Z');
    let requests = 0, releases = 0;
    const delays: number[] = [];
    const cache = { value: futures(11900), fetchedAt: '2026-09-30T05:29:55.000Z' };
    const writes: string[] = [];
    const source = createCurrencySourceClient({
      now: () => new Date(clock),
      readCache: async () => { await cacheRead.promise; return cache; },
      writeCache: async (key) => { writes.push(key); },
      fetch: async (input) => {
        assert.equal(new URL(String(input)).hostname, 'iss.moex.com');
        requests++;
        if (temporaryFailure && requests === 1) throw new Error('temporary network failure');
        return Response.json(futures(12500));
      },
    });
    const baselines: CurrencyBaselines = {};
    const saved: CurrencyBaselineDay[] = [];
    const run = createCurrencyDashboardJob({
      now: () => new Date(clock),
      sleep: async (ms) => { delays.push(ms); clock += ms; },
      acquireLock: async () => async () => { releases++; },
      getBaselines: async () => baselines,
      saveBaseline: async (date, day) => {
        saved.push(day);
        baselines[date] = { ...day, ...baselines[date] };
        return baselines[date];
      },
      saveStatus: async () => {}, getPremium: async () => 240,
      getSource: async (kind, params, options) => {
        if (kind !== 'moex-futures') return { _currencySource: { stale: false, fetchedAt: new Date(clock).toISOString() } };
        assert.equal(options?.force, true);
        const pending = source(kind, params, options);
        forcedStarted.resolve();
        return pending;
      },
    });
    // A page starts reading a valid cache before the scheduler's forced request.
    const page = source('moex-futures');
    const job = run();
    await forcedStarted.promise;
    cacheRead.resolve();
    const [pageData, result] = await Promise.all([page, job]);
    assert.equal(pageData._currencySource.fetchedAt, cache.fetchedAt);
    assert.equal(result.ok, true);
    assert.equal(result.baseline.status, 'captured');
    assert.deepEqual(result.baseline.capturedAssets, ['COPPER', 'BR']);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].COPPER?.price, 12500, 'the old cached price 11900 must never be fixed as 08:30');
    assert.equal(saved[0].COPPER?.time, '08:30');
    assert.equal(saved[0].COPPER?.capturedAt, new Date(clock).toISOString());
    assert.equal(saved[0].COPPER?.quoteAt, '2026-09-30T05:15:10.000Z', 'actual delayed exchange time remains explicit');
    assert.equal(saved[0].COPPER?.premium, 240);
    assert.equal(requests, temporaryFailure ? 2 : 1);
    assert.deepEqual(delays, temporaryFailure ? [5000] : [], 'a page cache hit must not consume a baseline attempt');
    assert.deepEqual(writes, ['currency:moex-futures']);
    assert.equal(releases, 1);
  });
}
