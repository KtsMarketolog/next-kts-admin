import { DASHBOARD_USAGE_MAX_BATCH, DASHBOARD_USAGE_MAX_BODY, parseDashboardUsageBatch, type DashboardUsageBatch, type DashboardUsageEvent } from './dashboardUsage';
import { DashboardUsageViewing } from './dashboardUsageViewing';

/** Correlation only, never a credential. The server still authenticates its HttpOnly cookie. */
export const DASHBOARD_USAGE_SESSION_HEADER = 'X-Dashboard-Usage-Session';
export const DASHBOARD_USAGE_QUEUE_LIMIT = 500;
export const DASHBOARD_USAGE_REQUEST_TIMEOUT_MS = 10_000;
const FLUSH_DELAY_MS = 5000;
const MAX_RETRY_MS = 60_000;
const MAX_RETRY_AFTER_MS = 300_000;
type Context = Omit<DashboardUsageBatch, 'events'>;
type Entry = { context: Context; event: DashboardUsageEvent };
type Timer = ReturnType<typeof setTimeout>;
export type DashboardUsageDeliveryState = {
  pending: number;
  skipped: number;
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

/** Memory only. A fixed server-rendered session scope must never be rebound after login changes. */
export class DashboardUsageDelivery {
  readonly viewing: DashboardUsageViewing;
  private entries: Entry[] = [];
  private acknowledged = new Set<string>();
  private listeners = new Set<() => void>();
  private timer: Timer | null = null;
  private attempt = 0;
  private inFlight: Promise<void> | null = null;
  private disposed = false;
  private stopped = false;
  private state: DashboardUsageDeliveryState = { pending: 0, skipped: 0, status: 'idle', retryAt: null };
  private deps: Dependencies;

  constructor(readonly sessionId: string | null, dependencies: Partial<Dependencies> = {}) {
    this.deps = {
      fetch: (...args) => globalThis.fetch(...args), now: Date.now, random: Math.random,
      online: () => typeof navigator === 'undefined' || navigator.onLine,
      schedule: (callback, delay) => setTimeout(callback, delay), cancel: (timer) => clearTimeout(timer),
      ...dependencies,
    };
    this.viewing = new DashboardUsageViewing((context, event) => { this.enqueue(context, event); });
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(value: Partial<DashboardUsageDeliveryState>) {
    this.state = { ...this.state, ...value, pending: this.entries.length };
    this.listeners.forEach((listener) => listener());
  }
  private schedule(delay: number) {
    if (this.disposed || this.stopped) return;
    if (this.timer) this.deps.cancel(this.timer);
    this.timer = this.deps.schedule(() => { this.timer = null; void this.flush(); }, Math.max(0, delay));
  }

  enqueue(context: Context, event: DashboardUsageEvent) {
    if (this.disposed || this.stopped) return false;
    // Reuse the API's allowlist: never retain business values or other unexpected fields.
    const safe = parseDashboardUsageBatch({ ...context, events: [event] });
    if (this.acknowledged.has(event.id) || this.entries.some((entry) => entry.event.id === event.id)) return true;
    if (this.entries.length >= DASHBOARD_USAGE_QUEUE_LIMIT) {
      this.update({ skipped: this.state.skipped + 1 });
      return false;
    }
    this.entries.push({ context: { dashboardKey: safe.dashboardKey, preview: safe.preview, versionId: safe.versionId }, event: safe.events[0] });
    if (!this.sessionId) { this.stopped = true; this.update({ status: 'authentication' }); return false; }
    this.update({ status: this.state.status === 'idle' ? 'pending' : this.state.status });
    if (!this.timer && !this.inFlight) this.schedule(FLUSH_DELAY_MS);
    return true;
  }

  flush = (): Promise<void> => {
    if (this.inFlight) return this.inFlight;
    if (this.disposed || this.stopped || !this.entries.length) return Promise.resolve();
    if (this.timer) { this.deps.cancel(this.timer); this.timer = null; }
    if (this.state.retryAt && this.deps.now() < this.state.retryAt) {
      this.schedule(this.state.retryAt - this.deps.now());
      return Promise.resolve();
    }
    if (!this.deps.online()) {
      this.update({ status: 'offline', retryAt: null });
      this.schedule(15_000);
      return Promise.resolve();
    }
    this.inFlight = this.send().finally(() => { this.inFlight = null; });
    return this.inFlight;
  };

  private async send() {
    const context = this.entries[0].context;
    const events: DashboardUsageEvent[] = [];
    for (const entry of this.entries) {
      if (entry.context.dashboardKey !== context.dashboardKey || entry.context.preview !== context.preview || entry.context.versionId !== context.versionId) break;
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
      if ([401, 403, 409].includes(response.status) || (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status))) {
        this.stopped = true;
        this.update({ status: response.status === 401 ? 'authentication' : response.status === 403 ? 'access' : response.status === 409 ? 'session' : 'rejected' });
        return;
      }
      if (!response.ok) { this.retry(response.headers.get('Retry-After')); return; }
      // A gateway's HTTP 200 HTML is not an acknowledgement. Retain IDs until a positive API ACK.
      if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw new Error('Missing usage acknowledgement');
      const ids = new Set(events.map((event) => event.id));
      this.entries = this.entries.filter((entry) => !ids.has(entry.event.id));
      for (const id of ids) this.acknowledged.add(id);
      while (this.acknowledged.size > DASHBOARD_USAGE_QUEUE_LIMIT * 2) this.acknowledged.delete(this.acknowledged.values().next().value!);
      this.attempt = 0;
      this.update({ status: this.entries.length ? 'pending' : 'idle', retryAt: null });
      if (this.entries.length) this.schedule(0);
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
    if (this.entries.length) this.schedule(FLUSH_DELAY_MS);
  }
}
