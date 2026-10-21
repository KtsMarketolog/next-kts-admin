import { parseDashboardUsageBatch, type DashboardUsageBatch, type DashboardUsageEvent } from './dashboardUsage';

export const DASHBOARD_USAGE_OUTBOX_LIMIT = 20_000;
export const DASHBOARD_USAGE_OUTBOX_MAX_BYTES = 16 * 1024 * 1024;
export const DASHBOARD_USAGE_OUTBOX_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DASHBOARD_USAGE_OUTBOX_DATABASE = 'kts-dashboard-usage-outbox-v1';
const STORAGE_TIMEOUT_MS = 5000;
type Context = Omit<DashboardUsageBatch, 'events'>;
export type DashboardUsageOutboxEntry = {
  context: Context; event: DashboardUsageEvent; queuedAt: number;
  quarantine?: 'access' | 'rejected';
};
export type DashboardUsageOutbox = {
  load(now: number): Promise<{ entries: DashboardUsageOutboxEntry[]; expired: number; skipped: number }>;
  put(entry: DashboardUsageOutboxEntry): Promise<'stored' | 'full'>;
  acknowledge(ids: string[]): Promise<void>;
  quarantine(ids: string[], reason: 'access' | 'rejected'): Promise<void>;
  recordLoss(reason: 'overflow' | 'expired', count: number, now: number): Promise<void>;
};
type StoredEntry = DashboardUsageOutboxEntry & { key: string; scope: string; bytes: number };
type Quota = { key: 'quota'; count: number; bytes: number };
type Loss = { key: string; skipped: number; expired: number; updatedAt: number };
const emptyQuota = (): Quota => ({ key: 'quota', count: 0, bytes: 0 });
const lossValue = (scope: string, value: Loss | undefined, reason: 'overflow' | 'expired', count: number, now: number): Loss => ({
  key: `loss:${scope}`, skipped: Math.min(1_000_000_000, (value?.skipped ?? 0) + (reason === 'overflow' ? count : 0)),
  expired: Math.min(1_000_000_000, (value?.expired ?? 0) + (reason === 'expired' ? count : 0)), updatedAt: count ? now : value?.updatedAt ?? now,
});

export function dashboardUsageEntryBytes(entry: DashboardUsageOutboxEntry) {
  // Account for IndexedDB keys/metadata too; do not count just the HTTP payload.
  return new TextEncoder().encode(JSON.stringify({ context: entry.context, event: entry.event, queuedAt: entry.queuedAt })).byteLength + 256;
}

function safeOutboxEntry(entry: DashboardUsageOutboxEntry): DashboardUsageOutboxEntry {
  const safe = parseDashboardUsageBatch({ ...entry.context, events: [entry.event] }, { allowCapturedAt: true });
  if (!Number.isFinite(entry.queuedAt) || (entry.quarantine !== undefined && !['access', 'rejected'].includes(entry.quarantine))) throw new Error('Invalid outbox entry');
  return { context: { dashboardKey: safe.dashboardKey, preview: safe.preview, versionId: safe.versionId }, event: safe.events[0], queuedAt: entry.queuedAt,
    ...(entry.quarantine ? { quarantine: entry.quarantine } : {}) };
}

