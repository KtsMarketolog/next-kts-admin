/** Local-only acceptance of the real instruction component and PDF stream. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'sass';
import { dashboardInstructionDownload } from '../src/shared/lib/dashboardInstructionDownload';
import { resolveDashboardInstruction, type DashboardInstructionKind } from '../src/shared/lib/dashboardInstructions';

async function main() {
  const root = path.resolve('.');
  const playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(playwrightPath, 'index.mjs')).href);
  const screenshots = await mkdtemp(path.join(tmpdir(), 'kts-instructions-ui-'));
  let css = '';
  const bundle = await build({
    absWorkingDir: root, stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {DashboardInstructions} from './src/features/admin/dashboard-instructions/DashboardInstructions';
      createRoot(document.getElementById('root')).render(<main>
        <section><h2>Дашборды МР</h2><DashboardInstructions dashboardKey="manager:development" kind="personal-sales" /></section>
        <section><h2>Дашборды МС</h2><DashboardInstructions dashboardKey="manager:support" kind="personal-sales" /></section>
        <section><h2>Аналитика продаж</h2><DashboardInstructions dashboardKey="top:4" kind="sales-analytics" /></section>
      </main>);
    ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' }, alias: { '@': path.join(root, 'src') },
    plugins: [{ name: 'styles', setup(plugin) {
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        css += compile(args.path).css;
        const names = [...new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]))];
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, name])))}`, loader: 'js' };
      });
    } }],
  });
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script></html>');
      else if (url.pathname === '/app.js') res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
      else if (url.pathname === '/style.css') res.writeHead(200, { 'Content-Type': 'text/css' }).end('body{margin:0;background:#f5f5f9;font:16px Arial}*{box-sizing:border-box}main{padding:16px}section{padding:16px;border:1px solid #ddd;border-radius:8px;background:white;margin-bottom:16px}h2{font-size:18px}' + css);
      else if (url.pathname.startsWith('/api/admin/dashboard-instructions/')) {
        const kind = url.pathname.split('/').at(-1)!;
        if (!resolveDashboardInstruction(kind, url.searchParams.get('dashboardKey') ?? '')) { res.writeHead(404).end(); return; }
        // Auth/roles are exercised separately in route tests; this fixture never loads a real session/DB.
        const response = await dashboardInstructionDownload(new Request(url, { method: req.method }), kind as DashboardInstructionKind, url.searchParams.get('download') === '1');
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) {
          const reader = response.body.getReader();
          try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; res.write(chunk.value); } }
          finally { reader.releaseLock(); }
        }
        res.end();
      } else res.writeHead(404).end();
    })().catch((error) => { console.error(error); res.destroy(); });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engineName of ['chromium', 'webkit']) {
      const browser = await playwright[engineName].launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, acceptDownloads: true });
        await context.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
        const page = await context.newPage(); const errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.goto(origin);
        const groups = page.getByRole('group'); await groups.nth(2).waitFor();
        assert.equal(await groups.count(), 3);
        for (const [index, key] of ['manager:development', 'manager:support', 'top:4'].entries()) {
          const open = groups.nth(index).getByRole('link', { name: /Открыть/ });
          assert.equal(await open.getAttribute('target'), '_blank');
          assert.match(await open.getAttribute('rel'), /noopener/);
          assert.equal(new URL(await open.getAttribute('href'), origin).searchParams.get('dashboardKey'), key);
          const [download] = await Promise.all([page.waitForEvent('download'), groups.nth(index).getByRole('link', { name: /Скачать/ }).click()]);
          assert.match(download.suggestedFilename().normalize('NFC'), index < 2 ? /Личный_дашборд_продаж_v34\.pdf$/ : /Аналитика_продаж_v94\.pdf$/);
          assert.equal(await download.failure(), null);
        }
        await page.screenshot({ path: path.join(screenshots, `${engineName}-desktop.png`), fullPage: true });
        await page.setViewportSize({ width: 360, height: 800 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(screenshots, `${engineName}-mobile.png`), fullPage: true });
        assert.deepEqual(errors, []);
        await context.close();
      } finally { await browser.close(); }
    }
    console.log(`Instruction links and downloads passed in Chromium/WebKit. Screenshots: ${screenshots}`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
