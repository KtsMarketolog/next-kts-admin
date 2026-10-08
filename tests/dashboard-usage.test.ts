import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { DASHBOARD_USAGE_MARKER, parseDashboardUsageBatch, readDashboardUsageMessage } from '../src/shared/lib/dashboardUsage';
import { dashboardUsageAdapterScript, dashboardUsageRelayScript } from '../src/shared/lib/dashboardUsageBridge';
import { applyDashboardUsageMigration } from '../src/shared/lib/db/dashboardUsageMigration';
import { canReviewDashboardUsage } from '../src/shared/lib/dashboardUsageAccess';
import type { AdminSession } from '../src/shared/lib/adminAuth';

const nonce = '12345678901234567890123456789012';
const batch = { dashboardKey: 'top:4', preview: false, versionId: 7, events: [{ id: nonce, action: 'filter_changed' }] };

test('usage payload permits only whitelisted scalar events, never employee identity or field values', () => {
  assert.deepEqual(parseDashboardUsageBatch(batch), batch);
  for (const extra of [{ actorKey: 'admin:1' }, { email: 'private' }, { values: {} }]) assert.throws(() => parseDashboardUsageBatch({ ...batch, ...extra }));
  assert.throws(() => parseDashboardUsageBatch({ ...batch, events: [{ ...batch.events[0], password: 'secret' }] }));
  assert.throws(() => parseDashboardUsageBatch({ ...batch, events: [batch.events[0], batch.events[0]] }));
  assert.throws(() => parseDashboardUsageBatch({ ...batch, events: [{ ...batch.events[0], action: 'keydown' }] }));
  assert.throws(() => parseDashboardUsageBatch({ ...batch, events: Array.from({ length: 21 }, (_, i) => ({ id: nonce + i, action: 'report_open' })) }));
  for (const dashboardKey of ['top:0', 'top:4/../5', 'admin', 'manager:all']) assert.throws(() => parseDashboardUsageBatch({ ...batch, dashboardKey }));
});

test('message contract rejects unpinned nonces and extra metadata', () => {
  const message = { marker: DASHBOARD_USAGE_MARKER, type: 'event', nonce, action: 'tab_changed' };
  assert.equal(readDashboardUsageMessage(message, nonce), 'tab_changed');
  assert.equal(readDashboardUsageMessage(message, 'other'), null);
  assert.equal(readDashboardUsageMessage({ ...message, value: 'do-not-capture' }, nonce), null);
});

function adapterFixture() {
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const docListeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const messages: Record<string, unknown>[] = [];
  const add = (map: typeof listeners) => (name: string, listener: (event: Record<string, unknown>) => void) => map.set(name, [...(map.get(name) ?? []), listener]);
  const parent = { postMessage: (message: Record<string, unknown>) => messages.push(message) };
  const window = { parent, addEventListener: add(listeners) } as typeof parent & { parent: typeof parent; addEventListener: ReturnType<typeof add>; __ktsDashboardUsage?: { record: (action: string) => void } };
  const document = { hidden: false, addEventListener: add(docListeners) };
  const fire = (name: string, event: Record<string, unknown>) => listeners.get(name)?.forEach((fn) => fn(event));
  const fireDocument = (name: string, event: Record<string, unknown>) => docListeners.get(name)?.forEach((fn) => fn(event));
  class Element { closest() { return null; } matches() { return false; } }
  vm.runInNewContext(dashboardUsageAdapterScript(), { window, document, Element, Date });
  return { window, parent, document, fire, fireDocument, messages };
}

