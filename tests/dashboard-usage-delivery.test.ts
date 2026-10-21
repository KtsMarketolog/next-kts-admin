import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as protocol from '../src/shared/lib/dashboardUsage';
import * as usageFilters from '../src/shared/lib/dashboardUsageFilters';
import { DashboardUsageDelivery, DASHBOARD_USAGE_QUEUE_LIMIT, DASHBOARD_USAGE_REQUEST_TIMEOUT_MS, DASHBOARD_USAGE_SESSION_HEADER, dashboardUsageRetryDelay } from '../src/shared/lib/dashboardUsageDelivery';
import { DASHBOARD_USAGE_OUTBOX_MAX_AGE_MS, DASHBOARD_USAGE_OUTBOX_MAX_BYTES, dashboardUsageEntryBytes, type DashboardUsageOutbox, type DashboardUsageOutboxEntry } from '../src/shared/lib/dashboardUsageOutbox';

const context = { dashboardKey: 'top:4', preview: false, versionId: 7 };
const event = (index = 1) => ({ id: `synthetic_event_${String(index).padStart(8, '0')}`, action: 'filter_changed' as const });
const ack = () => Response.json({ ok: true });
async function settle() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
function memoryOutbox() {
  const entries = new Map<string, DashboardUsageOutboxEntry>();
  let skipped = 0, expiredTotal = 0;
  let failDelete = false;
  const store: DashboardUsageOutbox = {
    async load(now) {
      let expired = 0;
      for (const [id, entry] of entries) if (entry.queuedAt < now - DASHBOARD_USAGE_OUTBOX_MAX_AGE_MS) { entries.delete(id); expired++; }
      expiredTotal += expired;
      return { entries: structuredClone([...entries.values()]), expired: expiredTotal, skipped };
    },
    async put(entry) { if (!entries.has(entry.event.id)) entries.set(entry.event.id, structuredClone(entry)); return 'stored'; },
    async acknowledge(ids) { if (failDelete) throw Error('storage failure'); for (const id of ids) entries.delete(id); },
    async quarantine(ids, reason) { for (const id of ids) { const entry = entries.get(id); if (entry) entry.quarantine = reason; } },
    async recordLoss(reason, count) { if (reason === 'overflow') skipped += count; else expiredTotal += count; },
  };
  return { store, entries, setDeleteFailure(value: boolean) { failDelete = value; } };
}
function fixture(send: (input: RequestInfo | URL, options?: RequestInit) => Promise<Response> = async () => ack(), options: { outbox?: DashboardUsageOutbox | null; sessionId?: string; now?: number } = {}) {
  let now = options.now ?? 1_000_000, sequence = 0, online = true;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const calls: Array<{ payload: protocol.DashboardUsageBatch; options: RequestInit }> = [];
  const delivery = new DashboardUsageDelivery(options.sessionId ?? 'original-session', {
    fetch: async (input, options) => { calls.push({ payload: JSON.parse(String(options?.body)), options: options! }); return send(input, options); },
    now: () => now, random: () => 0.5, online: () => online,
    schedule: (callback, delay) => { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id as unknown as ReturnType<typeof setTimeout>; },
    cancel: (id) => { timers.delete(id as unknown as number); },
    outbox: options.outbox === undefined ? memoryOutbox().store : options.outbox,
  });
  return { delivery, calls, timers, now: () => now, setOnline: (value: boolean) => { online = value; }, async advance(ms: number) {
    await settle();
    const end = now + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, value]) => value.at <= end);
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].callback(); await settle();
    }
    now = end; await settle();
  } };
}

test('network failure retains exact IDs, retries and only removes positively acknowledged events', async () => {
  let attempts = 0;
  const f = fixture(async () => { if (++attempts === 1) throw Error('offline'); return ack(); });
  f.delivery.enqueue(context, event());
  await f.delivery.flush();
  assert.equal(f.delivery.getSnapshot().pending, 1);
  assert.equal(f.delivery.getSnapshot().status, 'retrying');
  await f.advance(1000);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].payload, f.calls[1].payload);
  assert.equal(new Headers(f.calls[1].options.headers).get(DASHBOARD_USAGE_SESSION_HEADER), 'original-session');
  assert.equal(f.delivery.getSnapshot().pending, 0);
  assert.equal(f.delivery.getSnapshot().status, 'idle');
  assert.equal(f.calls[1].options.keepalive, true);
});

