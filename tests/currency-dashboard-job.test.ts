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

function runner(options: {
  now?: Date; endTime?: Date; unavailable?: boolean; stale?: boolean; existing?: CurrencyBaselineDay; lock?: boolean;
  responses?: (CurrencySourceResult | Error)[]; responseTimes?: Date[]; wakeTime?: Date; baselineTime?: Date;
  premiumTime?: Date; saveTime?: Date;
  backgroundGate?: Promise<void>; backgroundFailed?: boolean;
} = {}) {
  const now = options.now ?? TIME;
  let clock = now;
  let attempts = 0;
  let releases = 0;
  const sleeps: number[] = [];
  const calls: { kind: string; force: boolean | undefined }[] = [];
  const saved: CurrencyBaselineDay[] = [];
  const baselines: CurrencyBaselines = options.existing ? { '2026-09-30': options.existing } : {};
  const run = createCurrencyDashboardJob({
    now: () => clock,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); clock = options.wakeTime ?? new Date(clock.getTime() + milliseconds); },
    acquireLock: async () => options.lock === false ? null : async () => { releases++; },
    getBaselines: async () => { if (options.baselineTime) clock = options.baselineTime; return baselines; },
    saveBaseline: async (date, day) => {
      if (options.saveTime) clock = options.saveTime;
      saved.push(day);
      baselines[date] = { ...day, ...baselines[date] };
      return baselines[date];
    },
    getPremium: async () => { if (options.premiumTime) clock = options.premiumTime; return 250; },
    saveStatus: async () => {},
    getSource: async (kind, _params, request) => {
      calls.push({ kind, force: request?.force });
      if (kind === 'moex-futures') {
        const attempt = attempts++;
        clock = options.responseTimes?.[attempt] ?? options.endTime ?? clock;
        if (options.unavailable) throw new Error('MOEX failed');
        if (options.responses?.length) {
          const response = options.responses[Math.min(attempt, options.responses.length - 1)];
          if (response instanceof Error) throw response;
          return response;
        }
        const result = futures();
        result._currencySource.fetchedAt = now.toISOString();
        result._currencySource.stale = Boolean(options.stale);
        return result;
      }
      await options.backgroundGate;
      if (options.backgroundFailed && kind === 'world') throw new Error('World source failed');
      return { _currencySource: { fetchedAt: now.toISOString(), stale: false } };
    },
  });
  return { run, saved, calls, sleeps, get releases() { return releases; } };
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
  assert.equal(job.calls.filter((call) => call.kind === 'cbr-base-history').length, 1, 'shared V25 archive is warmed independently of page views');
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

test('capture retries failed, stale, old, malformed, future-dated and empty responses without retaining a false failure', async () => {
  const stale = futures();
  stale._currencySource.stale = true;
  const old = futures();
  old._currencySource.fetchedAt = '2026-09-30T05:29:59.999Z';
  const malformed = futures();
  malformed._currencySource.fetchedAt = 'not a timestamp';
  const future = futures();
  future._currencySource.fetchedAt = '2026-09-30T05:30:55.000Z';
  const empty = futures();
  (empty.securities as { data: unknown[][] }).data = [];
  const invalidTable = futures();
  invalidTable.marketdata = { columns: ['wrong'], data: [] };
  for (const response of [new Error('MOEX temporarily unavailable'), stale, old, malformed, future, empty, invalidTable]) {
    const job = runner({ responses: [response, futures()] });
    const result = await job.run();
    assert.equal(result.ok, true);
    assert.equal(result.baseline.status, 'captured');
    assert.equal(job.saved.length, 1);
    assert.equal(job.saved[0].COPPER?.capturedAt, '2026-09-30T05:30:10.000Z');
    assert.deepEqual(job.sleeps, [5_000]);
    assert.deepEqual(job.calls.filter((call) => call.kind === 'moex-futures').map((call) => call.force), [true, true]);
    assert.equal(result.sources.filter((source) => source.kind === 'moex-futures').length, 1);
    assert.equal(result.sources.find((source) => source.kind === 'moex-futures')?.stale, false);
  }
});

