import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENCY_SNAPSHOT_MAX_BYTES, CurrencyDashboardValidationError, validateCurrencyBaselineDay,
  validateCurrencyCacheKey, validateCurrencyDate, validateCurrencyJson, validateCurrencyRevision,
  validateCurrencySnapshot, validateCurrencyTimestamp, type CurrencySnapshot,
} from '../src/shared/lib/currencyDashboardModel';

function snapshot(): CurrencySnapshot {
  return { at: '2026-09-30T08:00:00.000Z', version: 'V21', data: {
    kts_cpsRates: { eur: 95.99, cny: 12.39, usd: null, from: '2026-09-22', to: '2026-09-23' },
    kts_an: { upd: '24.09.2026', rows: ['БКС Мир инвестиций | 80–85 | — | конец 2026 | 16.09.2026', 'СберИнвестиции, база | ~85 | ~12,5 | конец 2026 | 07.09.2026'] },
    kts_cu: { prem: 240, rows: [{ date: '2026-09-29', price: 10000 }], lmci: null, lmciDate: null },
    kts_log: [{ t: '2026-09-30T08:00:00.000Z', msg: 'Внутренний курс обновлён', risk: false }],
  } };
}

test('currency manual contract retains author defaults and zero premium', () => {
  const value = snapshot();
  assert.deepEqual(validateCurrencySnapshot(value), value);
  value.data.kts_cu!.prem = 0;
  assert.equal(validateCurrencySnapshot(value).data.kts_cu!.prem, 0);
  assert.deepEqual(validateCurrencySnapshot({ at: value.at, version: 'V21', data: {} }).data, {});
});

test('currency manual contract rejects unknown and server-owned fields at every level', () => {
  const cases = [
    { ...snapshot(), actor: 'admin:1' },
    { ...snapshot(), savedAt: '2026-09-30T08:00:00Z' },
    { ...snapshot(), version: 'V16' },
    { ...snapshot(), data: { ...snapshot().data, kts_base: {} } },
    { ...snapshot(), data: { ...snapshot().data, kts_prefs: {} } },
    { ...snapshot(), data: { ...snapshot().data, kts_cu: { ...snapshot().data.kts_cu, auto: [] } } },
    { ...snapshot(), data: { ...snapshot().data, kts_cpsRates: { ...snapshot().data.kts_cpsRates, admin: true } } },
    { ...snapshot(), data: { kts_cu: { ...snapshot().data.kts_cu, rows: [{ date: '2026-09-30', price: 1, html: 'x' }] } } },
    { ...snapshot(), data: { kts_log: [{ t: snapshot().at, msg: 'test', risk: false, extra: 1 }] } },
  ];
  for (const value of cases) assert.throws(() => validateCurrencySnapshot(value), CurrencyDashboardValidationError);
});

test('currency manual amounts reject non-finite, negative, coerced and implausibly large numbers', () => {
  for (const invalid of [-1, 0, NaN, Infinity, '12.5', 'abc123', 1e20]) {
    const value = snapshot();
    value.data.kts_cpsRates!.eur = invalid as number;
    assert.throws(() => validateCurrencySnapshot(value), CurrencyDashboardValidationError);
  }
  for (const invalid of [-1, NaN, Infinity, '240']) {
    const value = snapshot();
    value.data.kts_cu!.prem = invalid as number;
    assert.throws(() => validateCurrencySnapshot(value), CurrencyDashboardValidationError);
  }
});

test('currency date validation rejects rollover, impossible leap days, invalid time and bounds', () => {
  assert.equal(validateCurrencyDate('2028-02-29'), '2028-02-29');
  for (const value of ['2026-02-29', '2026-04-31', '2026-1-01', '1999-12-31', '2101-01-01', '2026-00-01']) {
    assert.throws(() => validateCurrencyDate(value), CurrencyDashboardValidationError);
  }
  for (const value of ['2026-09-30', '2026-09-30T24:00:00Z', '2026-02-29T12:00:00Z', '2026-09-30T12:60:00Z', '2026-09-30T12:00:00+15:00']) {
    assert.throws(() => validateCurrencyTimestamp(value), CurrencyDashboardValidationError);
  }
  assert.equal(validateCurrencyTimestamp('2026-09-30T11:00:00+03:00'), '2026-09-30T08:00:00.000Z');
  const value = snapshot();
  value.data.kts_cpsRates!.to = '2026-09-21';
  assert.throws(() => validateCurrencySnapshot(value), /окончание раньше/);
});