test('lost ACK, timeout and simultaneous flushes cannot mint another event ID or duplicate pending requests', async () => {
  let count = 0;
  const f = fixture(async () => ++count === 1 ? new Promise<Response>(() => {}) : ack());
  f.delivery.enqueue(context, event());
  const pending = f.delivery.flush();
  assert.equal(f.delivery.flush(), pending);
  await f.advance(DASHBOARD_USAGE_REQUEST_TIMEOUT_MS);
  await pending;
  assert.equal(f.calls[0].options.signal?.aborted, true);
  assert.equal(f.delivery.getSnapshot().pending, 1);
  await f.advance(1000);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].payload, f.calls[1].payload);
  assert.equal(f.delivery.getSnapshot().pending, 0);
  f.delivery.enqueue(context, event());
  assert.equal(f.delivery.getSnapshot().pending, 0, 'recent acknowledged IDs are ignored');
});

test('timeout also covers a response body that never finishes', async () => {
  const f = fixture(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }), { headers: { 'Content-Type': 'application/json' } }));
  f.delivery.enqueue(context, event());
  const pending = f.delivery.flush();
  await f.advance(DASHBOARD_USAGE_REQUEST_TIMEOUT_MS);
  await pending;
  assert.equal(f.delivery.getSnapshot().status, 'retrying');
  assert.equal(f.delivery.getSnapshot().pending, 1);
  f.delivery.dispose();
});

test('401 and 409 retain a visible stopped state and never rebind', async () => {
  for (const [status, expected] of [[401, 'authentication'], [409, 'session']] as const) {
    const f = fixture(async () => Response.json({ error: 'Synthetic' }, { status }));
    f.delivery.enqueue(context, event()); await f.delivery.flush();
    assert.equal(f.delivery.getSnapshot().status, expected);
    assert.equal(f.delivery.getSnapshot().pending, 1);
    assert.equal(f.delivery.enqueue(context, event(2)), false);
    await f.advance(600_000); await f.delivery.flush();
    assert.equal(f.calls.length, 1);
  }
});

test('403 quarantines only its report context, persists the quarantine and keeps other reports sending', async () => {
  const disk = memoryOutbox();
  const f = fixture(async (_input, options) => JSON.parse(String(options?.body)).dashboardKey === context.dashboardKey ? Response.json({}, { status: 403 }) : ack(), { outbox: disk.store });
  f.delivery.enqueue(context, event(1));
  f.delivery.enqueue({ ...context, dashboardKey: 'currency-rates' }, event(2));
  f.delivery.enqueue(context, event(3));
  await f.delivery.flush(); await f.advance(0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.delivery.getSnapshot().pending, 0);
  assert.equal(f.delivery.getSnapshot().quarantined, 2);
  assert.equal(f.delivery.enqueue(context, event(4)), true);
  await f.delivery.persistPending();
  assert.equal(disk.entries.get(event(4).id)?.quarantine, 'access');
  f.delivery.dispose();
  const reloaded = fixture(async () => ack(), { outbox: disk.store });
  reloaded.delivery.enqueue({ ...context, dashboardKey: 'currency-rates' }, event(5));
  await reloaded.delivery.flush();
  assert.equal(reloaded.calls.length, 1);
  assert.equal(reloaded.calls[0].payload.dashboardKey, 'currency-rates');
  assert.equal(reloaded.delivery.getSnapshot().quarantined, 3);
  reloaded.delivery.dispose();
});

test('a transient initial storage failure automatically recovers durable events without new user actions', async () => {
  const disk = memoryOutbox();
  disk.entries.set(event().id, { context, event: event(), queuedAt: 1_000_000 });
  const load = disk.store.load; let attempts = 0;
  disk.store.load = async (now) => { if (++attempts === 1) throw Error('Temporary IndexedDB failure'); return load(now); };
  const f = fixture(async () => ack(), { outbox: disk.store });
  f.delivery.resume(); await settle();
  assert.equal(f.delivery.getSnapshot().pending, 0);
  assert.equal(f.delivery.getSnapshot().storage, 'unavailable');
  await f.advance(30_000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].payload.events[0].id, event().id);
  assert.equal(disk.entries.size, 0); f.delivery.dispose();
});