test('retry budget is bounded and never changes a missing baseline into a successful capture', async () => {
  for (const options of [{ unavailable: true }, { stale: true }]) {
    const job = runner(options);
    const result = await job.run();
    assert.equal(result.ok, false);
    assert.equal(result.baseline.status, 'unavailable');
    assert.equal(job.calls.filter((call) => call.kind === 'moex-futures').length, 3);
    assert.deepEqual(job.sleeps, [5_000, 5_000]);
    assert.deepEqual(job.saved, []);
  }
});

test('a partial response is saved immediately and only the missing asset is retried', async () => {
  const copperOnly = futures();
  const securities = copperOnly.securities as { data: unknown[][] };
  securities.data = securities.data.filter((row) => row[1] === 'COPPER');
  const later = futures();
  (later.marketdata as { data: unknown[][] }).data[0][1] = 15000;
  const job = runner({ responses: [copperOnly, later] });
  const result = await job.run();
  assert.equal(result.ok, true);
  assert.equal(result.baseline.status, 'captured');
  assert.deepEqual(result.baseline.capturedAssets, ['COPPER', 'BR']);
  assert.equal(job.saved.length, 2);
  assert.equal(job.saved[0].COPPER?.price, 12020);
  assert.equal(job.saved[0].COPPER?.premium, 250);
  assert.equal(job.saved[0].COPPER?.capturedAt, TIME.toISOString());
  assert.equal(job.saved[1].COPPER, undefined);
  assert.equal(job.saved[1].BR?.capturedAt, '2026-09-30T05:30:10.000Z');

  const incomplete = runner({ responses: [copperOnly] });
  const exhausted = await incomplete.run();
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.baseline.status, 'unavailable');
  assert.deepEqual(exhausted.baseline.capturedAssets, ['COPPER']);
  assert.equal(incomplete.saved.length, 1);
  assert.equal(incomplete.calls.filter((call) => call.kind === 'moex-futures').length, 3);
});

test('a future trade is rejected per asset, rather than saved as a stale 08:30 baseline', async () => {
  const future = futures();
  const copperRow = (future.marketdata as { data: unknown[][] }).data[0];
  copperRow[1] = 15000;
  copperRow[4] = '08:31:00';
  const job = runner({ responses: [future, futures()] });
  const result = await job.run();
  assert.equal(result.ok, true);
  assert.deepEqual(result.baseline.capturedAssets, ['BR', 'COPPER']);
  assert.equal(job.saved[0].COPPER, undefined);
  assert.equal(job.saved[1].COPPER?.price, 12020);
  assert.equal(job.saved[1].COPPER?.quoteAt, '2026-09-30T05:15:00.000Z');
  assert.equal(job.saved[1].BR, undefined);
});

test('retries cannot use a response completed at or after 08:31, including a date change', async () => {
  for (const endTime of [new Date('2026-09-30T05:31:00.000Z'), new Date('2026-10-01T05:30:00.000Z')]) {
    const job = runner({ responses: [new Error('Temporary failure'), futures()], responseTimes: [TIME, endTime] });
    const result = await job.run();
    assert.equal(result.baseline.status, 'missed');
    assert.equal(result.ok, false);
    assert.deepEqual(job.saved, []);
    assert.equal(job.calls.filter((call) => call.kind === 'moex-futures').length, 2);
    assert.deepEqual(job.sleeps, [5_000]);
  }
  const lastMillisecond = new Date('2026-09-30T05:30:59.999Z');
  const last = runner({ responseTimes: [lastMillisecond] });
  assert.equal((await last.run()).baseline.status, 'captured');
  assert.equal(last.saved[0].COPPER?.capturedAt, lastMillisecond.toISOString());
});

test('capture window is rechecked after baseline reads and after retry sleep', async () => {
  const end = new Date('2026-09-30T05:31:00.000Z');
  const baselineRead = runner({ baselineTime: end });
  assert.equal((await baselineRead.run()).baseline.status, 'missed');
  assert.equal(baselineRead.calls.filter((call) => call.kind === 'moex-futures').length, 0);
  assert.deepEqual(baselineRead.saved, []);

  const overslept = runner({ responses: [new Error('Temporary failure'), futures()], wakeTime: end });
  assert.equal((await overslept.run()).baseline.status, 'missed');
  assert.equal(overslept.calls.filter((call) => call.kind === 'moex-futures').length, 1);
  assert.deepEqual(overslept.saved, []);

  const tooLateForPause = runner({ now: new Date('2026-09-30T05:30:55.000Z'), unavailable: true });
  assert.equal((await tooLateForPause.run()).baseline.status, 'unavailable');
  assert.equal(tooLateForPause.calls.filter((call) => call.kind === 'moex-futures').length, 1);
  assert.deepEqual(tooLateForPause.sleeps, []);
});

