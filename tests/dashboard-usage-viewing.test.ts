import assert from 'node:assert/strict';
import test from 'node:test';
import { DashboardUsageViewing } from '../src/shared/lib/dashboardUsageViewing';
import type { DashboardUsageBatch, DashboardUsageEvent } from '../src/shared/lib/dashboardUsage';

const base = { dashboardKey: 'top:4', preview: false, versionId: 7 };
function fixture() {
  let now = 0, id = 0;
  const events: Array<{ context: Omit<DashboardUsageBatch, 'events'>; event: DashboardUsageEvent }> = [];
  const tracker = new DashboardUsageViewing((context, event) => events.push({ context, event }), () => now, () => `synthetic_window_${++id}`);
  return { tracker, events, advance: (ms: number) => { now += ms; } };
}
test('time starts only after visible registration; hiding/disposing closes exact visible segment', () => {
  const f = fixture(); const report = f.tracker.register(base);
  f.advance(30_000); f.tracker.flush(); assert.equal(f.events.length, 0);
  report.setVisible(true); f.advance(4200); report.setVisible(false);
  assert.equal(f.events[0].event.durationSeconds, 4);
  f.advance(3_600_000); f.tracker.flush(); assert.equal(f.events.length, 1);
  report.setVisible(true); f.advance(3100); report.dispose();
  assert.equal(f.events[1].event.durationSeconds, 3);
  f.advance(100_000); f.tracker.flush(); assert.equal(f.events.length, 2);
});
test('paired reports share each stable visible-window ID so employee MAX does not double-count time', () => {
  const f = fixture(); const sales = f.tracker.register(base), currency = f.tracker.register({ ...base, dashboardKey: 'currency-rates' });
  sales.setVisible(true); currency.setVisible(true); f.advance(15_000); f.tracker.flush();
  assert.equal(f.events.length, 2);
  assert.equal(f.events[0].event.viewingWindowId, f.events[1].event.viewingWindowId);
  assert.notEqual(f.events[0].event.id, f.events[1].event.id);
  assert.deepEqual(f.events.map(({ event }) => event.durationSeconds), [15, 15]);
  f.advance(5000); currency.setVisible(false); f.advance(10_000); f.tracker.flush();
  const windows = new Map<string, number>();
  for (const { event } of f.events) windows.set(event.viewingWindowId!, Math.max(windows.get(event.viewingWindowId!) ?? 0, event.durationSeconds!));
  assert.equal([...windows.values()].reduce((a, b) => a + b, 0), 30);
  assert.equal(f.events.filter(({ context }) => context.dashboardKey === 'currency-rates').reduce((sum, { event }) => sum + event.durationSeconds!, 0), 20);
});
test('the same report mounted twice is not double-counted; resumed device is bounded; no subsecond fake event', () => {
  const f = fixture(); const first = f.tracker.register(base), second = f.tracker.register(base);
  first.setVisible(true); second.setVisible(true); f.advance(15_000); f.tracker.flush();
  assert.equal(f.events.length, 1);
  f.advance(500); f.tracker.flush(); assert.equal(f.events.length, 1);
  f.advance(2 * 3_600_000); f.tracker.flush();
  assert.equal(f.events[1].event.durationSeconds, 60);
  first.dispose(); second.dispose(); f.advance(30_000); f.tracker.flush(); assert.equal(f.events.length, 2);
});