test('fallback delivery of a new event does not abandon older disk events after initial hydration fails', async () => {
  const disk = memoryOutbox();
  disk.entries.set(event(1).id, { context, event: event(1), queuedAt: 1_000_000 });
  const load = disk.store.load; let attempts = 0;
  disk.store.load = async (now) => { if (++attempts === 1) throw Error('Temporary IndexedDB failure'); return load(now); };
  const f = fixture(async () => ack(), { outbox: disk.store });
  f.delivery.enqueue(context, event(2)); await f.delivery.flush();
  assert.equal(f.calls[0].payload.events[0].id, event(2).id);
  await f.advance(30_000);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].payload.events[0].id, event(1).id);
  f.delivery.dispose();
});

test('restored report access accepts new events after reload or cooldown without replaying old quarantine IDs', async () => {
  const disk = memoryOutbox(); let denied = true;
  const f = fixture(async () => denied ? Response.json({}, { status: 403 }) : ack(), { outbox: disk.store });
  f.delivery.enqueue(context, event(1)); await f.delivery.flush();
  f.delivery.enqueue(context, event(2)); await f.delivery.flush();
  assert.equal(f.calls.length, 1, 'new denied actions respect the per-context cooldown');
  denied = false; await f.advance(60_000);
  f.delivery.enqueue(context, event(3)); await f.delivery.flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].payload.events[0].id, event(3).id);
  assert.equal(f.delivery.getSnapshot().quarantined, 2);
  f.delivery.dispose();
  const reloaded = fixture(async () => ack(), { outbox: disk.store });
  reloaded.delivery.enqueue(context, event(4)); await reloaded.delivery.flush();
  assert.equal(reloaded.calls.length, 1);
  assert.deepEqual(reloaded.calls[0].payload.events.map((entry) => entry.id), [event(4).id]);
  assert.equal(reloaded.delivery.getSnapshot().quarantined, 2); reloaded.delivery.dispose();
});

test('a fresh report opening checks restored access before the previous 403 cooldown expires', async () => {
  let denied = true;
  const f = fixture(async () => denied ? Response.json({}, { status: 403 }) : ack());
  f.delivery.enqueue(context, event(1)); await f.delivery.flush();
  denied = false;
  f.delivery.enqueue(context, { ...event(2), action: 'report_open' });
  f.delivery.enqueue(context, event(3)); await f.delivery.flush();
  assert.deepEqual(f.calls[1].payload.events.map((entry) => entry.id), [event(2).id, event(3).id]);
  assert.equal(f.delivery.getSnapshot().quarantined, 1); f.delivery.dispose();
});

test('permanent payload rejection isolates only that batch; subsequent batches and reports are unaffected', async () => {
  let attempts = 0;
  const f = fixture(async () => ++attempts === 1 ? Response.json({}, { status: 400 }) : ack());
  for (let i = 0; i < 22; i++) f.delivery.enqueue(context, event(i));
  f.delivery.enqueue({ ...context, dashboardKey: 'currency-rates' }, event(30));
  await f.delivery.flush(); await f.advance(0);
  assert.equal(f.delivery.getSnapshot().quarantined, 20);
  assert.equal(f.delivery.getSnapshot().pending, 0);
  assert.deepEqual(f.calls.map((call) => call.payload.events.length), [20, 2, 1]);
  f.delivery.dispose();
});

