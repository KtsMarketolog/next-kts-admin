/**
 * Native browser stream regression: only synthetic data, localhost, no upload API.
 * node --import tsx tests/manager-dashboard-json-compression.browser.integration.ts
 * Both Chromium and WebKit must be installed (PLAYWRIGHT_MODULE_PATH is optional).
 */
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const fixture = `
import { prepareSharedJsonUpload, MAX_SHARED_JSON_BYTES, MAX_SHARED_JSON_GZIP_BYTES } from '@/features/admin/manager-dashboard/sharedJsonUpload';
function check(value, message) { if (!value) throw new Error(message); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function deadline(promise, message, ms = 2000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function failure(promise, pattern) {
  try { await promise; } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(pattern.test(message), 'Unexpected rejection: ' + message);
    return message;
  }
  throw new Error('Expected upload preparation to fail');
}
async function successfulCompression() {
  const json = JSON.stringify({snapshot: true, app: 'компоновщик', orders: [{id: 'synthetic-only', text: 'данные '.repeat(2000)}]});
  const file = new File([json], 'synthetic.json');
  const nativeStream = file.stream.bind(file);
  let completedSource;
  Object.defineProperties(file, {
    text: {value() {throw new Error('Source text buffering is forbidden');}},
    arrayBuffer: {value() {throw new Error('Source arrayBuffer buffering is forbidden');}},
    stream: {value() {completedSource = nativeStream(); return completedSource;}},
  });
  const progress = [];
  const body = await prepareSharedJsonUpload(file, {timeoutMs: 1500, onProgress: percent => progress.push(percent)});
  check(body.type === 'application/gzip', 'Expected gzip blob');
  const restored = await new Response(body.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  check(restored === json, 'Native gzip round trip changed the source');
  check(completedSource && !completedSource.locked, 'Completed source reader must release its lock');
  check(progress.at(-1) === 100, 'Progress must reach 100');
  check(progress.every((value, index) => value >= 0 && value <= 100 && (!index || value > progress[index - 1])), 'Progress must be bounded and monotonic');
  return {rawBytes: file.size, gzipBytes: body.size};
}
function observedSource(mode) {
  let cancelled = 0;
  let chunks = 0;
  let notifyCancelled;
  let notifyPulled;
  let notifyStarted;
  const cancellation = new Promise(resolve => {notifyCancelled = resolve;});
  const pulled = new Promise(resolve => {notifyPulled = resolve;});
  const started = new Promise(resolve => {notifyStarted = resolve;});
  const stream = new ReadableStream({
    async pull(controller) {
      notifyPulled();
      if (mode === 'stalled') return new Promise(() => {});
      // Real native compression of incompressible synthetic chunks. Yield between
      // reads so an erroneous cancellation cannot allocate 500 MiB in this test.
      await delay(1);
      if (cancelled) return;
      if (chunks >= 128) throw new Error('Cancellation failed: source read over 8 MiB');
      const bytes = crypto.getRandomValues(new Uint8Array(64 * 1024));
      chunks++;
      controller.enqueue(bytes);
      notifyStarted();
    },
    cancel() {cancelled++; notifyCancelled();},
  });
  return {
    file: {name: 'synthetic.json', size: MAX_SHARED_JSON_BYTES, stream() {return stream;}},
    pulled,
    started,
    async cancelledResult() {
      await deadline(cancellation, 'Source cancel() was not called within 2 seconds');
      await delay(25);
      const stoppedAt = chunks;
      await delay(50);
      check(chunks === stoppedAt, 'Source kept reading after cancellation');
      check(cancelled === 1, 'Source must be cancelled exactly once');
      check(!stream.locked, 'Cancelled source reader must release its lock');
      return {cancelCalls: cancelled, chunksRead: chunks};
    },
  };
}
globalThis.compressionFixture = {
  async run(name) {
    check(typeof CompressionStream === 'function' && typeof DecompressionStream === 'function', 'Native compression APIs are required');
    if (name === 'success') {
      check(MAX_SHARED_JSON_BYTES === 500 * 1024 * 1024, 'Production raw cap changed');
      check(MAX_SHARED_JSON_GZIP_BYTES === 501 * 1024 * 1024, 'Production gzip cap changed');
      return successfulCompression();
    }
    const source = observedSource(name === 'timeout' ? 'stalled' : 'flowing');
    let message;
    if (name === 'oversized') {
      check(MAX_SHARED_JSON_GZIP_BYTES === 1024, 'Test-only gzip cap was not injected');
      // Verify cancellation even if a browser's Response.blob() replaces the
      // originating guard error with an unhelpful generic network error.
      message = await failure(prepareSharedJsonUpload(source.file, {timeoutMs: 1500}), /./);
    } else if (name === 'abort') {
      const controller = new AbortController();
      const pending = prepareSharedJsonUpload(source.file, {signal: controller.signal, timeoutMs: 1500});
      const rejected = failure(pending, /Подготовка JSON прервана.*Файл не отправлен/);
      await deadline(source.started, 'Active source never yielded a chunk');
      await delay(20);
      controller.abort();
      message = await rejected;
    } else if (name === 'timeout') {
      message = await failure(prepareSharedJsonUpload(source.file, {timeoutMs: 30}), /Подготовка JSON.*слишком много времени.*Файл не отправлен/);
    } else throw new Error('Unknown case: ' + name);
    const cancelled = await source.cancelledResult();
    if (name === 'abort') check(cancelled.chunksRead > 0, 'Abort must interrupt active native compression, not an empty stream');
    if (name === 'oversized') check(/После сжатия JSON превышает.*Файл не отправлен/.test(message), 'Overflow reason was lost: ' + JSON.stringify({message, ...cancelled}));
    // A rejected preparation must not poison the next operation in this tab.
    await successfulCompression();
    return {message, ...cancelled};
  },
};
`;

