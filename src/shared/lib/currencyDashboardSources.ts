import { readCurrencyCache, writeCurrencyCache } from './db/currencyDashboardRepo';

export const CURRENCY_HISTORY_START = '2026-01-01';
export const CURRENCY_SOURCE_KINDS = ['cbr-daily', 'cbr-history', 'moex-currency', 'moex-futures', 'moex-candles', 'world', 'copper'] as const;
export type CurrencySourceKind = typeof CURRENCY_SOURCE_KINDS[number];
export type CurrencySourceMetadata = { fetchedAt: string; stale: boolean; error?: string; delayMinutes?: number };
export type CurrencySourceResult = Record<string, unknown> & { _currencySource: CurrencySourceMetadata };
export type CurrencyRateCode = 'USD' | 'EUR' | 'CNY' | 'KZT';
export type CurrencyHistory = Record<string, Partial<Record<CurrencyRateCode, [number, number]>>>;
export type IssTable = { columns: string[]; data: unknown[][] };
export type CopperRow = { date: string; cash: number; m3: number };

type CacheRecord = { value: unknown; fetchedAt: string };
type SourceDependencies = {
  fetch: typeof fetch;
  now: () => Date;
  readCache: (key: string) => Promise<CacheRecord | null>;
  writeCache: (key: string, value: unknown, fetchedAt: string) => Promise<void>;
};

const CBR_IDS: Record<CurrencyRateCode, string> = { USD: 'R01235', EUR: 'R01239', CNY: 'R01375', KZT: 'R01335' };
const CBR_NAMES: Record<CurrencyRateCode, string> = { USD: 'Доллар США', EUR: 'Евро', CNY: 'Китайский юань', KZT: 'Казахстанский тенге' };
const RATE_CODES = Object.keys(CBR_IDS) as CurrencyRateCode[];
const SOURCE_TTL: Record<CurrencySourceKind, number> = {
  'cbr-daily': 60 * 60_000, 'cbr-history': 6 * 60 * 60_000,
  'moex-currency': 30_000, 'moex-futures': 30_000, 'moex-candles': 15 * 60_000,
  world: 60 * 60_000, copper: 60 * 60_000,
};
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = 'kts-impex.ru protected currency dashboard';

