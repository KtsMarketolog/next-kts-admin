import { DASHBOARD_USAGE_MAX_BATCH, DASHBOARD_USAGE_MAX_BODY, parseDashboardUsageBatch, type DashboardUsageBatch, type DashboardUsageEvent } from './dashboardUsage';
import { DashboardUsageViewing } from './dashboardUsageViewing';
import { createDashboardUsageOutbox, dashboardUsageEntryBytes, DASHBOARD_USAGE_OUTBOX_LIMIT, DASHBOARD_USAGE_OUTBOX_MAX_BYTES, DASHBOARD_USAGE_OUTBOX_MAX_AGE_MS, type DashboardUsageOutbox, type DashboardUsageOutboxEntry } from './dashboardUsageOutbox';

/** Correlation only, never a credential. The server still authenticates its HttpOnly cookie. */
export const DASHBOARD_USAGE_SESSION_HEADER = 'X-Dashboard-Usage-Session';
export const DASHBOARD_USAGE_QUEUE_LIMIT = DASHBOARD_USAGE_OUTBOX_LIMIT;
export const DASHBOARD_USAGE_REQUEST_TIMEOUT_MS = 10_000;
const FLUSH_DELAY_MS = 5000;
const MAX_RETRY_MS = 60_000;
const MAX_RETRY_AFTER_MS = 300_000;
type Context = Omit<DashboardUsageBatch, 'events'>;
type Entry = DashboardUsageOutboxEntry;
type Timer = ReturnType<typeof setTimeout>;
export type DashboardUsageDeliveryState = {
  pending: number;
  skipped: number;
  quarantined: number;
  expired: number;
  unsaved: number;
  storage: 'initializing' | 'ready' | 'unavailable' | 'full';
  status: 'idle' | 'pending' | 'sending' | 'retrying' | 'offline' | 'authentication' | 'access' | 'session' | 'rejected';
  retryAt: number | null;
};
type Dependencies = {
  fetch: typeof fetch;
  now: () => number;
  random: () => number;
  online: () => boolean;
  schedule: (callback: () => void, delay: number) => Timer;
  cancel: (timer: Timer) => void;
  outbox: DashboardUsageOutbox | null;
};

export function dashboardUsageRetryDelay(attempt: number, retryAfter: string | null, now: number, random: number) {
  const backoff = Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.min(attempt, 6));
  const jittered = Math.min(MAX_RETRY_MS, Math.round(backoff * (0.75 + Math.max(0, Math.min(1, random)) * 0.5)));
  let requested = 0;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    requested = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(retryAfter) - now;
  }
  return Math.max(jittered, Number.isFinite(requested) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, requested)) : 0);
}

/** Durable, bounded, per-session outbox. Its identity must never be rebound after login changes. */
export class DashboardUsageDelivery {
  readonly viewing: DashboardUsageViewing;
  private entries = new Map<string, Entry>();
  private persisted = new Set<string>();
  private persistenceAttempted = new Set<string>();
  private blockedContexts = new Map<string, number>();
  private bytes = 0;
  private quarantineCount = 0;
  private acknowledged = new Set<string>();
  private listeners = new Set<() => void>();
  private timer: Timer | null = null;
  private attempt = 0;
  private inFlight: Promise<void> | null = null;
  private disposed = false;
  private stopped = false;
  private hydrated = false;
  private hydration: Promise<void> | null = null;
  private persistence: Promise<void> = Promise.resolve();
  private storageRetryAt = 0;
  private pendingLoss = { overflow: 0, expired: 0 };
  private state: DashboardUsageDeliveryState = { pending: 0, skipped: 0, quarantined: 0, expired: 0, unsaved: 0, storage: 'initializing', status: 'idle', retryAt: null };
  private deps: Dependencies;