async function main() {
  const root = path.resolve('.');
  const require = createRequire(path.join(root, 'package.json'));
  let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!modulePath) {
    try { modulePath = path.dirname(require.resolve('playwright/package.json')); }
    catch { modulePath = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const bundles = new Map<string, Uint8Array>();
  for (const variant of ['normal', 'bounded']) {
    const result = await build({
      absWorkingDir: root, stdin: {contents: fixture, resolveDir: root, loader: 'js'},
      bundle: true, write: false, platform: 'browser', format: 'iife',
      alias: {'@': path.join(root, 'src')},
      plugins: variant === 'normal' ? [] : [{name: 'test-only-compressed-cap', setup(plugin) {
        // Keep the actual production pipeline and native browser gzip intact.
        // Lower only its imported output cap to exercise rejection without a
        // half-gigabyte fixture or fake CompressionStream implementation.
        plugin.onLoad({filter: /\/supportSharedRoutePlannerLimits\.ts$/}, () => ({
          contents: 'export const SUPPORT_SHARED_JSON_MAX_BYTES = 500 * 1024 * 1024; export const SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES = 1024;', loader: 'js',
        }));
      }}],
    });
    bundles.set(variant, result.outputFiles[0].contents);
  }
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const variant = url.searchParams.get('variant') === 'bounded' ? 'bounded' : 'normal';
    if (request.method !== 'GET') return void response.writeHead(405).end();
    if (url.pathname === '/') response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'}).end(`<!doctype html><meta charset="utf-8"><script src="/fixture.js?variant=${variant}"></script>`);
    else if (url.pathname === '/fixture.js') response.writeHead(200, {'Content-Type': 'text/javascript', 'Cache-Control': 'no-store'}).end(bundles.get(variant));
    else response.writeHead(404).end();
  });
  const failures: string[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {server.off('error', reject); resolve();});
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engineName of ['chromium', 'webkit']) {
      const engine = playwright[engineName];
      await access(engine.executablePath());
      const browser = await engine.launch({headless: true});
      try {
        for (const scenario of ['success', 'oversized', 'abort', 'timeout']) {
          const context = await browser.newContext();
          const unexpected: string[] = [];
          const errors: string[] = [];
          await context.route('**/*', async (route: {request(): {url(): string}; continue(): Promise<void>; abort(): Promise<void>}) => {
            const url = new URL(route.request().url());
            if (url.origin === origin && ['/', '/fixture.js', '/favicon.ico'].includes(url.pathname)) await route.continue();
            else {unexpected.push(url.href); await route.abort();}
          });
          try {
            const page = await context.newPage();
            page.on('pageerror', (error: Error) => errors.push(error.message));
            await page.goto(`${origin}/?variant=${scenario === 'oversized' ? 'bounded' : 'normal'}`);
            const result = await page.evaluate((name: string) => (globalThis as unknown as {
              compressionFixture: {run(value: string): Promise<unknown>};
            }).compressionFixture.run(name), scenario);
            assert.deepEqual(errors, [], 'No unhandled browser errors');
            assert.deepEqual(unexpected, [], 'No upload or external network request');
            console.log(JSON.stringify({engine: engineName, scenario, result}));
          } catch (error) {
            const detail = `${engineName}/${scenario}: ${error instanceof Error ? error.message : String(error)}`;
            failures.push(detail);
            console.error(detail);
          } finally { await context.close(); }
        }
      } finally { await browser.close(); }
    }
    assert.ok(requests.every(request => request.startsWith('GET ')), 'Preparation must not upload any file');
    assert.deepEqual(failures, [], 'Native browser compression regression failures');
    console.log('PASS: native gzip success, oversized cancellation, explicit abort and stalled timeout in Chromium and WebKit.');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

main().catch(error => {console.error(error); process.exitCode = 1;});
