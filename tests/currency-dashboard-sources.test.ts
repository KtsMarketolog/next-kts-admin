import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCurrencySourceClient, CurrencySourceError, currencyMoscowDate, parseCurrencyCbrDaily,
  parseCurrencyCbrHistory, parseCurrencyCopperTable, parseCurrencyIssTable, validCurrencyDate,
} from '../src/shared/lib/currencyDashboardSources';

const NOW = new Date('2026-09-30T05:30:10Z');
const daily = (date = '30.09.2026') => `<ValCurs Date="${date}">${[
  ['USD', 1, '84,1234'], ['EUR', 1, '94,1234'], ['CNY', 1, '12,0123'], ['KZT', 100, '17,9876'],
].map(([code, nominal, value]) => `<Valute ID="test"><CharCode>${code}</CharCode><Nominal>${nominal}</Nominal><Value>${value}</Value></Valute>`).join('')}</ValCurs>`;
const history = (nominal = 1) => `<ValCurs><Record Date="02.01.2026"><Nominal>${nominal}</Nominal><Value>85,5</Value></Record><Record Date="30.09.2026"><Nominal>${nominal}</Nominal><Value>86,5</Value></Record></ValCurs>`;
const dailyResponse = (url: URL) => new Response(daily(url.searchParams.get('date_req')?.replaceAll('/', '.') ?? '30.09.2026'));

function client(fetcher: (url: URL, init?: RequestInit) => Promise<Response>, seed?: { value: unknown; fetchedAt: string }) {
  const cache = new Map<string, { value: unknown; fetchedAt: string }>();
  if (seed) cache.set('currency:cbr-daily', seed);
  const writes: string[] = [];
  const get = createCurrencySourceClient({
    fetch: fetcher as typeof fetch, now: () => NOW,
    readCache: async (key) => cache.get(key) ?? null,
    writeCache: async (key, value, fetchedAt) => { cache.set(key, { value, fetchedAt }); writes.push(key); },
  });
  return { get, cache, writes };
}

test('CBR parsers preserve displayed nominal, and reject malformed rates and invalid dates', () => {
  const parsed = parseCurrencyCbrDaily(daily());
  assert.equal(parsed.Date, '2026-09-30T00:00:00+03:00');
  assert.deepEqual([parsed.Valute.KZT.Value, parsed.Valute.KZT.Nominal], [17.9876, 100]);
  assert.deepEqual(parseCurrencyCbrHistory(history(100))['2026-01-02'], [85.5, 100]);
  assert.throws(() => parseCurrencyCbrDaily(daily().replace('84,1234', '84abc')));
  assert.throws(() => parseCurrencyCbrDaily(daily('30.02.2026')));
  assert.throws(() => parseCurrencyCbrDaily(`<!DOCTYPE a [<!ENTITY ext SYSTEM "file:///etc/passwd">]>${daily()}`));
  assert.throws(() => parseCurrencyCbrHistory('<html>Error</html>'));
  assert.equal(validCurrencyDate('2026-02-29'), false);
  assert.equal(validCurrencyDate('2028-02-29'), true);
  assert.equal(currencyMoscowDate(new Date('2026-09-30T21:01:00Z')), '2026-10-01');
});

test('Westmetall prices are strict, sorted, retain both official prices and year history', () => {
  const parsed = parseCurrencyCopperTable('<table><tr><td>30. September 2026</td><td>12,456.50</td><td>12,500.00</td></tr><tr><td>2. January 2026</td><td>10,456</td><td>10,500</td></tr></table>');
  assert.deepEqual(parsed, [
    { date: '2026-01-02', cash: 10456, m3: 10500 },
    { date: '2026-09-30', cash: 12456.5, m3: 12500 },
  ]);
  assert.throws(() => parseCurrencyCopperTable('<tr><td>30. September 2026</td><td>123abc</td><td>200</td></tr>'));
  assert.throws(() => parseCurrencyCopperTable('<html>Site unavailable</html>'));
});