export class CurrencySourceError extends Error {
  constructor(public readonly code: 'INVALID_CURRENCY_SOURCE' | 'INVALID_CURRENCY_SOURCE_PARAMS' | 'CURRENCY_SOURCE_UNAVAILABLE') {
    super({
      INVALID_CURRENCY_SOURCE: 'Неизвестный источник курсов.',
      INVALID_CURRENCY_SOURCE_PARAMS: 'Некорректные параметры запроса курсов.',
      CURRENCY_SOURCE_UNAVAILABLE: 'Источник временно недоступен. Попробуйте обновить данные позже.',
    }[code]);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positive(value: string | undefined) {
  if (!value || !/^\d+(?:[.,]\d+)?$/.test(value.trim())) throw new Error('Invalid source number');
  const number = Number(value.trim().replace(',', '.'));
  if (!Number.isFinite(number) || number <= 0 || number > 1e9) throw new Error('Invalid source number');
  return number;
}

export function validCurrencyDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function currencyMoscowDate(now = new Date()) {
  return new Date(now.getTime() + 3 * 60 * 60_000).toISOString().slice(0, 10);
}

function xmlDate(value: string | undefined) {
  const match = value?.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : '';
  if (!validCurrencyDate(iso)) throw new Error('Invalid source date');
  return iso;
}

function cbrDate(value: string) {
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

function rejectXmlEntities(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unexpected XML entities');
}

export function parseCurrencyCbrDaily(xml: string) {
  rejectXmlEntities(xml);
  const date = xmlDate(xml.match(/<ValCurs\b[^>]*\bDate=["']([^"']+)["']/)?.[1]);
  const blocks = xml.match(/<Valute\b[^>]*>[\s\S]*?<\/Valute>/g) ?? [];
  const Valute = {} as Record<CurrencyRateCode, { ID: string; CharCode: CurrencyRateCode; Name: string; Nominal: number; Value: number }>;
  for (const code of RATE_CODES) {
    const block = blocks.find((entry) => entry.includes(`<CharCode>${code}</CharCode>`));
    if (!block) throw new Error(`Missing CBR currency ${code}`);
    const nominal = positive(block.match(/<Nominal>([^<]+)<\/Nominal>/)?.[1]);
    if (!Number.isInteger(nominal)) throw new Error('Invalid CBR nominal');
    Valute[code] = {
      ID: CBR_IDS[code], CharCode: code, Name: CBR_NAMES[code], Nominal: nominal,
      Value: positive(block.match(/<Value>([^<]+)<\/Value>/)?.[1]),
    };
  }
  return { Date: `${date}T00:00:00+03:00`, Valute };
}

export function parseCurrencyCbrHistory(xml: string): Record<string, [number, number]> {
  rejectXmlEntities(xml);
  if (!/<ValCurs\b/.test(xml)) throw new Error('Invalid CBR history');
  const data: Record<string, [number, number]> = {};
  for (const record of xml.match(/<Record\b[^>]*>[\s\S]*?<\/Record>/g) ?? []) {
    const date = xmlDate(record.match(/\bDate=["']([^"']+)["']/)?.[1]);
    const nominal = positive(record.match(/<Nominal>([^<]+)<\/Nominal>/)?.[1]);
    if (!Number.isInteger(nominal)) throw new Error('Invalid CBR nominal');
    data[date] = [positive(record.match(/<Value>([^<]+)<\/Value>/)?.[1]), nominal];
  }
  return data;
}

export function parseCurrencyCopperTable(html: string): CopperRow[] {
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const rows = new Map<string, CopperRow>();
  for (const row of html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = (row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) ?? [])
      .map((cell) => cell.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ' ').trim());
    const match = cells[0]?.match(/^(\d{1,2})\.\s+([a-z]+)\s+(\d{4})$/i);
    if (!match) continue;
    const month = months.indexOf(match[2].toLowerCase()) + 1;
    const date = `${match[3]}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    if (!validCurrencyDate(date) || date < CURRENCY_HISTORY_START) continue;
    // The English table uses commas for thousands, not decimal separators.
    const parseCell = (cell: string | undefined) => {
      if (!cell || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(cell)) throw new Error('Invalid copper price');
      return positive(cell.replaceAll(',', ''));
    };
    rows.set(date, { date, cash: parseCell(cells[1]), m3: parseCell(cells[2]) });
  }
  if (!rows.size) throw new Error('Copper table is empty or changed');
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function parseCurrencyIssTable(value: unknown, requiredColumns: string[]): IssTable {
  if (!object(value) || !Array.isArray(value.columns) || !value.columns.every((column) => typeof column === 'string') ||
      !Array.isArray(value.data) || value.data.length > 10_000 ||
      !value.data.every((row) => Array.isArray(row) && row.length <= (value.columns as unknown[]).length &&
        row.every((cell) => cell === null || typeof cell === 'string' || (typeof cell === 'number' && Number.isFinite(cell))))) {
    throw new Error('Invalid ISS table');
  }
  if (requiredColumns.some((column) => !(value.columns as string[]).includes(column))) throw new Error('ISS schema changed');
  return { columns: value.columns as string[], data: value.data as unknown[][] };
}

function dateRange(params: Record<string, unknown>, now: Date, maxDays?: number) {
  const from = params.from ?? CURRENCY_HISTORY_START;
  const till = params.till ?? currencyMoscowDate(now);
  const tomorrow = currencyMoscowDate(new Date(now.getTime() + 86_400_000));
  if (!validCurrencyDate(from) || !validCurrencyDate(till) || from < CURRENCY_HISTORY_START || till < from || till > tomorrow ||
    (maxDays !== undefined && Date.parse(till) - Date.parse(from) > maxDays * 86_400_000)) {
    throw new CurrencySourceError('INVALID_CURRENCY_SOURCE_PARAMS');
  }
  return { from, till };
}

async function fetchText(url: URL, deps: SourceDependencies) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await deps.fetch(url, {
      signal: controller.signal, redirect: 'error', cache: 'no-store',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,application/xml,text/html;q=0.8' },
    });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('Source response failed');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error('Source response is too large');
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally { clearTimeout(timeout); }
}

async function fetchJson(url: URL, deps: SourceDependencies) {
  const parsed: unknown = JSON.parse(await fetchText(url, deps));
  if (!object(parsed)) throw new Error('Source JSON is not an object');
  return parsed;
}

function issUrl(path: string, params: Record<string, string>) {
  const url = new URL(`https://iss.moex.com/iss/${path}`);
  url.searchParams.set('iss.meta', 'off');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

async function loadSource(kind: CurrencySourceKind, params: Record<string, unknown>, deps: SourceDependencies, cached: CacheRecord | null) {
  const now = deps.now();
  if (kind === 'cbr-daily') {
    const current = parseCurrencyCbrDaily(await fetchText(new URL('https://www.cbr.ru/scripts/XML_daily.asp'), deps));
    const previousDay = new Date(Date.parse(`${current.Date.slice(0, 10)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const previousUrl = new URL('https://www.cbr.ru/scripts/XML_daily.asp');
    previousUrl.searchParams.set('date_req', cbrDate(previousDay));
    const previous = parseCurrencyCbrDaily(await fetchText(previousUrl, deps));
    if (previous.Date >= current.Date) throw new Error('CBR previous rate date did not precede current rate date');
    const Valute = Object.fromEntries(RATE_CODES.map((code) => [code, {
      ...current.Valute[code],
      Previous: previous.Valute[code].Value / previous.Valute[code].Nominal * current.Valute[code].Nominal,
    }]));
    return { ...current, PreviousDate: previous.Date, Valute };
  }
  if (kind === 'cbr-history') {
    const end = currencyMoscowDate(new Date(now.getTime() + 86_400_000));
    const data: CurrencyHistory = {};
    const seedUrl = new URL('https://www.cbr.ru/scripts/XML_daily.asp');
    seedUrl.searchParams.set('date_req', cbrDate(CURRENCY_HISTORY_START));
    const [seed] = await Promise.all([
      fetchText(seedUrl, deps).then(parseCurrencyCbrDaily),
      ...RATE_CODES.map(async (code) => {
        const url = new URL('https://www.cbr.ru/scripts/XML_dynamic.asp');
        url.searchParams.set('date_req1', cbrDate(CURRENCY_HISTORY_START));
        url.searchParams.set('date_req2', cbrDate(end));
        url.searchParams.set('VAL_NM_RQ', CBR_IDS[code]);
        const history = parseCurrencyCbrHistory(await fetchText(url, deps));
        if (!Object.keys(history).length && end > '2026-01-15') throw new Error('Empty CBR history for currency');
        for (const [date, value] of Object.entries(history)) {
          if (date >= CURRENCY_HISTORY_START && date <= end) (data[date] ??= {})[code] = value;
        }
      }),
    ]);
    // Jan 1 may be a holiday. Store the rate legally effective that day, not a made-up quote.
    data[CURRENCY_HISTORY_START] ??= {};
    for (const code of RATE_CODES) data[CURRENCY_HISTORY_START][code] ??= [seed.Valute[code].Value, seed.Valute[code].Nominal];
    if (Object.values(data).some((day) => RATE_CODES.some((code) => !day[code]))) throw new Error('Incomplete CBR history across currencies');
    const old = object(cached?.value) && object(cached.value.data) ? cached.value.data : {};
    const oldLast = Object.keys(old).sort().at(-1);
    const newLast = Object.keys(data).sort().at(-1);
    if (oldLast && newLast && newLast < oldLast) throw new Error('CBR history response regressed');
    // A provider may shorten an archive response. Never discard already verified history.
    return { data: { ...old, ...data } };
  }
  if (kind === 'moex-currency') {
    const data = await fetchJson(issUrl('engines/currency/markets/selt/boards/CETS/securities.json', {
      'iss.only': 'marketdata', securities: 'CNYRUB_TOM,KZTRUB_TOM',
    }), deps);
    return { marketdata: parseCurrencyIssTable(data.marketdata, ['SECID', 'LAST', 'UPDATETIME']) };
  }
  if (kind === 'moex-futures') {
    const data = await fetchJson(issUrl('engines/futures/markets/forts/securities.json', {
      'iss.only': 'securities,marketdata',
      'securities.columns': 'SECID,SHORTNAME,ASSETCODE,LASTTRADEDATE,PREVSETTLEPRICE,CURRENCYID',
      'marketdata.columns': 'SECID,LAST,LASTTOPREVPRICE,UPDATETIME,SYSTIME,VOLTODAY,OPEN,TRADEDATE,TIME',
    }), deps);
    const securities = parseCurrencyIssTable(data.securities, ['SECID', 'ASSETCODE', 'LASTTRADEDATE', 'PREVSETTLEPRICE']);
    const marketdata = parseCurrencyIssTable(data.marketdata, ['SECID', 'LAST', 'UPDATETIME']);
    securities.data = securities.data.filter((row) => ['COPPER', 'BR'].includes(String(row[securities.columns.indexOf('ASSETCODE')])));
    const ids = new Set(securities.data.map((row) => row[securities.columns.indexOf('SECID')]));
    if (!securities.data.length) throw new Error('No supported futures in ISS');
    marketdata.data = marketdata.data.filter((row) => ids.has(row[marketdata.columns.indexOf('SECID')]));
    return { securities, marketdata };
  }
  if (kind === 'moex-candles') {
    const { from, till } = dateRange(params, now, 35);
    const secid = String(params.secid);
    const path = secid === 'CNYRUB_TOM'
      ? 'engines/currency/markets/selt/boards/CETS/securities/CNYRUB_TOM/candles.json'
      : `engines/futures/markets/forts/securities/${secid}/candles.json`;
    const rows: unknown[][] = [];
    let columns: string[] = [];
    // ISS paginates candles. A month of hourly data fits within this strict bound.
    for (let page = 0; page < 24; page++) {
      const start = rows.length;
      const data = await fetchJson(issUrl(path, { interval: '60', from, till, start: String(start), limit: '500' }), deps);
      const table = parseCurrencyIssTable(data.candles, ['begin', 'end', 'open', 'close']);
      if (columns.length && JSON.stringify(columns) !== JSON.stringify(table.columns)) throw new Error('ISS columns changed between pages');
      columns = table.columns;
      rows.push(...table.data);
      if (!table.data.length) return { candles: { columns, data: rows } };
      if (rows.length > 1600) throw new Error('ISS candle response exceeds expected hourly range');
    }
    throw new Error('ISS candle range exceeds the response limit');
  }
  if (kind === 'world') {
    const data = await fetchJson(new URL('https://open.er-api.com/v6/latest/USD'), deps);
    if (data.result !== 'success' || data.base_code !== 'USD' || !object(data.rates) ||
      !['USD', 'EUR', 'CNY', 'KZT', 'RUB'].every((code) => typeof (data.rates as Record<string, unknown>)[code] === 'number' && Number((data.rates as Record<string, unknown>)[code]) > 0)) {
      throw new Error('Invalid world currency rates');
    }
    return data;
  }
  const rows = parseCurrencyCopperTable(await fetchText(new URL('https://www.westmetall.com/en/markdaten.php?action=table&field=LME_Cu_cash'), deps));
  const oldRows = object(cached?.value) && Array.isArray(cached.value.rows) ? cached.value.rows as CopperRow[] : [];
  const merged = new Map(oldRows.map((row) => [row.date, row]));
  for (const row of rows) merged.set(row.date, row);
  return {
    rows: [...merged.values()].filter((row) => row.date >= CURRENCY_HISTORY_START && row.date <= currencyMoscowDate(now)).sort((a, b) => a.date.localeCompare(b.date)),
    fetched_at: now.toISOString(), source: 'Westmetall (LME Official Prices)',
  };
}

export function createCurrencySourceClient(deps: SourceDependencies) {
  const pending = new Map<string, Promise<CurrencySourceResult>>();
  const failures = new Map<string, number>();
  return async function getSource(kindInput: string, paramsInput: Record<string, unknown> = {}, options: { force?: boolean } = {}): Promise<CurrencySourceResult> {
    if (!(CURRENCY_SOURCE_KINDS as readonly string[]).includes(kindInput)) throw new CurrencySourceError('INVALID_CURRENCY_SOURCE');
    if (!object(paramsInput)) throw new CurrencySourceError('INVALID_CURRENCY_SOURCE_PARAMS');
    const kind = kindInput as CurrencySourceKind;
    const now = deps.now();
    const params = paramsInput;
    const allowed = kind === 'moex-candles' ? ['secid', 'from', 'till'] : kind === 'cbr-history' ? ['from', 'till'] : [];
    if (Object.keys(params).some((key) => !allowed.includes(key))) throw new CurrencySourceError('INVALID_CURRENCY_SOURCE_PARAMS');
    const range = kind === 'cbr-history' || kind === 'moex-candles' ? dateRange(params, now, kind === 'moex-candles' ? 35 : undefined) : null;
    if (kind === 'moex-candles' && (typeof params.secid !== 'string' || !/^(?:CNYRUB_TOM|CE[FGHJKMNQUVXZ]\d{1,2}|BR[FGHJKMNQUVXZ]\d{1,2})$/.test(params.secid))) {
      throw new CurrencySourceError('INVALID_CURRENCY_SOURCE_PARAMS');
    }
    const key = `currency:${kind}${kind === 'moex-candles' ? `:${String(params.secid).toLowerCase()}:${range!.from}:${range!.till}` : ''}`;
    const filterHistory = (result: CurrencySourceResult): CurrencySourceResult => kind === 'cbr-history' && object(result.data)
      ? { ...result, data: Object.fromEntries(Object.entries(result.data).filter(([date]) => date >= range!.from && date <= range!.till)) }
      : result;
    if (pending.has(key)) return filterHistory(await pending.get(key)!);
    const task = (async () => {
      const cached = await deps.readCache(key);
      const decorate = (value: Record<string, unknown>, fetchedAt: string, stale: boolean): CurrencySourceResult => ({
        ...value, _currencySource: { fetchedAt, stale, ...(stale ? { error: 'Источник временно недоступен; показаны последние сохранённые данные' } : {}), ...(kind.startsWith('moex-') ? { delayMinutes: 15 } : {}) },
      });
      const validCache = cached && object(cached.value) && Number.isFinite(Date.parse(cached.fetchedAt));
      const age = cached ? now.getTime() - Date.parse(cached.fetchedAt) : Infinity;
      if (!options.force && validCache && age >= 0 && age < SOURCE_TTL[kind]) return decorate(cached.value as Record<string, unknown>, cached.fetchedAt, false);
      if (!options.force && now.getTime() - (failures.get(key) ?? 0) < 30_000) {
        if (validCache) return decorate(cached.value as Record<string, unknown>, cached.fetchedAt, true);
        throw new CurrencySourceError('CURRENCY_SOURCE_UNAVAILABLE');
      }
      try {
        const value = await loadSource(kind, params, deps, cached);
        const fetchedAt = deps.now().toISOString();
        await deps.writeCache(key, value, fetchedAt);
        failures.delete(key);
        return decorate(value, fetchedAt, false);
      } catch {
        failures.set(key, deps.now().getTime());
        if (validCache) return decorate(cached.value as Record<string, unknown>, cached.fetchedAt, true);
        throw new CurrencySourceError('CURRENCY_SOURCE_UNAVAILABLE');
      }
    })();
    pending.set(key, task);
    try { return filterHistory(await task); } finally { pending.delete(key); }
  };
}

export const getCurrencySource = createCurrencySourceClient({
  fetch: (...args) => fetch(...args), now: () => new Date(), readCache: readCurrencyCache, writeCache: writeCurrencyCache,
});
