import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as schedulerHelpers from '../src/shared/lib/currencyDashboardScheduler';
import * as deviceHelpers from '../src/shared/lib/currencyDashboardDeviceState';
import * as rpcHelpers from '../src/shared/lib/currencyDashboardRpc';
import { createCurrencyDashboardScheduler, createCurrencySchedulerWorker } from '../src/shared/lib/currencyDashboardScheduler';

type FakeWorker = Pick<Worker, 'onmessage' | 'onerror' | 'terminate'> & { stopped: number; released: number };
function workerFixture(): FakeWorker {
  return { onmessage: null, onerror: null, stopped: 0, released: 0, terminate() { this.stopped++; } };
}
function message(worker: FakeWorker, data: unknown = 'tick') { worker.onmessage?.call(worker as unknown as Worker, { data } as MessageEvent); }
function failure(worker: FakeWorker) { worker.onerror?.call(worker as unknown as Worker, { preventDefault() {} } as ErrorEvent); }
function fixture() {
  const workers: FakeWorker[] = [], intervals = new Map<number, () => void>();
  let ticks = 0, nextTimer = 0, factoryFails = false;
  const scheduler = createCurrencyDashboardScheduler({
    createWorker: () => {
      if (factoryFails) throw new Error('Worker unavailable');
      const worker = workerFixture(); workers.push(worker);
      return { worker, release: () => { worker.released++; } };
    },
    setInterval: (callback, milliseconds) => { assert.equal(milliseconds, 1000); intervals.set(++nextTimer, callback); return nextTimer; },
    clearInterval: (timer) => { intervals.delete(timer); },
    tick: () => { ticks++; },
  });
  return { scheduler, workers, intervals, get ticks() { return ticks; }, failFactory() { factoryFails = true; }, allowFactory() { factoryFails = false; } };
}

test('scheduler starts one fixed worker, accepts only ticks and releases resources once', () => {
  const f = fixture();
  f.scheduler.tick(); assert.equal(f.ticks, 0);
  f.scheduler.start(); f.scheduler.start();
  assert.equal(f.workers.length, 1); assert.equal(f.intervals.size, 0);
  message(f.workers[0], 'not-a-tick'); message(f.workers[0]); f.scheduler.tick();
  assert.equal(f.ticks, 2);
  const late = f.workers[0].onmessage;
  f.scheduler.stop(); f.scheduler.stop();
  late?.call(f.workers[0] as unknown as Worker, { data: 'tick' } as MessageEvent);
  f.scheduler.tick();
  assert.equal(f.ticks, 2); assert.equal(f.workers[0].stopped, 1); assert.equal(f.workers[0].released, 1);
});

test('constructor failure uses one interval, cleans it and rejects queued ticks after stop', () => {
  const f = fixture(); f.failFactory(); f.scheduler.start(); f.scheduler.start();
  assert.equal(f.workers.length, 0); assert.equal(f.intervals.size, 1);
  const interval = [...f.intervals.values()][0]; interval(); assert.equal(f.ticks, 1);
  f.scheduler.stop(); assert.equal(f.intervals.size, 0);
  interval(); assert.equal(f.ticks, 1);
  f.allowFactory(); f.scheduler.start(); assert.equal(f.workers.length, 1);
  message(f.workers[0]); assert.equal(f.ticks, 2); f.scheduler.stop();
});

test('asynchronous worker failure terminates it and falls back once; restart ignores old generation', () => {
  const f = fixture(); f.scheduler.start();
  const old = f.workers[0], lateMessage = old.onmessage, lateError = old.onerror;
  failure(old); failure(old);
  assert.equal(old.stopped, 1); assert.equal(old.released, 1); assert.equal(f.intervals.size, 1);
  [...f.intervals.values()][0](); assert.equal(f.ticks, 1);
  f.scheduler.stop(); f.scheduler.start(); assert.equal(f.workers.length, 2);
  lateMessage?.call(old as unknown as Worker, { data: 'tick' } as MessageEvent);
  lateError?.call(old as unknown as Worker, { preventDefault() {} } as ErrorEvent);
  assert.equal(f.intervals.size, 0); assert.equal(f.ticks, 1);
  message(f.workers[1]); assert.equal(f.ticks, 2); f.scheduler.stop();
});

