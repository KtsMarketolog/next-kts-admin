/** Actual fixed Worker smoke test under host CSP; no application API or production data. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

type ClockWindow = Window & { clockFixture: { stats: { ticks: number; workers: number; fallbacks: number }; start(): void; stop(): void } };

async function main() {
  const modulePath = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const source = await readFile('src/shared/lib/currencyDashboardScheduler.ts', 'utf8');
  const helper = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const config = await readFile('next.config.ts', 'utf8');
  const workerPolicy = config.match(/"(worker-src [^"]+)"/)?.[1];
  assert.equal(workerPolicy, "worker-src 'self' blob:", 'Fixture must match the actual host Worker permission');
  const script = `import {createCurrencyDashboardScheduler,createCurrencySchedulerWorker} from '/scheduler.js';
    const stats={ticks:0,workers:0,fallbacks:0};
    const scheduler=createCurrencyDashboardScheduler({
      createWorker:()=>{stats.workers++;return createCurrencySchedulerWorker();},
      setInterval:(callback,ms)=>{stats.fallbacks++;return window.setInterval(callback,ms);},
      clearInterval:id=>window.clearInterval(id),tick:()=>stats.ticks++
    });
    window.clockFixture={stats,start:()=>scheduler.start(),stop:()=>scheduler.stop()};
    scheduler.start();scheduler.start();`;
  const hash = createHash('sha256').update(script).digest('base64');
  const policy = `default-src 'none'; script-src 'self' 'sha256-${hash}'; ${workerPolicy}`;
  const server = createServer((request, response) => {
    if (request.url === '/scheduler.js') response.writeHead(200, { 'Content-Type': 'text/javascript', 'Content-Security-Policy': policy }).end(helper);
    else response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': policy }).end(`<!doctype html><script type="module">${script}</script>`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  let engines = 0;
  try {
    for (const name of ['chromium', 'webkit']) {
      try { await access(playwright[name].executablePath()); } catch { console.log(`SKIP ${name}: executable unavailable`); continue; }
      engines++;
      const browser = await playwright[name].launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${address.port}`);
        await page.waitForFunction(() => (window as unknown as ClockWindow).clockFixture?.stats.ticks >= 2);
        assert.deepEqual(await page.evaluate(() => { const { workers, fallbacks } = (window as unknown as ClockWindow).clockFixture.stats; return { workers, fallbacks }; }), { workers: 1, fallbacks: 0 });
        const stoppedAt = await page.evaluate(() => { (window as unknown as ClockWindow).clockFixture.stop(); return (window as unknown as ClockWindow).clockFixture.stats.ticks; });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        assert.equal(await page.evaluate(() => (window as unknown as ClockWindow).clockFixture.stats.ticks), stoppedAt, 'Terminated Worker cannot keep ticking');
        await page.evaluate(() => { (window as unknown as ClockWindow).clockFixture.start(); (window as unknown as ClockWindow).clockFixture.start(); });
        await page.waitForFunction((previous: number) => (window as unknown as { clockFixture: { stats: { ticks: number } } }).clockFixture.stats.ticks > previous, stoppedAt);
        assert.deepEqual(await page.evaluate(() => { const { workers, fallbacks } = (window as unknown as ClockWindow).clockFixture.stats; return { workers, fallbacks }; }), { workers: 2, fallbacks: 0 });
        await page.evaluate(() => (window as unknown as ClockWindow).clockFixture.stop());
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ engine: name, worker: 'pass', ticks: 'native, no mocked clock', cleanup: 'stop and restart', fallbackUsed: false }));
      } finally { await browser.close(); }
    }
    assert.equal(engines, 2, 'Both Chromium and WebKit must run for release acceptance');
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