/** Only the trusted shell creates this outbox. No cookie, session credential or raw session ID is stored. */
export function createDashboardUsageOutbox(sessionId: string): DashboardUsageOutbox {
  let connection: Promise<{ db: IDBDatabase; scope: string }> | null = null;
  const connect = () => {
    if (!connection) connection = (async () => {
      if (typeof indexedDB === 'undefined' || !globalThis.crypto?.subtle) throw new Error('Outbox storage unavailable');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`dashboard-usage:${sessionId}`));
      const scope = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        let finished = false;
        const request = indexedDB.open(DASHBOARD_USAGE_OUTBOX_DATABASE, 1);
        const timer = setTimeout(() => { finished = true; reject(new Error('Outbox open timeout')); }, STORAGE_TIMEOUT_MS);
        request.onupgradeneeded = () => {
          const database = request.result;
          database.createObjectStore('events', { keyPath: 'key' });
          database.createObjectStore('metadata', { keyPath: 'key' });
        };
        request.onerror = () => { clearTimeout(timer); finished = true; reject(request.error); };
        request.onsuccess = () => {
          clearTimeout(timer);
          if (finished) { request.result.close(); return; }
          finished = true;
          request.result.onversionchange = () => { request.result.close(); connection = null; };
          resolve(request.result);
        };
      });
      return { db, scope };
    })().catch((error: unknown) => { connection = null; throw error; });
    return connection;
  };
  const transaction = async <T>(work: (events: IDBObjectStore, metadata: IDBObjectStore, scope: string, result: (value: T) => void) => void): Promise<T> => {
    const { db, scope } = await connect();
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      try { tx = db.transaction(['events', 'metadata'], 'readwrite', { durability: 'strict' }); }
      catch (error) {
        // Older engines may not accept the durability hint. Transaction completion is still required.
        if (!(error instanceof TypeError)) throw error;
        tx = db.transaction(['events', 'metadata'], 'readwrite');
      }
      let value: T;
      const timer = setTimeout(() => { try { tx.abort(); } catch { /* Already completed. */ } reject(new Error('Outbox transaction timeout')); }, STORAGE_TIMEOUT_MS);
      tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
      tx.onabort = () => { clearTimeout(timer); reject(tx.error ?? new Error('Outbox transaction aborted')); };
      tx.onerror = () => { /* Abort rejects the transaction, never acknowledge an individual request. */ };
      try { work(tx.objectStore('events'), tx.objectStore('metadata'), scope, (result) => { value = result; }); }
      catch (error) { tx.abort(); clearTimeout(timer); reject(error); }
    });
  };
  return {
    load: (now) => transaction((events, metadata, scope, result) => {
      const entries: DashboardUsageOutboxEntry[] = [];
      const quota = emptyQuota();
      const expiredByScope = new Map<string, number>();
      const metadataCursor = metadata.openCursor();
      metadataCursor.onsuccess = () => {
        const item = metadataCursor.result;
        if (!item) return;
        if (String(item.key).startsWith('loss:') && (item.value as Loss).updatedAt < now - DASHBOARD_USAGE_OUTBOX_MAX_AGE_MS) item.delete();
        item.continue();
      };
      const cursor = events.openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) {
          metadata.put(quota);
          if (!expiredByScope.has(scope)) expiredByScope.set(scope, 0);
          for (const [expiredScope, expired] of expiredByScope) {
            const request = metadata.get(`loss:${expiredScope}`);
            request.onsuccess = () => {
              const loss = lossValue(expiredScope, request.result as Loss | undefined, 'expired', expired, now);
              if (loss.skipped || loss.expired) metadata.put(loss);
              if (expiredScope === scope) result({ entries: entries.sort((a, b) => a.queuedAt - b.queuedAt), expired: loss.expired, skipped: loss.skipped });
            };
          }
          return;
        }
        const row = item.value as StoredEntry;
        let safe: DashboardUsageBatch | null = null;
        try {
          safe = parseDashboardUsageBatch({ ...row.context, events: [row.event] }, { allowCapturedAt: true });
          if (!Number.isFinite(row.queuedAt) || typeof row.scope !== 'string' || row.key !== `${row.scope}:${safe.events[0].id}`
            || (row.quarantine !== undefined && !['access', 'rejected'].includes(row.quarantine))) safe = null;
        } catch { /* Invalid browser storage is never forwarded to the API. */ }
        if (!safe || row.queuedAt < now - DASHBOARD_USAGE_OUTBOX_MAX_AGE_MS) {
          if (typeof row.scope === 'string' && /^[a-f0-9]{64}$/.test(row.scope)) expiredByScope.set(row.scope, (expiredByScope.get(row.scope) ?? 0) + 1);
          item.delete();
        } else {
          const entry: DashboardUsageOutboxEntry = { context: { dashboardKey: safe.dashboardKey, preview: safe.preview, versionId: safe.versionId }, event: safe.events[0], queuedAt: row.queuedAt,
            ...(row.quarantine ? { quarantine: row.quarantine } : {}) };
          const bytes = dashboardUsageEntryBytes(entry);
          quota.count++; quota.bytes += bytes;
          if (row.bytes !== bytes) item.update({ ...row, bytes });
          if (row.scope === scope) entries.push(entry);
        }
        cursor.result.continue();
      };
    }),
    put: (input) => transaction((events, metadata, scope, result) => {
      const entry = safeOutboxEntry(input);
      const key = `${scope}:${entry.event.id}`;
      const existing = events.get(key);
      existing.onsuccess = () => {
        // Never overwrite another tab's immutable event/quarantine state with stale memory.
        if (existing.result) { result('stored'); return; }
        const readQuota = metadata.get('quota');
        readQuota.onsuccess = () => {
          const quota = (readQuota.result as Quota | undefined) ?? emptyQuota();
          const bytes = dashboardUsageEntryBytes(entry);
          if (quota.count >= DASHBOARD_USAGE_OUTBOX_LIMIT || quota.bytes + bytes > DASHBOARD_USAGE_OUTBOX_MAX_BYTES) { result('full'); return; }
          events.add({ ...entry, key, scope, bytes } satisfies StoredEntry);
          metadata.put({ ...quota, count: quota.count + 1, bytes: quota.bytes + bytes });
          result('stored');
        };
      };
    }),
    acknowledge: (ids) => transaction((events, metadata, scope, result) => {
      const readQuota = metadata.get('quota');
      readQuota.onsuccess = () => {
        const quota = (readQuota.result as Quota | undefined) ?? emptyQuota();
        let remaining = ids.length;
        if (!remaining) { result(undefined); return; }
        for (const id of ids) {
          const key = `${scope}:${id}`;
          const request = events.get(key);
          request.onsuccess = () => {
            const entry = request.result as StoredEntry | undefined;
            if (entry) { events.delete(key); quota.count--; quota.bytes -= entry.bytes; }
            if (--remaining === 0) { metadata.put({ ...quota, count: Math.max(0, quota.count), bytes: Math.max(0, quota.bytes) }); result(undefined); }
          };
        }
      };
    }),
    quarantine: (ids, reason) => transaction((events, metadata, scope, result) => {
      const readQuota = metadata.get('quota');
      readQuota.onsuccess = () => {
        const quota = (readQuota.result as Quota | undefined) ?? emptyQuota();
        let remaining = ids.length;
        if (!remaining) { result(undefined); return; }
        for (const id of ids) {
          const request = events.get(`${scope}:${id}`);
          request.onsuccess = () => {
            const entry = request.result as StoredEntry | undefined;
            if (entry) {
              const changed = { ...entry, quarantine: reason };
              changed.bytes = dashboardUsageEntryBytes({ context: changed.context, event: changed.event, queuedAt: changed.queuedAt, quarantine: reason });
              quota.bytes += changed.bytes - entry.bytes;
              events.put(changed);
            }
            if (--remaining === 0) { metadata.put(quota); result(undefined); }
          };
        }
      };
    }),
    recordLoss: (reason, count, now) => transaction((_events, metadata, scope, result) => {
      if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(now)) throw new Error('Invalid loss counter');
      const request = metadata.get(`loss:${scope}`);
      request.onsuccess = () => { metadata.put(lossValue(scope, request.result as Loss | undefined, reason, count, now)); result(undefined); };
    }),
  };
}