test('opaque adapter handshakes with exact parent; initial data waits for nonce, background calculations ignored', () => {
  const state = adapterFixture();
  state.window.__ktsDashboardUsage!.record('data_loaded');
  state.fire('message', { source: {}, data: { marker: DASHBOARD_USAGE_MARKER, type: 'init', nonce } });
  assert.equal(state.messages.length, 1); // only ready
  state.fire('message', { source: state.parent, data: { marker: DASHBOARD_USAGE_MARKER, type: 'init', nonce } });
  assert.deepEqual(state.messages.slice(1).map((message) => message.action), ['report_open', 'data_loaded']);
  state.window.__ktsDashboardUsage!.record('calculation_completed');
  state.window.__ktsDashboardUsage!.record('export_started');
  assert.equal(state.messages.length, 3);
  state.fireDocument('pointerdown', { isTrusted: true });
  state.window.__ktsDashboardUsage!.record('calculation_completed');
  assert.equal(state.messages.at(-1)?.action, 'calculation_completed');
  assert.equal(state.messages.at(-1)?.nonce, nonce);
  assert.doesNotMatch(dashboardUsageAdapterScript(), /\.value\b|textContent|innerHTML|file\.name|\.password\b/);
});

test('trusted wrapper relay bounds actions and validates both origins and windows', () => {
  assert.doesNotThrow(() => new Function(dashboardUsageRelayScript('frame')));
  assert.throws(() => dashboardUsageRelayScript('frame;injected()'));
  const script = dashboardUsageRelayScript('frame');
  assert.match(script, /event\.source === window\.parent && event\.origin === window\.location\.origin/);
  assert.match(script, /event\.source !== usageFrame\.contentWindow \|\| event\.origin !== 'null'/);
  assert.match(script, /d\.nonce === usageNonce/);
  assert.doesNotMatch(script, /postMessage\(d[,)]/);
});

test('usage migration preserves audit independently and deduplicates bounded retries', async () => {
  let sql = '';
  await applyDashboardUsageMigration({ query: async (value: string) => { sql = value; } } as never);
  assert.match(sql, /unique\(actor_key, event_id\)/);
  assert.match(sql, /dashboard_usage_events_actor_idx/);
  assert.doesNotMatch(sql, /delete|drop|references|password|jsonb/i);
});

test('journal is restricted to persisted admin, TOP and Admin TOP identities, never inferred from report grants', () => {
  for (const role of ['admin', 'admintop', 'top', 'wholesale_admin', 'manager', 'support_manager', 'purchaser'] as const) {
    const session: AdminSession = { role, sessionId: 'stored-session', adminUserId: 8, managerId: 9,
      dashboardAccess: ['currency-rates', 'top:4'], canManageTopDashboard: true };
    assert.equal(canReviewDashboardUsage(session), ['admin', 'admintop', 'top'].includes(role));
    assert.equal(canReviewDashboardUsage({ ...session, sessionId: undefined }), false);
  }
  assert.equal(canReviewDashboardUsage({role: 'top', sessionId: 'stored', adminUserId: undefined}), false);
  assert.equal(canReviewDashboardUsage(null), false);
});

test('API and journal share role gate, same-origin bounded writes and server identity', () => {
  const api = readFileSync('src/app/api/admin/dashboard-usage/route.ts', 'utf8');
  const repo = readFileSync('src/shared/lib/db/dashboardUsageRepo.ts', 'utf8');
  const page = readFileSync('src/app/admin/dashboard-usage/page.tsx', 'utf8');
  assert.match(api, /canReviewDashboardUsage\(session\)/);
  assert.match(page, /canReviewDashboardUsage\(session\)/);
  assert.match(api, /enforceSameOriginRequest\(request\)/);
  assert.match(api, /canViewDashboard\(session, batch\.dashboardKey\)/);
  assert.match(api, /size > DASHBOARD_USAGE_MAX_BODY/);
  assert.match(api, /batch\.preview && !manage/);
  assert.match(repo, /dashboardUsageActorKey\(session\)/);
  assert.match(repo, /event\.id < \$1::bigint/);
  assert.match(repo, /limit 51/);
  assert.match(repo, /event\.created_at >= \(\$\{DASHBOARD_USAGE_RETENTION_CUTOFF_SQL\}\)/);
  assert.match(repo, /interval '1 month'/);
});