test('currency copper records are date-unique sorted manual prices with paired LMCI date', () => {
  const value = snapshot();
  value.data.kts_cu!.rows.push({ date: '2026-01-01', price: 9000 });
  assert.equal(validateCurrencySnapshot(value).data.kts_cu!.rows[0].date, '2026-01-01');
  value.data.kts_cu!.rows.push({ date: '2026-01-01', price: 9001 });
  assert.throws(() => validateCurrencySnapshot(value), /не должны повторяться/);
  const lmci = snapshot();
  lmci.data.kts_cu!.lmci = 100;
  assert.throws(() => validateCurrencySnapshot(lmci), /вместе/);
  lmci.data.kts_cu!.lmciDate = '2026-09-30';
  assert.equal(validateCurrencySnapshot(lmci).data.kts_cu!.lmci, 100);
});

test('currency snapshot text cannot introduce HTML, script handlers or control characters', () => {
  for (const msg of ['<img src=x onerror=alert(1)>', '<script>x</script>', 'bad\u0000text']) {
    const value = snapshot();
    value.data.kts_log![0].msg = msg;
    assert.throws(() => validateCurrencySnapshot(value), /без HTML/);
  }
  const value = snapshot();
  value.data.kts_an!.rows[0] = '<svg onload=x> | 1 | 2 | год | 30.09.2026';
  assert.throws(() => validateCurrencySnapshot(value), /без HTML/);
  value.data.kts_an!.rows[0] = 'Банк | 1 | 2 | год | 31.09.2026';
  assert.throws(() => validateCurrencySnapshot(value), /действительной/);
});

test('currency JSON rejects prototype keys, nonplain objects, accessors, cycles and sparse arrays', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const getter = Object.defineProperty({}, 'data', { get() { throw new Error('must not execute'); }, enumerable: true });
  const invalid = [JSON.parse('{"__proto__":{"x":1}}'), { deep: JSON.parse('{"constructor":{}}') }, { prototype: [] }, Object.create({ hidden: true }), new Date(), cyclic, getter, new Array(2), { x: undefined }, { x: Infinity }];
  for (const value of invalid) assert.throws(() => validateCurrencyJson(value), CurrencyDashboardValidationError);
  assert.throws(() => validateCurrencyJson({ data: 'x'.repeat(CURRENCY_SNAPSHOT_MAX_BYTES) }, CURRENCY_SNAPSHOT_MAX_BYTES), /размер/);
});

test('currency array and text limits reject data before persistence', () => {
  const value = snapshot();
  value.data.kts_log = Array.from({ length: 201 }, () => ({ t: value.at, msg: 'msg', risk: false }));
  assert.throws(() => validateCurrencySnapshot(value), /200/);
  value.data.kts_log = [{ t: value.at, msg: 'x'.repeat(2001), risk: false }];
  assert.throws(() => validateCurrencySnapshot(value), /длины/);
});

test('currency revision and internal cache key contracts are strict', () => {
  assert.equal(validateCurrencyRevision(0), 0);
  assert.equal(validateCurrencyCacheKey('cbr:2026-09-30'), 'cbr:2026-09-30');
  for (const value of [-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateCurrencyRevision(value), CurrencyDashboardValidationError);
  for (const key of ['https://evil.example/', '../secret', '', 'UPPER', 'a'.repeat(201)]) assert.throws(() => validateCurrencyCacheKey(key), CurrencyDashboardValidationError);
});

test('currency baselines validate independently from manual snapshot input', () => {
  const base = { price: 100, time: '08:30', src: 'Мосбиржа', secid: 'BR-12.26', capturedAt: snapshot().at, quoteAt: null, stale: true, premium: 0 };
  assert.deepEqual(validateCurrencyBaselineDay({ BR: base }), { BR: base });
  for (const change of [{ price: 0 }, { time: '24:00' }, { secid: '<b>' }, { capturedAt: 'yesterday' }, { stale: 'false' }, { premium: -1 }]) {
    assert.throws(() => validateCurrencyBaselineDay({ BR: { ...base, ...change } }), CurrencyDashboardValidationError);
  }
  assert.throws(() => validateCurrencyBaselineDay({ USD: base }), CurrencyDashboardValidationError);
});
