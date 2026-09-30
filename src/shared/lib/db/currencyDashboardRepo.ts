import {
  validateCurrencyActor, validateCurrencyBaselineDay, validateCurrencyCacheKey,
  validateCurrencyDate, validateCurrencyJson, validateCurrencyRevision, validateCurrencySnapshot, validateCurrencyTimestamp,
  type CurrencyBaseline, type CurrencyBaselineDay, type CurrencyBaselines, type CurrencySnapshotState, type StoredCurrencySnapshot,
} from '../currencyDashboardModel';
import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';

export class CurrencySnapshotConflictError extends Error {
  readonly code = 'CURRENCY_CONFLICT';
  constructor(readonly currentRevision: number) { super('Данные уже изменены другим пользователем. Обновите снимок и повторите сохранение.'); this.name = 'CurrencySnapshotConflictError'; }
}
export class CurrencySnapshotPreviousMissingError extends Error {
  readonly code = 'CURRENCY_NO_PREVIOUS';
  constructor() { super('Предыдущего снимка для отката ещё нет.'); this.name = 'CurrencySnapshotPreviousMissingError'; }
}

type StateRow = { revision: string; current_snapshot: StoredCurrencySnapshot | null; previous_snapshot: StoredCurrencySnapshot | null };
function stateFromRow(row: StateRow | undefined): CurrencySnapshotState {
  if (!row) throw new Error('Currency dashboard state is missing');
  return { revision: validateCurrencyRevision(Number(row.revision)), current: row.current_snapshot, previous: row.previous_snapshot };
}

export async function readCurrencySnapshot(): Promise<CurrencySnapshotState> {
  await ensureSiteSchema();
  return stateFromRow((await query<StateRow>('select revision::text, current_snapshot, previous_snapshot from currency_dashboard_state where id=1')).rows[0]);
}

async function changeSnapshot(expectedRevision: number, actor: string, change: (state: CurrencySnapshotState, now: string) => StoredCurrencySnapshot): Promise<CurrencySnapshotState> {
  validateCurrencyRevision(expectedRevision);
  validateCurrencyActor(actor);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    // A persisted singleton row lock serializes both PM2 processes and every writer/rollback.
    const state = stateFromRow((await client.query<StateRow>('select revision::text, current_snapshot, previous_snapshot from currency_dashboard_state where id=1 for update')).rows[0]);
    if (state.revision !== expectedRevision) throw new CurrencySnapshotConflictError(state.revision);
    const now = (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0].now.toISOString();
    const next = change(state, now);
    const saved = await client.query<StateRow>(`update currency_dashboard_state set
      revision=revision+1, previous_snapshot=current_snapshot, current_snapshot=$1::jsonb, updated_at=$2::timestamptz
      where id=1 returning revision::text,current_snapshot,previous_snapshot`, [JSON.stringify(next), now]);
    return stateFromRow(saved.rows[0]);
  });
}

export async function writeCurrencySnapshot(snapshot: unknown, expectedRevision: number, actor: string): Promise<CurrencySnapshotState> {
  const validated = validateCurrencySnapshot(snapshot);
  return changeSnapshot(expectedRevision, actor, (_state, now) => ({ ...validated, at: now, savedAt: now, actor }));
}

export async function rollbackCurrencySnapshot(expectedRevision: number, actor: string): Promise<CurrencySnapshotState> {
  return changeSnapshot(expectedRevision, actor, (state, now) => {
    if (!state.previous) throw new CurrencySnapshotPreviousMissingError();
    // Rollback is a new revision; an old browser can never overwrite it with a stale revision.
    return { ...state.previous, at: now, savedAt: now, actor };
  });
}

export async function readCurrencyCache(key: string): Promise<{ value: unknown; fetchedAt: string } | null> {
  validateCurrencyCacheKey(key);
  await ensureSiteSchema();
  const row = (await query<{ value: unknown; fetched_at: Date }>('select value,fetched_at from currency_dashboard_cache where key=$1', [key])).rows[0];
  return row ? { value: row.value, fetchedAt: row.fetched_at.toISOString() } : null;
}

/** Internal server-source cache, never accepts a browser snapshot or arbitrary fetch URL. */
export async function writeCurrencyCache(key: string, value: unknown, fetchedAt: string): Promise<void> {
  validateCurrencyCacheKey(key);
  validateCurrencyJson(value);
  const timestamp = validateCurrencyTimestamp(fetchedAt);
  await ensureSiteSchema();
  // A slow earlier source request must not replace a fresher successful result.
  await query(`insert into currency_dashboard_cache(key,value,fetched_at) values($1,$2::jsonb,$3::timestamptz)
    on conflict(key) do update set value=excluded.value,fetched_at=excluded.fetched_at,updated_at=now()
    where excluded.fetched_at > currency_dashboard_cache.fetched_at`, [key, JSON.stringify(value), timestamp]);
}

async function readBaselines(runQuery: typeof query, date?: string): Promise<CurrencyBaselines> {
  const rows = (await runQuery<{ date: string; asset: 'COPPER' | 'BR'; value: CurrencyBaseline }>(
    `select date::text,asset,value from currency_dashboard_baselines ${date ? 'where date=$1::date' : ''} order by date,asset`, date ? [date] : [],
  )).rows;
  const result: CurrencyBaselines = {};
  for (const row of rows) (result[row.date] ??= {})[row.asset] = row.value;
  return result;
}

export async function getCurrencyBaselines(): Promise<CurrencyBaselines> {
  await ensureSiteSchema();
  return readBaselines(query);
}

/** Each instrument is immutable, but a later successful source may add a missing instrument. */
export async function saveCurrencyBaseline(date: string, value: CurrencyBaselineDay): Promise<CurrencyBaselineDay> {
  validateCurrencyDate(date, 'Дата базы', 2026);
  const validated = validateCurrencyBaselineDay(value);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    for (const asset of ['COPPER', 'BR'] as const) {
      if (validated[asset]) await client.query(`insert into currency_dashboard_baselines(date,asset,value)
        values($1::date,$2,$3::jsonb) on conflict(date,asset) do nothing`, [date, asset, JSON.stringify(validated[asset])]);
    }
    return (await readBaselines((sql, params) => client.query(sql, params), date))[date] ?? {};
  });
}
