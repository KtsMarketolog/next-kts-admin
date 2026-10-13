import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as protocol from '../src/shared/lib/dashboardUsage';
import { DashboardUsageDelivery, DASHBOARD_USAGE_QUEUE_LIMIT, DASHBOARD_USAGE_REQUEST_TIMEOUT_MS, DASHBOARD_USAGE_SESSION_HEADER, dashboardUsageRetryDelay } from '../src/shared/lib/dashboardUsageDelivery';

const context = { dashboardKey: 'top:4', preview: false, versionId: 7 };
const event = (index = 1) => ({ id: `synthetic_event_${String(index).padStart(8, '0')}`, action: 'filter_changed' as const });
const ack = () => Response.json({ ok: true });
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function fixture(send: (input: RequestInfo | URL, options?: RequestInit) => Promise<Response> = async () => ack()) {
  let now = 1_000_000, sequence = 0, online = true;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const calls: Array<{ payload: protocol.DashboardUsageBatch; options: RequestInit }> = [];
  const delivery = new DashboardUsageDelivery('original-session', {
    fetch: async (input, options) => { calls.push({ payload: JSON.parse(String(options?.body)), options: options! }); return send(input, options); },
    now: () => now, random: () => 0.5, online: () => online,
    schedule: (callback, delay) => { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id as unknown as ReturnType<typeof setTimeout>; },
    cancel: (id) => { timers.delete(id as unknown as number); },
  });
  return { delivery, calls, timers, now: () => now, setOnline: (value: boolean) => { online = value; }, async advance(ms: number) {
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

test('401, 403, 409 and permanent validation failure retain a visible stopped state and never rebind', async () => {
  for (const [status, expected] of [[401, 'authentication'], [403, 'access'], [409, 'session'], [400, 'rejected']] as const) {
    const f = fixture(async () => Response.json({ error: 'Synthetic' }, { status }));
    f.delivery.enqueue(context, event()); await f.delivery.flush();
    assert.equal(f.delivery.getSnapshot().status, expected);
    assert.equal(f.delivery.getSnapshot().pending, 1);
    assert.equal(f.delivery.enqueue(context, event(2)), false);
    await f.advance(600_000); await f.delivery.flush();
    assert.equal(f.calls.length, 1);
  }
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
    assert.deepEqual(Object.keys(call.payload.events[0]).sort(), ['action', 'id']);
  }
});

test('full queue does not evict captured events; overflow is visible; unexpected private values are rejected', () => {
  const f = fixture();
  for (let i = 0; i < DASHBOARD_USAGE_QUEUE_LIMIT; i++) assert.equal(f.delivery.enqueue(context, event(i)), true);
  assert.equal(f.delivery.enqueue(context, event(DASHBOARD_USAGE_QUEUE_LIMIT)), false);
  assert.equal(f.delivery.getSnapshot().pending, DASHBOARD_USAGE_QUEUE_LIMIT);
  assert.equal(f.delivery.getSnapshot().skipped, 1);
  assert.throws(() => f.delivery.enqueue(context, { ...event(900), value: 'secret' } as protocol.DashboardUsageEvent));
  f.delivery.dispose();
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