  constructor(readonly sessionId: string | null, dependencies: Partial<Dependencies> = {}) {
    this.deps = {
      fetch: (...args) => globalThis.fetch(...args), now: Date.now, random: Math.random,
      online: () => typeof navigator === 'undefined' || navigator.onLine,
      schedule: (callback, delay) => setTimeout(callback, delay), cancel: (timer) => clearTimeout(timer),
      outbox: sessionId ? createDashboardUsageOutbox(sessionId) : null,
      ...dependencies,
    };
    this.viewing = new DashboardUsageViewing((context, event) => { this.enqueue(context, event); });
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(value: Partial<DashboardUsageDeliveryState>) {
    this.state = { ...this.state, ...value, pending: this.entries.size - this.quarantineCount,
      quarantined: this.quarantineCount, unsaved: this.entries.size - this.persisted.size };
    this.listeners.forEach((listener) => listener());
  }

  private initialize() {
    if (this.hydrated) return Promise.resolve();
    if (this.hydration) return this.hydration;
    if (this.deps.now() < this.storageRetryAt) return Promise.resolve();
    if (!this.deps.outbox) { this.update({ storage: 'unavailable' }); return Promise.resolve(); }
    this.hydration = this.deps.outbox.load(this.deps.now()).then(({ entries, expired, skipped: restoredSkipped }) => {
      const capturedDuringLoad = this.entries;
      this.entries = new Map(); this.persisted.clear(); this.persistenceAttempted.clear();
      this.bytes = 0; this.quarantineCount = 0;
      for (const entry of entries) {
        if (this.acknowledged.has(entry.event.id)) continue;
        this.entries.set(entry.event.id, entry); this.bytes += dashboardUsageEntryBytes(entry); if (entry.quarantine) this.quarantineCount++;
        this.persisted.add(entry.event.id);
        this.persistenceAttempted.add(entry.event.id);
      }
      let skipped = 0;
      for (const [id, entry] of capturedDuringLoad) {
        if (this.entries.has(id) || this.acknowledged.has(id)) continue;
        const bytes = dashboardUsageEntryBytes(entry);
        // Opening a full durable queue cannot silently evict older captures to make room for new ones.
        if (this.entries.size >= DASHBOARD_USAGE_QUEUE_LIMIT || this.bytes + bytes > DASHBOARD_USAGE_OUTBOX_MAX_BYTES) { skipped++; continue; }
        if (this.contextBlocked(entry.context)) entry.quarantine = 'access';
        this.entries.set(id, entry); this.bytes += bytes; if (entry.quarantine) this.quarantineCount++;
      }
      this.pendingLoss.overflow += skipped;
      this.hydrated = true;
      this.update({ storage: 'ready', skipped: this.state.skipped + skipped + restoredSkipped, expired: this.state.expired + expired, status: this.stopped ? this.state.status : this.entries.size > this.quarantineCount ? 'pending' : 'idle' });
    }).catch(() => { this.storageFailed(); }).finally(() => { this.hydration = null; });
    return this.hydration;
  }

  private storageFailed() {
    this.storageRetryAt = this.deps.now() + 30_000;
    this.update({ storage: 'unavailable' });
    // A reload may have a durable queue but no RAM entries yet. Retry hydration without a new user action.
    if (!this.hydrated && !this.timer) this.schedule(30_000);
  }

  private contextBlocked(context: Context) {
    const key = JSON.stringify(context);
    const retryAt = this.blockedContexts.get(key);
    if (!retryAt) return false;
    if (this.deps.now() < retryAt) return true;
    this.blockedContexts.delete(key); return false;
  }

  private persist(id: string) {
    this.persistence = this.persistence.then(async () => {
      await this.initialize();
      const entry = this.entries.get(id);
      if (!entry || this.persisted.has(id)) return;
      try {
        if (!this.deps.outbox || this.deps.now() < this.storageRetryAt) return;
        const result = await this.deps.outbox.put(entry);
        if (result === 'stored') { this.persisted.add(id); this.update({ storage: 'ready' }); }
        else this.update({ storage: 'full' });
      } catch { this.storageFailed(); }
      finally { this.persistenceAttempted.add(id); }
    });
  }

  private persistLoss() {
    this.persistence = this.persistence.then(async () => {
      await this.initialize();
      if (!this.deps.outbox || this.deps.now() < this.storageRetryAt) return;
      for (const reason of ['overflow', 'expired'] as const) {
        const count = this.pendingLoss[reason];
        if (!count) continue;
        try { await this.deps.outbox.recordLoss(reason, count, this.deps.now()); this.pendingLoss[reason] -= count; }
        catch { this.storageFailed(); break; }
      }
    });
  }

  /** Also useful before an explicit navigation: only unsaved events can disappear on a reload. */
  persistPending = async () => {
    await this.initialize();
    for (const id of this.entries.keys()) if (!this.persisted.has(id)) this.persist(id);
    this.persistLoss();
    await this.persistence;
  };
  private schedule(delay: number) {
    if (this.disposed || this.stopped) return;
    if (this.timer) this.deps.cancel(this.timer);
    this.timer = this.deps.schedule(() => { this.timer = null; void this.flush(); }, Math.max(0, delay));
  }

  enqueue(context: Context, event: DashboardUsageEvent) {
    if (this.disposed || this.stopped) return false;
    // Reuse the API's allowlist: never retain business values or other unexpected fields.
    const safe = parseDashboardUsageBatch({ ...context, events: [{ ...event, capturedAt: event.capturedAt ?? new Date(this.deps.now()).toISOString() }] }, { allowCapturedAt: true });
    if (this.acknowledged.has(event.id) || this.entries.has(event.id)) return true;
    const canonicalContext = { dashboardKey: safe.dashboardKey, preview: safe.preview, versionId: safe.versionId };
    // The parent emits this once for a newly opened report, not for arbitrary repeated frame messages.
    // It may now be accessible even though the previous opening received 403.
    if (safe.events[0].action === 'report_open') this.blockedContexts.delete(JSON.stringify(canonicalContext));
    const entry: Entry = { context: canonicalContext, event: safe.events[0], queuedAt: this.deps.now(),
      ...(this.contextBlocked(canonicalContext) ? { quarantine: 'access' as const } : {}) };
    const bytes = dashboardUsageEntryBytes(entry);
    if (this.entries.size >= DASHBOARD_USAGE_QUEUE_LIMIT || this.bytes + bytes > DASHBOARD_USAGE_OUTBOX_MAX_BYTES) {
      this.pendingLoss.overflow++;
      this.update({ skipped: this.state.skipped + 1 });
      this.persistLoss();
      return false;
    }
    this.entries.set(event.id, entry); this.bytes += bytes;
    if (entry.quarantine) this.quarantineCount++;
    if (!this.sessionId) { this.stopped = true; this.update({ status: 'authentication' }); return false; }
    this.update({ status: this.state.status === 'idle' ? 'pending' : this.state.status });
    this.persist(event.id);
    if (!this.timer && !this.inFlight) this.schedule(FLUSH_DELAY_MS);
    return true;
  }

  flush = (): Promise<void> => {
    if (this.inFlight) return this.inFlight;
    if (this.disposed || this.stopped) return Promise.resolve();
    this.inFlight = this.prepareAndSend().finally(() => {
      this.inFlight = null;
      if (!this.hydrated && this.deps.outbox && !this.timer) this.schedule(Math.max(1000, this.storageRetryAt - this.deps.now()));
    });
    return this.inFlight;
  };

  private async prepareAndSend() {
    if (this.timer) { this.deps.cancel(this.timer); this.timer = null; }
    await this.persistPending();
    const expired = [...this.entries.values()].filter((entry) => entry.queuedAt < this.deps.now() - DASHBOARD_USAGE_OUTBOX_MAX_AGE_MS).map((entry) => entry.event.id);
    if (expired.length) {
      try { if (this.deps.now() >= this.storageRetryAt) await this.deps.outbox?.acknowledge(expired); } catch { this.storageFailed(); }
      this.remove(expired); this.update({ expired: this.state.expired + expired.length });
      this.pendingLoss.expired += expired.length; this.persistLoss();
    }
    if (this.stopped || this.entries.size === this.quarantineCount) return;
    if (this.state.retryAt && this.deps.now() < this.state.retryAt) {
      this.schedule(this.state.retryAt - this.deps.now());
      return;
    }
    if (!this.deps.online()) {
      this.update({ status: 'offline', retryAt: null });
      this.schedule(15_000);
      return;
    }
    await this.send();
  }

  private remove(ids: string[]) {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) continue;
      this.bytes -= dashboardUsageEntryBytes(entry);
      if (entry.quarantine) this.quarantineCount--;
      this.entries.delete(id); this.persisted.delete(id); this.persistenceAttempted.delete(id);
    }
  }

  private async quarantine(ids: string[], reason: 'access' | 'rejected') {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry || entry.quarantine) continue;
      this.bytes -= dashboardUsageEntryBytes(entry);
      entry.quarantine = reason;
      this.bytes += dashboardUsageEntryBytes(entry); this.quarantineCount++;
    }
    await this.persistence;
    try { if (this.deps.now() >= this.storageRetryAt) await this.deps.outbox?.quarantine(ids, reason); } catch { this.storageFailed(); }
    this.attempt = 0;
    this.update({ status: this.entries.size > this.quarantineCount ? 'pending' : 'idle', retryAt: null });
    if (this.entries.size > this.quarantineCount) this.schedule(0);
  }

  private async send() {
    const first = [...this.entries.values()].find((entry) => !entry.quarantine && this.persistenceAttempted.has(entry.event.id));
    if (!first) { this.schedule(FLUSH_DELAY_MS); return; }
    const context = first.context;
    const events: DashboardUsageEvent[] = [];
    for (const entry of this.entries.values()) {
      if (entry.quarantine || !this.persistenceAttempted.has(entry.event.id)) continue;
      if (entry.context.dashboardKey !== context.dashboardKey || entry.context.preview !== context.preview || entry.context.versionId !== context.versionId) continue;
      const next = [...events, entry.event];
      if (next.length > DASHBOARD_USAGE_MAX_BATCH || new TextEncoder().encode(JSON.stringify({ ...context, events: next })).byteLength > DASHBOARD_USAGE_MAX_BODY) break;
      events.push(entry.event);
    }
    const body = JSON.stringify({ ...context, events });
    const controller = new AbortController();
    let timeout: Timer | null = null;
    this.update({ status: 'sending', retryAt: null });
    try {
      const request = this.deps.fetch('/api/admin/dashboard-usage', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', keepalive: true,
        headers: { 'Content-Type': 'application/json', [DASHBOARD_USAGE_SESSION_HEADER]: this.sessionId! },
        signal: controller.signal, body,
      }).then(async (response) => ({ response, result: response.ok ? await response.json() as unknown : null }));
      const { response, result } = await Promise.race([request, new Promise<never>((_, reject) => {
        timeout = this.deps.schedule(() => { controller.abort(); reject(new Error('Usage delivery timeout')); }, DASHBOARD_USAGE_REQUEST_TIMEOUT_MS);
      })]);
      if ([401, 409].includes(response.status)) {
        this.stopped = true;
        this.update({ status: response.status === 401 ? 'authentication' : 'session' });
        return;
      }
      if (response.status === 403) {
        const contextKey = JSON.stringify(context);
        // Quarantine old IDs permanently; new actions can test restored access after a bounded cooldown.
        // The cooldown is not persisted: a fresh report/shell opening checks current permissions again.
        this.blockedContexts.set(contextKey, this.deps.now() + 60_000);
        await this.quarantine([...this.entries.values()].filter((entry) => JSON.stringify(entry.context) === contextKey).map((entry) => entry.event.id), 'access');
        return;
      }
      if (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)) {
        await this.quarantine(events.map((event) => event.id), 'rejected'); return;
      }
      if (!response.ok) { this.retry(response.headers.get('Retry-After')); return; }
      // A gateway's HTTP 200 HTML is not an acknowledgement. Retain IDs until a positive API ACK.
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw new Error('Missing usage acknowledgement');
      const ids = events.map((event) => event.id);
      // A failed local delete leaves the same immutable IDs on disk. Replaying them is idempotent.
      try { if (this.deps.now() >= this.storageRetryAt) await this.deps.outbox?.acknowledge(ids); } catch { this.storageFailed(); }
      this.remove(ids);
      for (const id of ids) this.acknowledged.add(id);
      while (this.acknowledged.size > DASHBOARD_USAGE_QUEUE_LIMIT * 2) this.acknowledged.delete(this.acknowledged.values().next().value!);
      this.attempt = 0;
      this.update({ status: this.entries.size > this.quarantineCount ? 'pending' : 'idle', retryAt: null });
      if (this.entries.size > this.quarantineCount) this.schedule(0);
    } catch { this.retry(null); }
    finally { if (timeout) this.deps.cancel(timeout); }
  }

  private retry(retryAfter: string | null) {
    const delay = dashboardUsageRetryDelay(this.attempt++, retryAfter, this.deps.now(), this.deps.random());
    this.update({ status: 'retrying', retryAt: this.deps.now() + delay });
    this.schedule(delay);
  }

  /** Provider cleanup cancels background work; unmount first makes a bounded final flush. */
  dispose() {
    this.disposed = true;
    if (this.timer) this.deps.cancel(this.timer);
    this.timer = null;
  }

  resume() {
    this.disposed = false;
    void this.initialize().then(() => { if (this.entries.size > this.quarantineCount) this.schedule(FLUSH_DELAY_MS); });
  }
}