test('429 and 503 respect Retry-After even after manual retry / online flush', async () => {
  for (const status of [429, 503]) {
    let first = true;
    const f = fixture(async () => { if (first) { first = false; return new Response('', { status, headers: { 'Retry-After': '30' } }); } return ack(); });
    f.delivery.enqueue(context, event()); await f.delivery.flush();
    assert.equal(f.delivery.getSnapshot().retryAt, f.now() + 30_000);
    await f.delivery.flush(); await f.advance(29_999);
    assert.equal(f.calls.length, 1);
    await f.advance(1); assert.equal(f.calls.length, 2); assert.equal(f.delivery.getSnapshot().pending, 0);
  }
  assert.equal(dashboardUsageRetryDelay(0, new Date(1_030_000).toUTCString(), 1_000_000, 0.5), 30_000);
  assert.equal(dashboardUsageRetryDelay(50, null, 0, 1), 60_000);
  assert.equal(dashboardUsageRetryDelay(0, '999999999999', 0, 0), 300_000);
});

test('offline queue is retained; online flush drains bounded per-dashboard batches without values or credentials', async () => {
  const f = fixture(); f.setOnline(false);
  for (let i = 0; i < 43; i++) f.delivery.enqueue(i < 22 ? context : { ...context, dashboardKey: 'currency-rates' }, event(i));
  await f.delivery.flush();
  assert.equal(f.calls.length, 0); assert.equal(f.delivery.getSnapshot().status, 'offline');
  f.setOnline(true); await f.delivery.flush(); await f.advance(0);
  assert.deepEqual(f.calls.map((call) => call.payload.events.length), [20, 2, 20, 1]);
  assert.equal(f.delivery.getSnapshot().pending, 0);
  assert.equal(new Set(f.calls.flatMap((call) => call.payload.events.map((entry) => entry.id))).size, 43);
  for (const call of f.calls) {
    assert.ok(Buffer.byteLength(String(call.options.body)) <= protocol.DASHBOARD_USAGE_MAX_BODY);
    assert.deepEqual(Object.keys(call.payload).sort(), ['dashboardKey', 'events', 'preview', 'versionId']);
    assert.deepEqual(Object.keys(call.payload.events[0]).sort(), ['action', 'capturedAt', 'id']);
  }
});

test('full queue does not evict captured events; overflow is visible; unexpected private values are rejected', async () => {
  const f = fixture();
  for (let i = 0; i < DASHBOARD_USAGE_QUEUE_LIMIT; i++) assert.equal(f.delivery.enqueue(context, event(i)), true);
  assert.equal(f.delivery.enqueue(context, event(DASHBOARD_USAGE_QUEUE_LIMIT)), false);
  assert.equal(f.delivery.getSnapshot().pending, DASHBOARD_USAGE_QUEUE_LIMIT);
  assert.equal(f.delivery.getSnapshot().skipped, 1);
  assert.throws(() => f.delivery.enqueue(context, { ...event(900), value: 'secret' } as protocol.DashboardUsageEvent));
  await f.delivery.persistPending();
  f.delivery.dispose();
});

test('hard reload recovers more than 500 offline events with their original IDs and captured timestamps', async () => {
  const disk = memoryOutbox();
  const f = fixture(async () => ack(), { outbox: disk.store }); f.setOnline(false);
  for (let i = 0; i < 1205; i++) assert.equal(f.delivery.enqueue(context, event(i)), true);
  await f.delivery.flush();
  assert.equal(f.delivery.getSnapshot().pending, 1205);
  assert.equal(f.delivery.getSnapshot().unsaved, 0);
  const first = structuredClone(disk.entries.get(event(0).id));
  f.delivery.dispose();
  const next = fixture(async () => ack(), { outbox: disk.store, now: f.now() + 60_000 });
  await next.delivery.flush(); await next.advance(0);
  assert.equal(next.calls.flatMap((call) => call.payload.events).length, 1205);
  assert.deepEqual(next.calls[0].payload.events[0], first?.event);
  assert.equal(next.delivery.getSnapshot().pending, 0);
  assert.equal(disk.entries.size, 0);
  next.delivery.dispose();
});

test('ACK delete failure retains durable IDs for safe replay after reload, rather than losing the event', async () => {
  const disk = memoryOutbox(); disk.setDeleteFailure(true);
  const f = fixture(async () => ack(), { outbox: disk.store });
  f.delivery.enqueue(context, event()); await f.delivery.flush();
  assert.equal(f.delivery.getSnapshot().pending, 0);
  assert.equal(f.delivery.getSnapshot().storage, 'unavailable');
  assert.equal(disk.entries.size, 1);
  f.delivery.dispose(); disk.setDeleteFailure(false);
  const reloaded = fixture(async () => ack(), { outbox: disk.store });
  await reloaded.delivery.flush();
  assert.deepEqual(reloaded.calls[0].payload, f.calls[0].payload);
  assert.equal(disk.entries.size, 0); reloaded.delivery.dispose();
});

