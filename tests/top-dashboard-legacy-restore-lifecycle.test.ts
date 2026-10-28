import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { getTopDashboardDataAdapterScript } from '../src/shared/lib/topDashboardContentSecurity/adapterScript';

const START = 'kts-top-dashboard-restore-start';
const READY = 'kts-top-dashboard-data-ready';
const ERROR = 'kts-top-dashboard-data-error';
type RestoreEvent = { type: string; detail: { restoreId: number } };

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let step = 0; step < 8; step++) await Promise.resolve();
}

/** Execute the production installer with fake DOM delivery and a deterministic
 * clock; readiness remains an explicit dashboard event in every fixture. */
function lifecycleHarness(options: { native?: boolean; failPreparation?: boolean; sales?: boolean } = {}) {
  const script = getTopDashboardDataAdapterScript();
  const start = script.indexOf('  async function installSnapshot(snapshot)');
  const end = script.indexOf("  window.addEventListener('message'", start);
  assert.ok(start >= 0 && end > start);
  const events: RestoreEvent[] = [];
  const messages: string[] = [];
  const handlers: Array<ReturnType<typeof deferred>> = [];
  const delivered: string[][] = [];
  const listeners = new Map<string, Set<(event: RestoreEvent) => void>>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0, timerId = 0, preparationFails = options.failPreparation === true;
  const input = {
    files: [] as Array<{ name: string }>,
    dispatchEvent() { delivered.push(input.files.map(file => file.name)); },
  };
  const dispatch = (event: RestoreEvent) => {
    events.push(event);
    for (const listener of listeners.get(event.type) ?? []) listener(event);
  };
  const window = {
    handleFiles: options.native === false ? undefined : (files: Array<{ name: string }>) => {
      delivered.push(files.map(file => file.name));
      const handler = deferred();
      handlers.push(handler);
      return handler.promise;
    },
    addEventListener(type: string, listener: (event: RestoreEvent) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: (event: RestoreEvent) => void) { listeners.get(type)?.delete(listener); },
    dispatchEvent: dispatch,
    setTimeout(callback: () => void, delay: number) { timers.set(++timerId, { at: now + delay, callback }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const context = {
    window, legacySnapshotPending: false, legacySnapshotRestoreSequence: 0,
    RESTORE_START_EVENT: START, RESTORE_READY_EVENT: READY, RESTORE_ERROR_EVENT: ERROR,
    RESTORE_TIMEOUT_MS: 120000, EXPECTED_PROFILE: options.sales === false ? 'purchases' : 'sales-analytics',
    findSnapshotInput: () => input,
    File: class { constructor(_parts: unknown[], public name: string) {} },
    DataTransfer: class {
      files: Array<{ name: string }> = [];
      items = { add: (file: { name: string }) => { this.files.push(file); } };
      constructor() { if (preparationFails) { preparationFails = false; throw new Error('Synthetic preparation failure'); } }
    },
    Event: class {},
    CustomEvent: class {
      detail: RestoreEvent['detail'];
      constructor(public type: string, options: { detail: RestoreEvent['detail'] }) { this.detail = options.detail; }
    },
    lockFileInputs() {},
    send(type: string) { messages.push(type); },
    report(code: string) { messages.push(code); },
  };
  const install = runInNewContext(`${script.slice(start, end)}\ninstallSnapshot;`, context) as
    (snapshot: { name: string; buffer: ArrayBuffer }) => Promise<void>;
  return {
    events, messages, handlers, delivered,
    get pending() { return context.legacySnapshotPending; },
    get timerCount() { return timers.size; },
    ids(type: string) { return events.filter(event => event.type === type).map(event => event.detail.restoreId); },
    install(name = 'snapshot.json') { return install({ name, buffer: new ArrayBuffer(1) }); },
    dispatch(type: string, restoreId: number) { dispatch({ type, detail: { restoreId } }); },
    async advance(milliseconds: number) {
      const endTime = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= endTime).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flushMicrotasks();
      }
      now = endTime;
      await flushMicrotasks();
    },
  };
}

test('legacy preparation failure releases the restore lock for a successful retry', async () => {
  const view = lifecycleHarness({ failPreparation: true });
  await view.install('failed.json');
  assert.equal(view.pending, false);
  assert.deepEqual(view.ids(ERROR), [1]);
  assert.deepEqual(view.messages, ['SNAPSHOT_INSTALL_FAILED']);
  const retry = view.install('retry.json');
  await flushMicrotasks();
  assert.deepEqual(view.delivered, [['retry.json']]);
  view.handlers[0].resolve();
  await retry;
  assert.deepEqual(view.ids(START), [1, 2]);
  assert.equal(view.pending, false);
  assert.equal(view.messages.at(-1), 'snapshot-installed');
  assert.equal(view.timerCount, 0);
});

test('non-sales legacy change handlers retain repeat delivery without inferred readiness', async () => {
  const view = lifecycleHarness({ native: false, sales: false });
  for (const name of ['first.json', 'second.json']) {
    const delivery = view.install(name);
    await view.advance(750);
    await delivery;
    assert.equal(view.pending, false);
    assert.equal(view.timerCount, 0);
  }
  assert.deepEqual(view.delivered, [['first.json'], ['second.json']]);
  assert.deepEqual(view.ids(START), [1, 2]);
  assert.deepEqual(view.ids(READY), []);
  assert.deepEqual(view.messages, ['snapshot-installed', 'snapshot-installed']);
});

test('native legacy processing blocks overlapping delivery and permits a new restore after settlement', async () => {
  const view = lifecycleHarness();
  const first = view.install('first.json');
  await flushMicrotasks();
  await view.install('overlapping.json');
  assert.deepEqual(view.delivered, [['first.json']]);
  assert.deepEqual(view.ids(START), [1]);
  assert.equal(view.pending, true);
  view.handlers[0].resolve();
  await first;
  assert.equal(view.pending, false);
  const next = view.install('next.json');
  await flushMicrotasks();
  assert.deepEqual(view.delivered, [['first.json'], ['next.json']]);
  assert.deepEqual(view.ids(START), [1, 2]);
  view.handlers[1].resolve();
  await next;
  assert.deepEqual(view.ids(READY), [], 'resolving the loader only acknowledges delivery');
  assert.deepEqual(view.messages, ['snapshot-installed', 'snapshot-installed']);
  assert.equal(view.timerCount, 0);
});

test('native timeout cannot relabel a still-running restore and late settlement sends no success', async () => {
  const view = lifecycleHarness();
  const first = view.install('slow.json');
  await flushMicrotasks();
  await view.advance(120000);
  await first;
  assert.equal(view.pending, true);
  assert.deepEqual(view.ids(ERROR), [1]);
  await view.install('overlapping.json');
  assert.deepEqual(view.ids(START), [1]);
  assert.deepEqual(view.delivered, [['slow.json']]);
  view.handlers[0].resolve();
  await flushMicrotasks();
  assert.equal(view.pending, false);
  assert.deepEqual(view.messages, ['SNAPSHOT_INSTALL_FAILED']);
  const next = view.install('recovery.json');
  await flushMicrotasks();
  assert.deepEqual(view.ids(START), [1, 2]);
  view.handlers[1].resolve();
  await next;
  assert.deepEqual(view.messages, ['SNAPSHOT_INSTALL_FAILED', 'snapshot-installed']);
  assert.deepEqual(view.ids(READY), []);
  assert.equal(view.timerCount, 0);
});

test('matching native failure is reported once and stale failures cannot fail the next restore', async () => {
  const view = lifecycleHarness();
  const failed = view.install('failed.json');
  await flushMicrotasks();
  view.dispatch(ERROR, 1);
  assert.equal(view.pending, true, 'the native handler still owns its processing lock');
  view.handlers[0].resolve();
  await failed;
  assert.deepEqual(view.ids(ERROR), [1], 'the adapter must not duplicate the dashboard error');
  assert.deepEqual(view.messages, ['SNAPSHOT_INSTALL_FAILED']);
  const next = view.install('next.json');
  await flushMicrotasks();
  view.dispatch(ERROR, 1);
  view.handlers[1].resolve();
  await next;
  assert.deepEqual(view.messages, ['SNAPSHOT_INSTALL_FAILED', 'snapshot-installed']);
  assert.equal(view.pending, false);
  assert.equal(view.timerCount, 0);
});
