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
  sleep?: (milliseconds: number) => Promise<void>;
  acquireLock: () => Promise<null | (() => Promise<void>)>;
  getSource: typeof getCurrencySource;
  getBaselines: typeof getCurrencyBaselines;
  saveBaseline: typeof saveCurrencyBaseline;
  saveStatus: (status: CurrencyDashboardJobResult) => Promise<void>;
  getPremium: () => Promise<number | undefined>;
};

const BASELINE_MAX_ATTEMPTS = 3;
const BASELINE_RETRY_DELAY_MS = 5_000;

export function createCurrencyDashboardJob(deps: JobDependencies) {
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
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
      let current = baselines[date] ?? {};
      const windowStart = Date.parse(`${date}T08:30:00+03:00`);
      const windowEnd = windowStart + 60_000;
      const inCaptureWindow = (value: Date) => value.getTime() >= windowStart && value.getTime() < windowEnd;
      const complete = () => Boolean(current.COPPER && current.BR);
      const readSource = async (kind: CurrencySourceKind, force = false): Promise<CurrencySourceResult | null> => {
        // Retries replace this source's status, but cannot conceal another source's failure.
        const record = (status: CurrencyDashboardJobResult['sources'][number]) => {
          const index = result.sources.findIndex((source) => source.kind === kind);
          if (index < 0) result.sources.push(status);
          else result.sources[index] = status;
        };
        try {
          const data = await deps.getSource(kind, {}, { force });
          record({ kind, ...data._currencySource });
          return data;
        } catch {
          record({ kind, stale: true, error: 'Источник недоступен' });
          return null;
        }
      };
      // Do not make baseline capture wait for the first historical CBR import.
      const background = Promise.all((['cbr-daily', 'cbr-history', 'cbr-base-history', 'copper', 'moex-currency', 'world'] as const).map((kind) => readSource(kind)));
      try {
        if (complete()) {
          result.baseline.status = 'already-captured';
          await readSource('moex-futures');
        } else if (inCaptureWindow(now)) {
          for (let attempt = 0; attempt < BASELINE_MAX_ATTEMPTS; attempt++) {
            // Acquiring the lock, reading the baseline or a previous attempt may have taken time.
            if (!inCaptureWindow(deps.now())) break;
            const futures = await readSource('moex-futures', true);
            const capturedAt = deps.now();
            if (!inCaptureWindow(capturedAt)) break;
            const fetchedAt = futures ? Date.parse(futures._currencySource.fetchedAt) : NaN;
            // Old cache, future timestamps and responses completed after 08:30 cannot be
            // relabelled as this minute's observation. Delayed real trades remain explicit.
            if (futures && !futures._currencySource.stale && Number.isFinite(fetchedAt) &&
                fetchedAt >= windowStart && fetchedAt <= capturedAt.getTime()) {
              let chosen: ReturnType<typeof selectCurrencyFutures> = {};
              try { chosen = selectCurrencyFutures(futures, date, current); } catch { /* Retry an unusable response inside the window. */ }
              const added: CurrencyBaselineDay = {};
              for (const asset of ['COPPER', 'BR'] as const) {
                const quote = chosen[asset];
                if (current[asset] || !quote) continue;
                // A future LAST must not become an immutable 08:30 price, even with a stale label.
                if (quote.last !== null && quote.quoteAt && Date.parse(quote.quoteAt) > capturedAt.getTime()) continue;
                const baseline = currencyBaselineFromQuote(quote, capturedAt);
                if (baseline) added[asset] = baseline;
              }
              if (Object.keys(added).length) {
                if (added.COPPER) {
                  const premium = await deps.getPremium();
                  if (premium !== undefined) added.COPPER.premium = premium;
                }
                // Persist each valid asset immediately; retries only fill what is still missing.
                current = await deps.saveBaseline(date, added);
                result.baseline.capturedAssets.push(...Object.keys(added) as Asset[]);
                if (complete()) break;
              }
            }
            if (attempt + 1 >= BASELINE_MAX_ATTEMPTS) break;
            const retryAt = deps.now();
            if (!inCaptureWindow(retryAt) || retryAt.getTime() + BASELINE_RETRY_DELAY_MS >= windowEnd) break;
            await sleep(BASELINE_RETRY_DELAY_MS);
          }
          result.baseline.status = complete() ? 'captured' : deps.now().getTime() >= windowEnd ? 'missed' : 'unavailable';
        } else {
          await readSource('moex-futures');
          // A restarted server cannot truthfully reconstruct an 08:30 quote from a later LAST.
          if (deps.now().getTime() >= windowEnd) result.baseline.status = 'missed';
        }
      } finally {
        // Keep the cross-worker lock until background requests finish, including save failures.
        await background;
      }
      result.ok = !result.sources.some((source) => source.stale) && result.baseline.status !== 'unavailable' && result.baseline.status !== 'missed';
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