test('slow background history does not delay capture or retries, but lock remains until it finishes', async () => {
  let releaseBackground!: () => void;
  const backgroundGate = new Promise<void>((resolve) => { releaseBackground = resolve; });
  const job = runner({ responses: [new Error('Temporary failure'), futures()], backgroundGate });
  const pending = job.run();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(job.saved.length, 1, 'capture and retry finish before background imports');
  assert.equal(job.saved[0].COPPER?.capturedAt, '2026-09-30T05:30:10.000Z');
  assert.equal(job.releases, 0);
  releaseBackground();
  assert.equal((await pending).ok, true);
  assert.equal(job.releases, 1);
});

test('a recovered baseline attempt cannot conceal another source failure', async () => {
  const job = runner({ responses: [new Error('Temporary failure'), futures()], backgroundFailed: true });
  const result = await job.run();
  assert.equal(result.baseline.status, 'captured');
  assert.equal(result.ok, false);
  assert.equal(result.sources.find((source) => source.kind === 'world')?.stale, true);
  assert.equal(result.sources.find((source) => source.kind === 'moex-futures')?.stale, false);
});

test('a slow premium read or baseline save retains the actual earlier observation timestamp', async () => {
  const later = new Date('2026-09-30T05:31:10.000Z');
  for (const options of [{ premiumTime: later }, { saveTime: later }]) {
    const job = runner(options);
    const result = await job.run();
    assert.equal(result.ok, true);
    assert.equal(result.baseline.status, 'captured');
    assert.equal(job.saved.length, 1);
    for (const asset of ['COPPER', 'BR'] as const) {
      assert.equal(job.saved[0][asset]?.capturedAt, TIME.toISOString());
      assert.equal(job.saved[0][asset]?.time, '08:30');
      assert.equal(job.saved[0][asset]?.quoteAt, '2026-09-30T05:15:00.000Z');
    }
    assert.deepEqual(job.sleeps, []);
    assert.equal(job.calls.filter((call) => call.kind === 'moex-futures').length, 1);
  }
});

test('a backward clock or a different date during retry cannot create a fake baseline', async () => {
  for (const wakeTime of [
    new Date('2026-09-30T05:29:59.000Z'),
    new Date('2026-09-29T05:30:10.000Z'),
    new Date('2026-10-01T05:30:10.000Z'),
  ]) {
    const job = runner({ responses: [new Error('Temporary failure'), futures()], wakeTime });
    const result = await job.run();
    assert.equal(result.ok, false);
    assert.equal(result.baseline.status, wakeTime.getTime() > TIME.getTime() ? 'missed' : 'unavailable');
    assert.deepEqual(job.saved, []);
    assert.deepEqual(result.baseline.capturedAssets, []);
    assert.deepEqual(job.sleeps, [5_000]);
    assert.equal(job.calls.filter((call) => call.kind === 'moex-futures').length, 1);
  }
});

test('a late retry preserves the asset captured inside the window but reports the missing asset', async () => {
  const copperOnly = futures();
  const securities = copperOnly.securities as { data: unknown[][] };
  securities.data = securities.data.filter((row) => row[1] === 'COPPER');
  const job = runner({
    responses: [copperOnly, futures()],
    responseTimes: [TIME, new Date('2026-09-30T05:31:00.000Z')],
  });
  const result = await job.run();
  assert.equal(result.ok, false);
  assert.equal(result.baseline.status, 'missed');
  assert.deepEqual(result.baseline.capturedAssets, ['COPPER']);
  assert.equal(job.saved.length, 1);
  assert.equal(job.saved[0].COPPER?.capturedAt, TIME.toISOString());
  assert.equal(job.saved[0].COPPER?.price, 12020);
  assert.equal(job.saved[0].BR, undefined);
  assert.equal(job.calls.filter((call) => call.kind === 'moex-futures').length, 2);
});
