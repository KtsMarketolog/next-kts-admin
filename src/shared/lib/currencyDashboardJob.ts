import { tryAcquireSessionAdvisoryLock } from './db/client';
import { getCurrencyBaselines, readCurrencySnapshot, saveCurrencyBaseline, writeCurrencyCache } from './db/currencyDashboardRepo';
import type { CurrencyBaseline, CurrencyBaselineDay } from './currencyDashboardModel';
import { currencyMoscowDate, getCurrencySource, parseCurrencyIssTable, validCurrencyDate, type CurrencySourceKind, type CurrencySourceResult } from './currencyDashboardSources';

type Asset = 'COPPER' | 'BR';
export type CurrencyFuture = {
  secid: string; asset: Asset; expires: string; last: number | null; previous: number | null;
  volume: number; quoteAt: string | null; unit: 'USD/t' | 'USD/barrel';
};

function positive(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function minuteInMoscow(now: Date) {
  const clock = new Date(now.getTime() + 3 * 60 * 60_000);
  return clock.getUTCHours() * 60 + clock.getUTCMinutes();
}

function quoteTimestamp(tradeDate: unknown, time: unknown) {
  if (!validCurrencyDate(tradeDate) ||
      typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)) return null;
  const value = new Date(`${tradeDate}T${time}+03:00`);
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

/** Keep the author's nearest/liquid-contract choice; a day's existing baseline pins the contract. */
export function selectCurrencyFutures(payload: Record<string, unknown>, date: string, baselines: CurrencyBaselineDay = {}): Partial<Record<Asset, CurrencyFuture>> {
  const securities = parseCurrencyIssTable(payload.securities, ['SECID', 'ASSETCODE', 'LASTTRADEDATE', 'PREVSETTLEPRICE']);
  const marketdata = parseCurrencyIssTable(payload.marketdata, ['SECID', 'LAST']);
  const si = (name: string) => securities.columns.indexOf(name);
  const mi = (name: string) => marketdata.columns.indexOf(name);
  const markets = new Map(marketdata.data.map((row) => [String(row[mi('SECID')]), row]));
  const output: Partial<Record<Asset, CurrencyFuture>> = {};
  for (const asset of ['COPPER', 'BR'] as const) {
    const candidates = securities.data.filter((row) => row[si('ASSETCODE')] === asset &&
      validCurrencyDate(row[si('LASTTRADEDATE')]) && String(row[si('LASTTRADEDATE')]) >= date &&
      typeof row[si('SECID')] === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(String(row[si('SECID')])))
      .map((row): CurrencyFuture => {
        const secid = String(row[si('SECID')]);
        const market = markets.get(secid) ?? [];
        return {
          secid, asset, expires: String(row[si('LASTTRADEDATE')]),
          previous: positive(row[si('PREVSETTLEPRICE')]), last: positive(market[mi('LAST')]),
          volume: positive(market[mi('VOLTODAY')]) ?? 0,
          quoteAt: quoteTimestamp(market[mi('TRADEDATE')], market[mi('TIME')]),
          // These contracts quote USD; settlement in RUB does not change the quote unit.
          // https://www.moex.com/ru/derivatives/futures-on-commodity/ceu6
          unit: asset === 'COPPER' ? 'USD/t' : 'USD/barrel',
        };
      }).sort((a, b) => a.expires.localeCompare(b.expires) || a.secid.localeCompare(b.secid));
    if (!candidates.length) continue;
    const pinned = baselines[asset]?.secid;
    if (pinned) {
      const sameContract = candidates.find((candidate) => candidate.secid === pinned);
      if (sameContract) output[asset] = sameContract;
      // Never compare a different contract to yesterday's/another contract's baseline.
      continue;
    }
    let chosen = candidates[0];
    const daysLeft = (Date.parse(chosen.expires) - Date.parse(date)) / 86_400_000;
    if (candidates[1] && (daysLeft < 3 || candidates[1].volume > chosen.volume * 2)) chosen = candidates[1];
    output[asset] = chosen;
  }
  return output;
}

export function currencyBaselineFromQuote(future: CurrencyFuture, capturedAt: Date, premium?: number): CurrencyBaseline | null {
  const price = future.last ?? future.previous;
  if (!price) return null;
  const quoteAt = future.last !== null ? future.quoteAt : null;
  const age = quoteAt ? capturedAt.getTime() - Date.parse(quoteAt) : Infinity;
  const time = new Date(capturedAt.getTime() + 3 * 60 * 60_000).toISOString().slice(11, 16);
  return {
    price, time, secid: future.secid, capturedAt: capturedAt.toISOString(), quoteAt,
    stale: future.last === null || age < 0 || age > 20 * 60_000,
    src: future.last !== null ? 'Мосбиржа · последняя сделка, данные с задержкой до 15 минут' : 'Мосбиржа · предыдущая расчётная цена',
    ...(future.asset === 'COPPER' && premium !== undefined ? { premium } : {}),
  };
}

export type CurrencyDashboardJobResult = {
  ok: boolean; at: string; skipped?: 'running';
  baseline: { date: string; status: 'captured' | 'already-captured' | 'pending' | 'missed' | 'unavailable'; capturedAssets: Asset[] };
  sources: { kind: CurrencySourceKind; fetchedAt?: string; stale: boolean; error?: string }[];
};

type JobDependencies = {
  now: () => Date;
  acquireLock: () => Promise<null | (() => Promise<void>)>;
  getSource: typeof getCurrencySource;
  getBaselines: typeof getCurrencyBaselines;
  saveBaseline: typeof saveCurrencyBaseline;
  saveStatus: (status: CurrencyDashboardJobResult) => Promise<void>;
  getPremium: () => Promise<number | undefined>;
};

export function createCurrencyDashboardJob(deps: JobDependencies) {
  return async function run(): Promise<CurrencyDashboardJobResult> {
    const now = deps.now();
    const date = currencyMoscowDate(now);
    const result: CurrencyDashboardJobResult = {
      ok: true, at: now.toISOString(), baseline: { date, status: 'pending', capturedAssets: [] }, sources: [],
    };
    const release = await deps.acquireLock();
    if (!release) return { ...result, skipped: 'running' };
    try {
      const baselines = await deps.getBaselines();
      const current = baselines[date] ?? {};
      const captureWindow = minuteInMoscow(now) === 8 * 60 + 30;
      const readSource = async (kind: CurrencySourceKind, force = false): Promise<CurrencySourceResult | null> => {
        try {
          const data = await deps.getSource(kind, {}, { force });
          result.sources.push({ kind, ...data._currencySource });
          if (data._currencySource.stale) result.ok = false;
          return data;
        } catch {
          result.ok = false;
          result.sources.push({ kind, stale: true, error: 'Источник недоступен' });
          return null;
        }
      };
      // Do not make baseline capture wait for the first historical CBR import.
      const background = Promise.all((['cbr-daily', 'cbr-history', 'copper', 'moex-currency', 'world'] as const).map((kind) => readSource(kind)));
      const futures = await readSource('moex-futures', captureWindow && (!current.COPPER || !current.BR));
      const capturedAt = deps.now();
      if (current.COPPER && current.BR) {
        result.baseline.status = 'already-captured';
      } else if (captureWindow && minuteInMoscow(capturedAt) === 8 * 60 + 30 && currencyMoscowDate(capturedAt) === date) {
        const fetched = futures ? new Date(futures._currencySource.fetchedAt) : null;
        // Old cache is never passed off as a fresh 08:30 server observation.
        if (futures && !futures._currencySource.stale && fetched && currencyMoscowDate(fetched) === date && minuteInMoscow(fetched) === 510) {
          const chosen = selectCurrencyFutures(futures, date, current);
          const premium = await deps.getPremium();
          const added: CurrencyBaselineDay = {};
          for (const asset of ['COPPER', 'BR'] as const) {
            if (current[asset] || !chosen[asset]) continue;
            const baseline = currencyBaselineFromQuote(chosen[asset]!, capturedAt, premium);
            if (baseline) added[asset] = baseline;
          }
          if (Object.keys(added).length) {
            await deps.saveBaseline(date, added);
            result.baseline.capturedAssets = Object.keys(added) as Asset[];
            result.baseline.status = 'captured';
          } else result.baseline.status = 'unavailable';
        } else result.baseline.status = 'unavailable';
      } else if (minuteInMoscow(capturedAt) > 510) {
        // A restarted server cannot truthfully reconstruct an 08:30 quote from a later LAST.
        result.baseline.status = 'missed';
      }
      await background;
      if (result.baseline.status === 'unavailable' || result.baseline.status === 'missed') result.ok = false;
      await deps.saveStatus(result);
      return result;
    } finally { await release(); }
  };
}

export const runCurrencyDashboardJob = createCurrencyDashboardJob({
  now: () => new Date(), acquireLock: () => tryAcquireSessionAdvisoryLock('currency-dashboard-refresh-v1'),
  getSource: getCurrencySource, getBaselines: getCurrencyBaselines, saveBaseline: saveCurrencyBaseline,
  saveStatus: (status) => writeCurrencyCache('currency:job-status', status, status.at),
  getPremium: async () => (await readCurrencySnapshot()).current?.data.kts_cu?.prem ?? 240,
});
