import type { AdminSession } from '@/shared/lib/adminAuth';
import { analyticsCacheState, analyticsQuery } from './performance';
import { AnalyticsUnavailableError } from './availability';

type Entry = { value: unknown; bytes: number; expiresAt: number };
export const ANALYTICS_CACHE_TTL_MS = 10_000;
const MAX_ENTRIES = 48;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PENDING = 16;
const EPOCH_KEY = 'wholesale_analytics_cache_epoch';

/** Process-local derived statistics only. Authorization must run before this helper. */
export function createAnalyticsReadCache(options: {
  ttlMs?: number; maxEntries?: number; maxBytes?: number; maxPending?: number; now?: () => number;
} = {}) {
  const entries = new Map<string, Entry>();
  const pending = new Map<string, Promise<unknown>>();
  const now = options.now ?? Date.now;
  let bytes = 0;
  const remove = (key: string) => { const entry = entries.get(key); if (entry) { bytes -= entry.bytes; entries.delete(key); } };
  return {
    async read<T>(key: string, load: () => Promise<T>): Promise<T> {
      const entry = entries.get(key);
      if (entry && entry.expiresAt > now()) {
        entries.delete(key); entries.set(key, entry); analyticsCacheState('hit');
        return structuredClone(entry.value) as T;
      }
      if (entry) remove(key);
      const existing = pending.get(key);
      if (existing) { analyticsCacheState('coalesced'); return structuredClone(await existing) as T; }
      if (pending.size >= (options.maxPending ?? MAX_PENDING)) throw new AnalyticsUnavailableError();
      analyticsCacheState('miss');
      const work = Promise.resolve().then(load).then((value) => {
        if (value === null || value === undefined) return value;
        const size = Buffer.byteLength(JSON.stringify(value));
        if (size > (options.maxBytes ?? MAX_BYTES)) return value;
        for (const [oldKey, oldEntry] of entries) if (oldEntry.expiresAt <= now()) remove(oldKey);
        while (entries.size >= (options.maxEntries ?? MAX_ENTRIES) || bytes + size > (options.maxBytes ?? MAX_BYTES)) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          remove(oldest);
        }
        entries.set(key, { value: structuredClone(value), bytes: size, expiresAt: now() + (options.ttlMs ?? ANALYTICS_CACHE_TTL_MS) });
        bytes += size;
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, work);
      return structuredClone(await work);
    },
  };
}

const cache = createAnalyticsReadCache();

async function readEpoch() {
  const result = await analyticsQuery<{ value: string }>('cache_epoch', 'select value from site_settings where key = $1', [EPOCH_KEY]);
  return result.rows[0]?.value ?? 'initial';
}

export async function readCachedAnalytics<T>(input: {
  session?: AdminSession; kind: 'admin' | 'manager' | 'extended'; period: string; managerId?: number; targetRevision?: string;
}, load: () => Promise<T>): Promise<T> {
  const session = input.session;
  // Only authorized admin analytics endpoints opt in. No implicit shared identity
  // for legacy/internal callers, and no caching of a manager's client permissions.
  if (!session) return load();
  if (session.role !== 'admin' && session.role !== 'wholesale_admin') throw new Error('Недостаточно прав для аналитики');
  if (!Number.isSafeInteger(session.adminUserId) || Number(session.adminUserId) <= 0) return load();
  for (let attempt = 0; attempt < 3; attempt++) {
    const epoch = await readEpoch();
    const key = JSON.stringify([session.role, session.adminUserId, input.kind, input.period, input.managerId ?? null, input.targetRevision ?? null, epoch]);
    const result = await cache.read(key, load);
    // A clear in either PM2 process atomically changes the shared epoch. Old
    // pending computations stay under the old key and cannot resurrect history.
    if (await readEpoch() === epoch) return result;
  }
  throw new AnalyticsUnavailableError('Журнал изменился во время расчёта. Обновите аналитику.');
}