test('storage unavailable or full is visible but does not prevent live delivery', async () => {
  for (const reason of ['unavailable', 'full'] as const) {
    const disk = memoryOutbox();
    disk.store.put = async () => { if (reason === 'unavailable') throw Error('QuotaExceededError'); return 'full'; };
    const f = fixture(async () => ack(), { outbox: disk.store }); f.setOnline(false);
    f.delivery.enqueue(context, event()); await f.delivery.flush();
    assert.equal(f.delivery.getSnapshot().storage, reason);
    assert.equal(f.delivery.getSnapshot().unsaved, 1);
    assert.equal(f.delivery.getSnapshot().pending, 1);
    f.setOnline(true); await f.delivery.flush();
    assert.equal(f.delivery.getSnapshot().pending, 0);
    assert.equal(f.calls.length, 1); f.delivery.dispose();
  }
});

test('byte quota stops large metadata before the count quota without evicting captured entries', async () => {
  const f = fixture();
  let accepted = 0;
  for (let i = 0; i < DASHBOARD_USAGE_QUEUE_LIMIT; i++) {
    if (!f.delivery.enqueue(context, { ...event(i), action: 'data_loaded', upload: { name: '界'.repeat(250), size: 42 } })) break;
    accepted++;
  }
  assert.ok(accepted > 500 && accepted < DASHBOARD_USAGE_QUEUE_LIMIT);
  const bytes = dashboardUsageEntryBytes({ context, event: { ...event(0), capturedAt: new Date(f.now()).toISOString(), action: 'data_loaded', upload: { name: '界'.repeat(250), size: 42 } }, queuedAt: f.now() });
  assert.ok(accepted * bytes <= DASHBOARD_USAGE_OUTBOX_MAX_BYTES);
  assert.equal(f.delivery.getSnapshot().pending, accepted);
  assert.equal(f.delivery.getSnapshot().skipped, 1);
  await f.delivery.persistPending(); f.delivery.dispose();
});

test('expired local records are not replayed and the removal is visible', async () => {
  const disk = memoryOutbox();
  disk.entries.set(event().id, { context, event: event(), queuedAt: 0 });
  const f = fixture(async () => ack(), { outbox: disk.store, now: DASHBOARD_USAGE_OUTBOX_MAX_AGE_MS + 1 });
  await f.delivery.flush();
  assert.equal(f.delivery.getSnapshot().expired, 1);
  assert.equal(f.calls.length, 0); f.delivery.dispose();
});

test('overflow counters survive reload and loading a full durable queue does not evict it for new captures', async () => {
  const disk = memoryOutbox();
  for (let i = 0; i < DASHBOARD_USAGE_QUEUE_LIMIT; i++) disk.entries.set(event(i).id, { context, event: event(i), queuedAt: 1_000_000 });
  const f = fixture(async () => ack(), { outbox: disk.store }); f.setOnline(false);
  // This capture races initial storage loading; retained disk events take priority at the bound.
  f.delivery.enqueue(context, event(DASHBOARD_USAGE_QUEUE_LIMIT + 1));
  await f.delivery.persistPending();
  assert.equal(f.delivery.getSnapshot().pending, DASHBOARD_USAGE_QUEUE_LIMIT);
  assert.equal(f.delivery.getSnapshot().skipped, 1);
  assert.equal(disk.entries.size, DASHBOARD_USAGE_QUEUE_LIMIT);
  assert.ok(!disk.entries.has(event(DASHBOARD_USAGE_QUEUE_LIMIT + 1).id));
  f.delivery.dispose();
  const next = fixture(async () => ack(), { outbox: disk.store }); next.setOnline(false);
  await next.delivery.flush();
  assert.equal(next.delivery.getSnapshot().skipped, 1);
  assert.equal(next.delivery.getSnapshot().pending, DASHBOARD_USAGE_QUEUE_LIMIT);
  next.delivery.dispose();
});