test('worker factory uses only the fixed program and revokes URLs on construction failure and cleanup', async () => {
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const createObjectURL = URL.createObjectURL, revokeObjectURL = URL.revokeObjectURL;
  const blobs: Blob[] = [], revoked: string[] = [], locations: string[] = [];
  let fail = false;
  try {
    URL.createObjectURL = (blob) => { blobs.push(blob as Blob); return `blob:fixed-${blobs.length}`; };
    URL.revokeObjectURL = (url) => { revoked.push(url); };
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: class {
      constructor(url: string) { locations.push(url); if (fail) throw new Error('blocked'); return workerFixture(); }
    } });
    const resource = createCurrencySchedulerWorker();
    assert.equal(await blobs[0].text(), 'setInterval(() => postMessage("tick"), 1000);');
    assert.equal(blobs[0].type, 'text/javascript');
    resource.worker.terminate(); resource.release();
    fail = true; assert.throws(() => createCurrencySchedulerWorker(), /blocked/);
    assert.deepEqual(locations, ['blob:fixed-1', 'blob:fixed-2']);
    assert.deepEqual(revoked, locations);
  } finally {
    URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL;
    if (previousWorker) Object.defineProperty(globalThis, 'Worker', previousWorker); else Reflect.deleteProperty(globalThis, 'Worker');
  }
});

function hostHarness() {
  const workers: FakeWorker[] = [], messages: Record<string, unknown>[] = [];
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const docListeners = new Map<string, () => void>();
  const frameListeners = new Map<string, () => void>();
  const frameWindow = { postMessage: (value: Record<string, unknown>) => { messages.push(value); } };
  const iframe = { contentWindow: frameWindow, addEventListener: (name: string, callback: () => void) => frameListeners.set(name, callback), removeEventListener: (name: string) => frameListeners.delete(name) };
  const doc = { hidden: false, addEventListener: (name: string, callback: () => void) => docListeners.set(name, callback), removeEventListener: (name: string) => docListeners.delete(name) };
  let refs = 0, cleanup: (() => void) | undefined;
  const requests: { resolve: (value: { ok: boolean; json: () => Promise<unknown> }) => void; signal: AbortSignal }[] = [];
  const modules: Record<string, unknown> = {
    'next/link': {},
    'react': { useRef: () => ({ current: ++refs === 1 ? iframe : null }), useState: (value: unknown) => [value, () => {}], useEffect: (effect: () => () => void) => { cleanup = effect(); } },
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
    '@/shared/lib/currencyDashboardRpc': rpcHelpers,
    '@/shared/lib/currencyDashboardDeviceState': deviceHelpers,
    '@/shared/lib/currencyDashboardScheduler': { ...schedulerHelpers, createCurrencySchedulerWorker: () => {
      const worker = workerFixture(); workers.push(worker); return { worker, release: () => { worker.released++; } };
    } },
    '@/features/admin/dashboard-usage/useDashboardUsage': { useDashboardUsage() {} },
    '@/features/admin/dashboard-access/DashboardAudienceEditor': {},
    './CurrencyHtmlManagement': {},
    './currency-dashboard.module.scss': { default: {} },
  };
  const source = readFileSync('src/features/admin/currency-dashboard/CurrencyDashboard.tsx', 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: { CurrencyDashboard?: (props: object) => void } = {};
  runInNewContext(compiled, { exports, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; },
    window: { isSecureContext: false, addEventListener: (name: string, callback: (...args: unknown[]) => unknown) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name), setInterval, clearInterval },
    document: doc, AbortController, setTimeout, clearTimeout, TextEncoder,
    fetch: (_url: string, init: { signal: AbortSignal }) => new Promise((resolve) => { requests.push({ resolve, signal: init.signal }); }),
  });
  exports.CurrencyDashboard!({ nonce: 'scheduler-nonce', deviceScope: 'user:7', canManage: false });
  const send = (id: string, method = 'schedule:start', params: unknown = {}, overrides = {}) => listeners.get('message')!({ source: frameWindow, origin: 'null', data: { channel: 'kts-currency-v1', nonce: 'scheduler-nonce', id, method, params }, ...overrides });
  return { workers, messages, listeners, docListeners, frameListeners, doc, send, requests, cleanup: () => cleanup?.() };
}