test('only fixed source URLs are fetched; arbitrary URLs, bad dates and identifiers fail before fetch', async () => {
  let count = 0;
  const { get } = client(async (url, init) => {
    count++;
    assert.equal(url.origin + url.pathname, 'https://www.cbr.ru/scripts/XML_daily.asp');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    return dailyResponse(url);
  });
  await assert.rejects(get('https://example.com'), CurrencySourceError);
  await assert.rejects(get('cbr-daily', { url: 'http://127.0.0.1' }), CurrencySourceError);
  await assert.rejects(get('moex-candles', { secid: '../../admin', from: '2026-09-01', till: '2026-09-02' }), CurrencySourceError);
  await assert.rejects(get('moex-candles', { secid: 'CEZ6', from: '2026-01-01', till: '2026-09-30' }), CurrencySourceError);
  await assert.rejects(get('cbr-history', { from: '2025-01-01' }), CurrencySourceError);
  await assert.rejects(get('cbr-history', { till: '2026-12-01' }), CurrencySourceError);
  assert.equal(count, 0);
  const result = await get('cbr-daily');
  assert.equal(result._currencySource.stale, false);
  assert.equal(count, 2);
});

test('last good cache keeps original timestamp on network/parse failures; no false successful write', async () => {
  const old = { value: parseCurrencyCbrDaily(daily('29.09.2026')), fetchedAt: '2026-09-29T05:30:00.000Z' };
  const { get, writes } = client(async () => { throw new Error('network down'); }, old);
  const result = await get('cbr-daily');
  assert.equal(result._currencySource.stale, true);
  assert.equal(result._currencySource.fetchedAt, old.fetchedAt);
  assert.equal(result.Date, '2026-09-29T00:00:00+03:00');
  assert.deepEqual(writes, []);
  const withoutCache = client(async () => new Response('<html>Error</html>'));
  await assert.rejects(withoutCache.get('cbr-daily'), { code: 'CURRENCY_SOURCE_UNAVAILABLE' });
});

test('fresh persisted cache avoids requests; force refresh and concurrent calls share one successful fetch', async () => {
  let count = 0;
  const { get } = client(async (url) => { count++; return dailyResponse(url); }, {
    value: parseCurrencyCbrDaily(daily()), fetchedAt: '2026-09-30T05:30:00.000Z',
  });
  await get('cbr-daily');
  assert.equal(count, 0);
  const [a, b] = await Promise.all([get('cbr-daily', {}, { force: true }), get('cbr-daily', {}, { force: true })]);
  assert.equal(count, 2);
  assert.equal(a._currencySource.fetchedAt, NOW.toISOString());
  assert.deepEqual(a, b);
});

test('CBR daily payload supplies true previous effective rates in the current nominal for all dashboard deltas', async () => {
  const { get } = client(async (url) => url.searchParams.has('date_req')
    ? new Response(daily('29.09.2026').replace('<Nominal>100</Nominal><Value>17,9876</Value>', '<Nominal>10</Nominal><Value>1,7500</Value>'))
    : new Response(daily()));
  const result = await get('cbr-daily');
  assert.equal(result.PreviousDate, '2026-09-29T00:00:00+03:00');
  const valute = result.Valute as Record<string, { Nominal: number; Previous: number }>;
  assert.equal(valute.KZT.Nominal, 100);
  assert.equal(valute.KZT.Previous, 17.5);
  assert.equal(valute.USD.Previous, 84.1234);
});

test('CBR full calendar year is imported in four range requests plus Jan 1 effective rates; month filtering shares cache', async () => {
  const urls: URL[] = [];
  const { get, cache } = client(async (url) => {
    urls.push(url);
    if (url.pathname.endsWith('XML_daily.asp')) return new Response(daily('31.12.2025'));
    assert.equal(url.searchParams.get('date_req1'), '01/01/2026');
    assert.equal(url.searchParams.get('date_req2'), '01/10/2026');
    return new Response(history(url.searchParams.get('VAL_NM_RQ') === 'R01335' ? 100 : 1));
  });
  const september = await get('cbr-history', { from: '2026-09-01', till: '2026-09-30' });
  assert.deepEqual(Object.keys(september.data as object), ['2026-09-30']);
  assert.equal(urls.length, 5);
  const january = await get('cbr-history', { from: '2026-01-01', till: '2026-01-31' });
  assert.deepEqual((january.data as Record<string, { KZT: number[] }>)['2026-01-01'].KZT, [17.9876, 100]);
  assert.equal(urls.length, 5);
  assert.equal(cache.size, 1);
});

