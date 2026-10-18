import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

type PerformanceModule = typeof import('../src/shared/lib/pricePerformance');
type Log = {
  event: string; operation: string; status: string; wallMs: number; cpuScope: string;
  stages: Array<{ stage: string; wallMs: number; processCpuMs: number }>;
};

function harness(allSamples = false) {
  let wall = 100;
  let user = 1000;
  let system = 500;
  const messages: string[] = [];
  const output = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../src/shared/lib/pricePerformance.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, {
    module: output, exports: output.exports,
    require: (name: string) => {
      assert.equal(name, 'node:perf_hooks');
      return { performance: { now: () => wall } };
    },
    process: {
      env: { PRICE_PERFORMANCE_LOG: allSamples ? '1' : undefined },
      cpuUsage: (previous?: { user: number; system: number }) => ({ user: user - (previous?.user ?? 0), system: system - (previous?.system ?? 0) }),
    },
    console: { info: (line: string) => messages.push(line) },
  });
  return { ...(output.exports as PerformanceModule), messages,
    logs: () => messages.map((message) => JSON.parse(message) as Log),
    advance: (ms: number, cpuUser = 0, cpuSystem = 0) => { wall += ms; user += cpuUser; system += cpuSystem; },
  };
}

test('stage timings preserve async and synchronous results and emit finite numeric Server-Timing durations', async () => {
  const h = harness(true);
  const trace = h.createPricePerformanceTrace('request');
  const result = { privateToken: 'sensitive-source-token', prices: [123.45] };
  assert.equal(await trace.measure('items', async () => { h.advance(12.345, 5000, 2000); return result; }), result);
  assert.equal(trace.measureSync('pricing', () => { h.advance(3.25, 1000, 500); return 7; }), 7);
  assert.equal(trace.header(), 'items;dur=12.3, pricing;dur=3.3');
  trace.finish(200);
  const log = h.logs()[0];
  assert.equal(log.event, 'public_price_performance');
  assert.equal(log.operation, 'request');
  assert.equal(log.status, '200');
  assert.equal(log.wallMs, 15.6);
  assert.deepEqual(log.stages, [
    { stage: 'items', wallMs: 12.3, processCpuMs: 7 },
    { stage: 'pricing', wallMs: 3.3, processCpuMs: 1.5 },
  ]);
  assert.equal(log.cpuScope, 'process_interval_includes_concurrent_work');
  assert.doesNotMatch(h.messages[0], /privateToken|sensitive-source-token|prices|123\.45/);
});

test('failed async and sync stages record elapsed time in finally without logging thrown contents', async () => {
  const h = harness(true);
  const trace = h.createPricePerformanceTrace('pdf');
  const error = new Error('PRIVATE token/client/mail/financial details');
  await assert.rejects(trace.measure('load', async () => { h.advance(15, 1000, 1000); throw error; }), (caught) => caught === error);
  assert.throws(() => trace.measureSync('render', () => { h.advance(20, 7000, 3000); throw error; }), (caught) => caught === error);
  assert.equal(trace.header(), 'load;dur=15.0, render;dur=20.0');
  trace.finish(500);
  assert.deepEqual(h.logs()[0].stages, [
    { stage: 'load', wallMs: 15, processCpuMs: 2 },
    { stage: 'render', wallMs: 20, processCpuMs: 10 },
  ]);
  assert.doesNotMatch(h.messages[0], /PRIVATE|token|client|mail|financial|details/);
});

test('fast operations are quiet by default; threshold and explicit sampling produce one summary only', () => {
  const h = harness();
  const fast = h.createPricePerformanceTrace('page');
  h.advance(249.9);
  fast.finish(200);
  assert.equal(h.messages.length, 0);
  const slow = h.createPricePerformanceTrace('page');
  h.advance(250);
  slow.finish('ok');
  slow.finish('retry');
  assert.equal(h.messages.length, 1);
  assert.equal(h.logs()[0].wallMs, 250);
  assert.equal(h.logs()[0].status, 'ok');
  assert.deepEqual(Object.keys(h.logs()[0]).sort(), ['cpuScope', 'event', 'operation', 'stages', 'status', 'wallMs']);
  const sampled = harness(true);
  sampled.createPricePerformanceTrace('page').finish(200);
  assert.equal(sampled.messages.length, 1);
});

test('timing identifiers are bounded and cannot inject additional HTTP headers', () => {
  const h = harness(true);
  const trace = h.createPricePerformanceTrace('export\r\nInjected: yes');
  trace.measureSync('items\r\nInjected: yes;' + 'a'.repeat(100), () => { h.advance(2); });
  trace.finish('200\r\nSet-Cookie: secret');
  assert.doesNotMatch(trace.header(), /[\r\n]/);
  assert.match(trace.header(), /^[a-zA-Z0-9_-]{1,48};dur=\d+\.\d$/);
  assert.ok(h.logs()[0].operation.length <= 48);
  assert.ok(h.logs()[0].status.length <= 48);
  assert.match(h.logs()[0].operation, /^[a-zA-Z0-9_-]+$/);
  assert.match(h.logs()[0].status, /^[a-zA-Z0-9_-]+$/);
});