test('host handshake is scoped to this frame and restarts only after authorized load/pageshow', async () => {
  const h = hostHarness();
  try {
    await h.send('forged', 'schedule:start', {}, { origin: 'https://example.com' });
    await h.send('forged', 'schedule:start', {}, { source: {} });
    await h.send('forged', 'schedule:start', {}, { data: { channel: 'kts-currency-v1', nonce: 'wrong', id: 'forged', method: 'schedule:start', params: {} } });
    assert.equal(h.messages.length, 0); assert.equal(h.workers.length, 0);
    for (const params of [{ url: 'https://evil.test' }, { code: 'fetch()' }, { interval: 1 }, [], null]) await h.send(`bad-${h.messages.length}`, 'schedule:start', params);
    assert.equal(h.workers.length, 0); assert.ok(h.messages.every((entry) => entry.error));
    h.messages.length = 0;
    await h.send('1'); await h.send('2');
    assert.equal(h.workers.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages[0])), { channel: 'kts-currency-v1', nonce: 'scheduler-nonce', id: '1', result: { started: true } });
    message(h.workers[0]);
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages.at(-1))), { channel: 'kts-currency-v1', nonce: 'scheduler-nonce', event: 'schedule:tick' });
    h.listeners.get('pagehide')!(); assert.equal(h.workers[0].stopped, 1);
    h.listeners.get('pageshow')!(); assert.equal(h.workers.length, 2);
    const before = h.messages.length; h.doc.hidden = true; h.docListeners.get('visibilitychange')!(); assert.equal(h.messages.length, before);
    h.doc.hidden = false; h.docListeners.get('visibilitychange')!(); assert.equal(h.messages.length, before + 1);
    h.frameListeners.get('load')!(); assert.equal(h.workers[1].stopped, 1);
    h.listeners.get('pageshow')!(); assert.equal(h.workers.length, 2, 'new frame has not handshaken');
    await h.send('1'); assert.equal(h.workers.length, 3, 'request ids are reusable after frame reload');
  } finally { h.cleanup(); }
  assert.equal(h.workers.at(-1)?.stopped, 1); assert.equal(h.listeners.size, 0); assert.equal(h.frameListeners.size, 0); assert.equal(h.docListeners.size, 0);
});

test('late RPC completion after frame reload cannot reply or clear a new request with the same id', async () => {
  const h = hostHarness();
  try {
    const oldRequest = h.send('1', 'snapshot:get'); assert.equal(h.requests.length, 1);
    h.frameListeners.get('load')!(); assert.equal(h.requests[0].signal.aborted, true);
    const newRequest = h.send('1', 'snapshot:get'); assert.equal(h.requests.length, 2);
    h.requests[0].resolve({ ok: true, json: async () => ({ revision: 1 }) }); await oldRequest;
    assert.equal(h.messages.length, 0);
    await h.send('1'); assert.equal(h.workers.length, 0, 'new in-flight id is still reserved');
    h.requests[1].resolve({ ok: true, json: async () => ({ revision: 2 }) }); await newRequest;
    assert.deepEqual(JSON.parse(JSON.stringify(h.messages[0].result)), { revision: 2 });
    assert.equal(h.messages.length, 1);
  } finally { h.cleanup(); }
});