test('transient server failures have no finite attempt limit', async () => {
  let attempts = 0;
  const f = fixture(async () => ++attempts < 55 ? new Response('', { status: 503 }) : ack());
  f.delivery.enqueue(context, event()); await f.delivery.flush();
  for (let i = 0; i < 55; i++) await f.advance(60_000);
  assert.equal(f.calls.length, 55);
  assert.ok(f.calls.every((call) => call.payload.events[0].id === event().id));
  assert.equal(f.delivery.getSnapshot().pending, 0); f.delivery.dispose();
});

test('UTF-8 filename metadata splits batches by encoded bytes as well as count and retains each upload', async () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) f.delivery.enqueue(context, { ...event(i), action: 'data_loaded', upload: { name: '界'.repeat(245) + '.json', size: 123 } });
  await f.delivery.flush(); await f.advance(0);
  assert.ok(f.calls.length > 1);
  assert.equal(f.calls.reduce((sum, call) => sum + call.payload.events.length, 0), 20);
  for (const call of f.calls) assert.ok(Buffer.byteLength(String(call.options.body)) <= protocol.DASHBOARD_USAGE_MAX_BODY);
  assert.equal(f.delivery.getSnapshot().pending, 0);
});

test('HTTP 200 without ACK is retained; teardown/resume keeps pending IDs across React effect remount', async () => {
  let first = true;
  const f = fixture(async () => { if (first) { first = false; return Response.json({ unexpected: true }); } return ack(); });
  f.delivery.enqueue(context, event()); await f.delivery.flush();
  f.delivery.dispose(); await f.advance(20_000);
  assert.equal(f.calls.length, 1);
  f.delivery.resume(); await f.advance(5000);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[0].payload, f.calls[1].payload);
  assert.equal(f.delivery.getSnapshot().pending, 0);
});

test('actual POST rejects stale/missing session correlation before parsing, limiting or writing', async () => {
  let writes = 0, limited = 0;
  const dependencies: Record<string, unknown> = {
    '@/shared/lib/adminAuth': { getAdminSession: async () => ({ sessionId: 'current-session', role: 'admin' }), isTopDashboardManagementSession: () => true },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => { limited++; return null; } },
    '@/shared/lib/dashboardAccess': { canViewDashboard: () => true },
    '@/shared/lib/currencyDashboardAccess': { canManageCurrencyDashboard: () => true },
    '@/shared/lib/dashboardUsage': protocol,
    '@/shared/lib/dashboardUsageFilters': usageFilters,
    '@/shared/lib/db/dashboardUsageRepo': { recordDashboardUsage: async () => { writes++; } },
    '@/shared/lib/originProtection': { enforceSameOriginRequest: () => null },
    '@/shared/lib/dashboardUsageAccess': { canReviewDashboardUsage: () => true },
    '@/shared/lib/dashboardUsageDelivery': { DASHBOARD_USAGE_SESSION_HEADER },
  };
  const output = ts.transpileModule(readFileSync('src/app/api/admin/dashboard-usage/route.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const loaded = { exports: {} as { POST: (request: Request) => Promise<Response> } };
  new Function('require', 'module', 'exports', output)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, loaded, loaded.exports);
  for (const scope of [null, 'previous-session']) {
    const headers = new Headers({ 'Content-Type': 'application/json' }); if (scope) headers.set(DASHBOARD_USAGE_SESSION_HEADER, scope);
    const response = await loaded.exports.POST(new Request('https://example.test/api/admin/dashboard-usage', { method: 'POST', headers, body: 'not even JSON' }));
    assert.equal(response.status, 409); assert.equal(writes, 0); assert.equal(limited, 0);
  }
  const response = await loaded.exports.POST(new Request('https://example.test/api/admin/dashboard-usage', {
    method: 'POST', headers: { 'Content-Type': 'application/json', [DASHBOARD_USAGE_SESSION_HEADER]: 'current-session' },
    body: JSON.stringify({ ...context, events: [event()] }),
  }));
  assert.equal(response.status, 200); assert.equal(writes, 1);
});
