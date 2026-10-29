/** Local-only acceptance of instruction links, playback and seek with the original media. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
        <article><h2>Дашборды МР</h2><iframe title="Отчёт МР" src="/frame"/><DashboardInstructions dashboardKey="manager:development" kind="personal-sales" /></article>
        <article><h2>Дашборды МС</h2><iframe title="Отчёт МС" src="/frame"/><DashboardInstructions dashboardKey="manager:support" kind="personal-sales" /></article>
        <article><h2>Аналитика продаж</h2><iframe title="Отчёт аналитики продаж" src="/frame"/><DashboardInstructions dashboardKey="top:4" kind="sales-analytics" /></article>
        <article><h2>Рентабельность сделок</h2><iframe title="Отчёт рентабельности сделок" src="/frame"/><DashboardInstructions dashboardKey="top:10" kind="deal-profitability" /></article>
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
  const mediaRequests: Array<{ kind: string; range: string | undefined; format: string | null }> = [];
  const server = createServer((req, res) => {
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableFinished) controller.abort(); });
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script></html>');
      else if (url.pathname === '/app.js') res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
      else if (url.pathname === '/style.css') res.writeHead(200, { 'Content-Type': 'text/css' }).end('body{margin:0;background:#f5f5f9;font:16px Arial}*{box-sizing:border-box}main{padding:16px}article{margin-bottom:32px}iframe{display:block;width:100%;height:180px;border:1px solid #ddd;border-radius:8px;margin-bottom:20px;background:white}h2{font-size:18px}' + css);
      else if (url.pathname === '/frame') res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><style>body{font:16px Arial;color:#291080;padding:12px}h3{background:#151852;color:white;padding:14px}.cards{display:flex;gap:16px}.cards div{background:#f1effa;padding:18px;flex:1}</style><h3>КТС · ДАШБОРД</h3><div class="cards"><div>Продажи<br><b>12 450 000 ₽</b></div><div>Выполнение плана<br><b>94%</b></div></div>');
      else if (url.pathname.startsWith('/api/admin/dashboard-instructions/')) {
        const kind = url.pathname.split('/').at(-1)!;
        if (!resolveDashboardInstruction(kind, url.searchParams.get('dashboardKey') ?? '')) { res.writeHead(404).end(); return; }
        // Auth/roles are exercised separately in route tests; this fixture never loads a real session/DB.
        const headers = new Headers();
        if (req.headers.range) headers.set('range', req.headers.range);
        mediaRequests.push({ kind, range: req.headers.range, format: url.searchParams.get('format') });
        const response = await dashboardInstructionDownload(new Request(url, { method: req.method, headers, signal: controller.signal }), kind as DashboardInstructionKind, url.searchParams.get('download') === '1', url.searchParams.get('format') === 'video' ? 'video' : 'pdf');
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) {
          await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), res);
        }
        else res.end();
      } else res.writeHead(404).end();
    })().catch((error) => { if (!controller.signal.aborted) console.error(error); res.destroy(); });
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
        const initialRequests = mediaRequests.length;
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.goto(origin);
        const groups = page.getByRole('group'); await groups.nth(3).waitFor();
        assert.equal(await groups.count(), 4);
        assert.match(await groups.nth(3).innerText(), /Рентабельность сделок · материалы к версии v25/);
        assert.match(await groups.nth(3).innerText(), /PDF · 20 стр\./);
        assert.match(await groups.nth(3).innerText(), /ВИДЕО · 4:28/);
        assert.match(await groups.nth(3).innerText(), /Как загрузить счёт или КП, рассчитать рентабельность и подготовить лист согласования\./);
        assert.match(await groups.nth(2).innerText(), /Как читать показатели, пользоваться фильтрами и работать с отчётом\./);
        assert.equal(await page.locator('video').count(), 0, 'No video or media request before user action');
        assert.equal(mediaRequests.length, initialRequests);
        for (const [index, key] of ['manager:development', 'manager:support', 'top:4', 'top:10'].entries()) {
          const open = groups.nth(index).getByRole('link', { name: /Открыть/ });
          assert.equal(await open.getAttribute('target'), '_blank');
          assert.match(await open.getAttribute('rel'), /noopener/);
          assert.equal(new URL(await open.getAttribute('href'), origin).searchParams.get('dashboardKey'), key);
          const [download] = await Promise.all([page.waitForEvent('download'), groups.nth(index).getByRole('link', { name: /Скачать инструкцию/ }).click()]);
          assert.match(download.suggestedFilename().normalize('NFC'), index < 2 ? /Личный_дашборд_продаж_v34\.pdf$/
            : index === 2 ? /Аналитика_продаж_v94\.pdf$/ : /Рентабельность_сделок_V25_инструкция_для_менеджеров\.pdf$/);
          assert.equal(await download.failure(), null);
        }
        await page.screenshot({ path: path.join(screenshots, `${engineName}-desktop.png`), fullPage: true });
        for (const index of [0, 2, 3]) {
          const group = groups.nth(index);
          await group.getByRole('button', { name: 'Смотреть видео', exact: true }).click();
          const video = group.locator('video');
          await video.evaluate((element: HTMLVideoElement) => new Promise<void>((resolve, reject) => {
            if (element.readyState >= 1) return resolve();
            element.addEventListener('loadedmetadata', () => resolve(), { once: true });
            element.addEventListener('error', () => reject(Error(`Media error ${element.error?.code}: ${element.error?.message}`)), { once: true });
          }));
          const duration = await video.evaluate((element: HTMLVideoElement) => element.duration);
          assert.ok(Math.abs(duration - (index === 0 ? 207.296 : index === 2 ? 322.96 : 267.88)) < 0.5);
          assert.equal(await video.evaluate((element: HTMLVideoElement) => element.paused), true, 'No autoplay');
          await video.evaluate(async (element: HTMLVideoElement) => { element.muted = true; await element.play(); });
          await page.waitForFunction(() => { const v = document.querySelector('video')!; return v.currentTime > 0.15 && !v.paused; });
          await video.evaluate((element: HTMLVideoElement) => { element.pause(); element.currentTime = element.duration * 0.8; });
          await page.waitForFunction(() => { const v = document.querySelector('video')!; return !v.seeking && v.readyState >= 2 && v.currentTime > v.duration * 0.7; });
          const expectedKind = index === 0 ? 'personal-sales' : index === 2 ? 'sales-analytics' : 'deal-profitability';
          assert.ok(mediaRequests.slice(initialRequests).some((r) => r.kind === expectedKind && r.format === 'video' && r.range), 'Browser seeks each video with byte ranges');
          await group.screenshot({ path: path.join(screenshots, `${engineName}-${index}-video.png`) });
          await group.getByRole('button', { name: 'Закрыть видео', exact: true }).click();
          assert.equal(await page.locator('video').count(), 0, 'Close unmounts playback');
          const [download] = await Promise.all([page.waitForEvent('download'), group.getByRole('link', { name: /Скачать видеообзор/ }).click()]);
          assert.match(download.suggestedFilename().normalize('NFC'), index === 3 ? /Рентабельность_сделок_V25_видеообзор\.mp4$/ : /Видеообзор_КРАТКИЙ_.*\.mp4$/);
          assert.equal(await download.failure(), null);
        }
        await page.setViewportSize({ width: 360, height: 800 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(screenshots, `${engineName}-mobile.png`), fullPage: true });
        await groups.nth(3).screenshot({ path: path.join(screenshots, `${engineName}-profitability-mobile.png`) });
        assert.deepEqual(errors, []);
        await context.close();
      } finally { await browser.close(); }
    }
    console.log(`PDF/video downloads, actual playback, seek and lazy loading passed in Chromium/WebKit. Screenshots: ${screenshots}`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