test('an empty or partial CBR archive cannot overwrite the complete persisted archive', async () => {
  let incomplete = false;
  let empty = false;
  const { get, cache } = client(async (url) => {
    if (url.pathname.endsWith('XML_daily.asp')) return new Response(daily('31.12.2025'));
    if (empty) return new Response('<ValCurs/>');
    const xml = history(url.searchParams.get('VAL_NM_RQ') === 'R01335' ? 100 : 1);
    return new Response(incomplete && url.searchParams.get('VAL_NM_RQ') === 'R01235'
      ? xml.replace(/<Record Date="30\.09\.2026">.*?<\/Record>/, '') : xml);
  });
  const good = await get('cbr-history');
  const persisted = structuredClone(cache.get('currency:cbr-history'));
  incomplete = true;
  const partial = await get('cbr-history', {}, { force: true });
  assert.equal(partial._currencySource.stale, true);
  assert.deepEqual(partial.data, good.data);
  assert.deepEqual(cache.get('currency:cbr-history'), persisted);
  incomplete = false;
  empty = true;
  assert.equal((await get('cbr-history', {}, { force: true }))._currencySource.stale, true);
  assert.deepEqual(cache.get('currency:cbr-history'), persisted);
});

test('oversized and redirect/error responses cannot replace cache', async () => {
  const over = client(async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1)));
  await assert.rejects(over.get('cbr-daily'), { code: 'CURRENCY_SOURCE_UNAVAILABLE' });
  assert.equal(over.writes.length, 0);
  const failed = client(async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(failed.get('cbr-daily'), { code: 'CURRENCY_SOURCE_UNAVAILABLE' });
  assert.throws(() => parseCurrencyIssTable({ columns: ['SECID'], data: [['CEZ6', 'too many cells']] }, ['SECID']));
  assert.throws(() => parseCurrencyIssTable({ columns: ['SECID'], data: [[{ unsafe: true }]] }, ['SECID']));
});

test('MOEX futures return only relevant assets and explicit delayed-source metadata', async () => {
  const { get } = client(async () => Response.json({
    securities: { columns: ['SECID', 'ASSETCODE', 'LASTTRADEDATE', 'PREVSETTLEPRICE'], data: [['CEZ6', 'COPPER', '2026-12-15', 12000], ['SiZ6', 'Si', '2026-12-15', 10000]] },
    marketdata: { columns: ['SECID', 'LAST', 'UPDATETIME'], data: [['CEZ6', 12100, '08:15:00'], ['SiZ6', 10020, '08:15:00']] },
  }));
  const result = await get('moex-futures');
  assert.equal(result._currencySource.delayMinutes, 15);
  assert.equal((result.securities as { data: unknown[] }).data.length, 1);
  assert.equal((result.marketdata as { data: unknown[] }).data.length, 1);
});

test('candles paginate and retain column consistency', async () => {
  const starts: string[] = [];
  const { get } = client(async (url) => {
    starts.push(url.searchParams.get('start') ?? '');
    return Response.json({ candles: { columns: ['begin', 'end', 'open', 'close'], data: starts.length === 1 ? Array.from({ length: 500 }, () => ['2026-09-01 07:00:00', '2026-09-01 07:59:59', 10, 11]) : [] } });
  });
  const result = await get('moex-candles', { secid: 'CEZ6', from: '2026-09-01', till: '2026-09-30' });
  assert.deepEqual(starts, ['0', '500']);
  assert.equal((result.candles as { data: unknown[] }).data.length, 500);
});

test('ISS short pages are not mistaken for end-of-history', async () => {
  const starts: string[] = [];
  const { get } = client(async (url) => {
    starts.push(url.searchParams.get('start') ?? '');
    const length = starts.length === 1 ? 100 : starts.length === 2 ? 50 : 0;
    return Response.json({ candles: { columns: ['begin', 'end', 'open', 'close'], data: Array.from({ length }, () => ['2026-09-01 07:00:00', '2026-09-01 07:59:59', 10, 11]) } });
  });
  const result = await get('moex-candles', { secid: 'CNYRUB_TOM', from: '2026-09-01', till: '2026-09-30' });
  assert.deepEqual(starts, ['0', '100', '150']);
  assert.equal((result.candles as { data: unknown[] }).data.length, 150);
});
