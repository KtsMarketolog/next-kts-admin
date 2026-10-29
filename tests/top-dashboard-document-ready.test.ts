import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { getTopDashboardDataAdapterScript } from '../src/shared/lib/topDashboardContentSecurity/adapterScript';
import { TOP_DASHBOARD_DATA_MESSAGE_MARKER as MARKER, TOP_DASHBOARD_MULTI_FILE_MESSAGE_MARKER as MULTI } from '../src/shared/lib/topDashboardContentSecurity/protocol';

type Listener = (event: { source?: object; data?: Record<string, unknown> }) => void;

function readinessHarness(state: DocumentReadyState, localInvoiceMode = false) {
  const script = getTopDashboardDataAdapterScript('multi-file-v1', 'generic');
  const start = script.lastIndexOf("  window.addEventListener('message', (event) => {");
  const end = script.lastIndexOf('\n})();');
  const declarations = script.match(/  let documentReady = [^\n]+\n  let documentReadyTimer = [^\n]+/u)?.[0];
  assert.ok(start > 0 && end > start && declarations);
  const windowListeners = new Map<string, Set<Listener>>();
  const documentListeners = new Map<string, Set<Listener>>();
  const timers = new Map<number, () => void>();
  const parent = {};
  let timerId = 0;
  const sent: string[] = [];
  const deliveries: string[] = [];
  let targetReports = 0;
  const events = (listeners: Map<string, Set<Listener>>) => ({
    addEventListener(type: string, listener: Listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: Listener) { listeners.get(type)?.delete(listener); },
  });
  const document = { readyState: state, ...events(documentListeners) };
  const window = {
    parent, ...events(windowListeners),
    setTimeout(callback: () => void, delay: number) {
      assert.equal(delay, 0);
      timers.set(++timerId, callback);
      return timerId;
    },
  };
  runInNewContext(`${declarations}\n${script.slice(start, end)}`, {
    document, window, MARKER, MULTI_FILE_MARKER: MULTI,
    LOCAL_INVOICE_MODE: localInvoiceMode, MULTI_FILE_MODE: true,
    EXPECTED_FORMAT: 'multi-file-v1', EXPECTED_PROFILE: 'generic',
    send(type: string) { sent.push(type); },
    report(code: string) { sent.push(code); },
    reportUploadTargets() { targetReports++; },
    installMultiFileSnapshot() { deliveries.push('multi-file'); },
    installSnapshot() { deliveries.push('snapshot'); },
    validName: () => true, validBuffer: () => true,
  });
  const dispatch = (listeners: Map<string, Set<Listener>>, type: string, event = {}) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };
  return {
    document, sent, deliveries,
    get targetReports() { return targetReports; },
    get timerCount() { return timers.size; },
    message(type: string, marker = MARKER, source = parent) {
      dispatch(windowListeners, 'message', { source, data: { marker, type, name:'snapshot.json', buffer:new ArrayBuffer(1), targets:[], restoreId:1 } });
    },
    domContentLoaded() { dispatch(documentListeners, 'DOMContentLoaded'); },
    load() { dispatch(windowListeners, 'load'); },
    flushTask() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test('head adapter ignores early probes and deliveries until later DOMContentLoaded handlers finish', () => {
  const view = readinessHarness('loading');
  for (let attempt = 0; attempt < 4; attempt++) {
    view.message('bridge-probe');
    view.message('probe-upload-targets', MULTI);
    view.message('restore-files', MULTI);
    view.message('snapshot-data');
  }
  assert.deepEqual(view.sent, []);
  assert.deepEqual(view.deliveries, []);
  assert.equal(view.targetReports, 0);
  assert.equal(view.timerCount, 0);

  view.document.readyState = 'interactive';
  view.message('bridge-probe');
  assert.deepEqual(view.sent, [], 'interactive can still precede deferred scripts');
  let authorBound = false;
  view.document.addEventListener('DOMContentLoaded', () => { authorBound = true; });
  view.domContentLoaded();
  assert.equal(authorBound, true);
  assert.equal(view.timerCount, 1);
  view.message('restore-files', MULTI);
  view.message('snapshot-data');
  assert.deepEqual(view.sent, []);
  assert.deepEqual(view.deliveries, [], 'readiness changes only in the following task');
  view.load();
  assert.equal(view.timerCount, 1, 'load does not schedule a second readiness task');
  view.flushTask();
  assert.deepEqual(view.sent, ['adapter-ready']);
  assert.equal(view.targetReports, 1);
  assert.deepEqual(view.deliveries, [], 'unsolicited early payloads are not queued');
  view.message('restore-files', MULTI);
  view.message('snapshot-data');
  assert.deepEqual(view.deliveries, ['multi-file', 'snapshot']);
  view.domContentLoaded();
  view.load();
  assert.equal(view.timerCount, 0);
});

test('adapter initialized during interactive waits for DOMContentLoaded or the load fallback', () => {
  for (const finish of ['domContentLoaded', 'load'] as const) {
    const view = readinessHarness('interactive');
    view.message('bridge-probe');
    assert.deepEqual(view.sent, []);
    view[finish]();
    assert.deepEqual(view.sent, []);
    view.flushTask();
    assert.deepEqual(view.sent, ['adapter-ready']);
  }
});

test('already complete documents can restore immediately; later probes do not redeliver data', () => {
  const view = readinessHarness('complete');
  assert.deepEqual(view.sent, ['adapter-ready']);
  view.message('restore-files', MULTI);
  view.message('bridge-probe');
  view.message('bridge-probe');
  assert.deepEqual(view.deliveries, ['multi-file']);
  assert.deepEqual(view.sent, ['adapter-ready', 'adapter-ready', 'adapter-ready']);
  assert.equal(view.timerCount, 0);
});

test('foreign frames cannot probe or deliver snapshots before or after document readiness', () => {
  const view = readinessHarness('loading');
  const foreignSource = {};
  for (const finish of [false, true]) {
    if (finish) { view.domContentLoaded(); view.flushTask(); }
    view.message('bridge-probe', MARKER, foreignSource);
    view.message('restore-files', MULTI, foreignSource);
    view.message('snapshot-data', MARKER, foreignSource);
  }
  assert.deepEqual(view.sent, ['adapter-ready']);
  assert.deepEqual(view.deliveries, []);
});

test('private invoice mode never announces or accepts a shared snapshot', () => {
  for (const state of ['loading', 'complete'] as const) {
    const view = readinessHarness(state, true);
    view.domContentLoaded(); view.flushTask();
    view.message('bridge-probe');
    view.message('restore-files', MULTI);
    view.message('snapshot-data');
    assert.deepEqual(view.sent, []);
    assert.deepEqual(view.deliveries, []);
    assert.equal(view.targetReports, 0);
  }
});
