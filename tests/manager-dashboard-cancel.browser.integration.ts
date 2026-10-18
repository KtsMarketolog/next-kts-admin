/**
 * Isolated cancellation regression using the real parent + batch upload UI.
 * node --import tsx tests/manager-dashboard-cancel.browser.integration.ts
 * Synthetic files/API only, loopback server, external requests blocked.
 */
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

type BrowserRoute = { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> };

const fixtureEntry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ManagerDashboard } from './src/features/admin/manager-dashboard/ManagerDashboard';
createRoot(document.getElementById('root')).render(<ManagerDashboard mode="manage" audience="development"/>);
`;

async function eventually(check: () => boolean, message: string) {
  const deadline = Date.now() + 7000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(check(), message);
}

async function main() {
  const root = path.resolve('.');
  const require = createRequire(path.join(root, 'package.json'));
  let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!modulePath) {
    try { modulePath = path.dirname(require.resolve('playwright/package.json')); }
    catch { modulePath = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const bundle = await build({
    absWorkingDir: root, stdin: { contents: fixtureEntry, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' }, alias: { '@': path.join(root, 'src') },
    plugins: [{ name: 'isolated-browser-fixture', setup(plugin) {
      plugin.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: 'synthetic-next' }));
      plugin.onLoad({ filter: /.*/, namespace: 'synthetic-next' }, args => ({ contents: args.path === 'next/navigation'
        ? 'const router = {replace(path) {window.fixtureRedirect = path}}; export function useRouter() {return router}'
        : 'import React from "react"; export default function Link({children,...props}) {return React.createElement("a",props,children)}', loader: 'js', resolveDir: root }));
      // This test checks cancellation behavior, not the unrelated admin palette.
      plugin.onLoad({ filter: /\.module\.scss$/ }, () => ({ contents: 'export default new Proxy({}, {get: (_, key) => String(key)});', loader: 'js' }));
    } }],
  });

  const overview = { mode: 'manage', groups: [], imports: [], importsNextCursor: null };
  const held = new Set<ServerResponse>();
  let getCount = 0;
  let postCount = 0;
  let refreshWaiting = false;
  let refreshClosed = false;
  let uploadedBytes: number[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const headers = { 'Cache-Control': 'no-store' };
    if (url.pathname === '/') {
      response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    } else if (url.pathname === '/fixture.js') {
      response.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    } else if (url.pathname === '/api/admin/manager-dashboard' && request.method === 'GET') {
      getCount += 1;
      if (getCount === 2) {
        // The POST is already confirmed. Only its follow-up GET is stalled.
        refreshWaiting = true;
        held.add(response);
        response.once('close', () => { refreshClosed = true; held.delete(response); });
        response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).write('{"mode":');
      } else response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(overview));
    } else if (url.pathname === '/api/admin/manager-dashboard/snapshots' && request.method === 'POST') {
      postCount += 1;
      const index = postCount - 1;
      uploadedBytes[index] = 0;
      request.on('data', (chunk: Buffer) => { uploadedBytes[index] += chunk.length; });
      request.once('end', () => response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({
        message: 'Синтетические файлы сохранены',
        results: (index === 0 ? ['a.ktsp', 'b.ktsp'] : ['c.ktsp']).map(originalName => ({ originalName, status: 'imported' })),
      })));
    } else response.writeHead(404, headers).end();
  });

  let enginesTested = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engineName of ['chromium', 'webkit']) {
      const engine = playwright[engineName];
      try { await access(engine.executablePath()); }
      catch { console.log(`SKIP ${engineName}: browser executable is not installed.`); continue; }
      const browser = await engine.launch({ headless: true });
      enginesTested += 1;
      try {
        for (const cancelButton of ['Прервать ожидание', 'Прервать загрузку']) {
          getCount = 0; postCount = 0; refreshWaiting = false; refreshClosed = false; uploadedBytes = [];
          const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
          const external: string[] = [];
          const errors: string[] = [];
          await context.route('**/*', async (route: BrowserRoute) => {
            const url = new URL(route.request().url());
            if (url.origin === origin) await route.continue();
            else { external.push(url.origin); await route.abort(); }
          });
          const page = await context.newPage();
          page.setDefaultTimeout(7000);
          page.on('pageerror', (error: Error) => errors.push(error.message));
          try {
            await page.goto(origin);
            await page.locator('#manager-dashboard-snapshots').waitFor({ state: 'visible' });
            const files = ['a.ktsp', 'b.ktsp', 'c.ktsp'].map(name => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.alloc(6 * 1024 * 1024, 65) }));
            await page.locator('#manager-dashboard-snapshots').setInputFiles(files);
            await page.getByRole('button', { name: 'Загрузить файлы', exact: true }).click();
            await eventually(() => refreshWaiting, 'confirmed first POST must reach its follow-up GET');
            assert.equal(postCount, 1);
            assert.ok(uploadedBytes[0] > 12 * 1024 * 1024 && uploadedBytes[0] < 13 * 1024 * 1024, 'first batch contains only the first two files');
            await page.getByRole('button', { name: cancelButton, exact: true }).click();
            await page.getByText('Текущая операция сохранена. Дальнейшая отправка остановлена.', { exact: true }).waitFor();
            await page.getByText('Файл не отправлен: дальнейшая загрузка остановлена пользователем. Уже сохранённые файлы не отменены.', { exact: true }).waitFor();
            const results = page.locator('.results');
            assert.equal(await results.locator('li').count(), 3);
            for (const name of ['a.ktsp', 'b.ktsp']) {
              const row = results.locator('li').filter({ hasText: name });
              assert.equal(await row.getByText('Загружен', { exact: true }).count(), 1, 'confirmed result must stay successful');
            }
            assert.equal(await results.locator('li').filter({ hasText: 'c.ktsp' }).getByText('Пропущен', { exact: true }).count(), 1);
            assert.equal(await page.getByRole('button', { name: 'Загрузить файлы', exact: true }).isEnabled(), true);
            assert.equal(await page.getByRole('button', { name: 'Обновить', exact: true }).isEnabled(), true);
            await eventually(() => refreshClosed, 'cancelled refresh must release its pending network connection');
            await new Promise(resolve => setTimeout(resolve, 100));
            assert.equal(postCount, 1, 'neither cancellation control may send the next batch after a confirmed save');

            // A later explicit action remains possible; there is no automatic retry.
            await page.getByRole('button', { name: 'Обновить', exact: true }).click();
            await eventually(() => getCount === 3, 'manual refresh after cancellation should work');
            await page.locator('#manager-dashboard-snapshots').setInputFiles([files[2]]);
            await page.getByRole('button', { name: 'Загрузить файлы', exact: true }).click();
            await results.locator('li').filter({ hasText: 'c.ktsp' }).getByText('Загружен', { exact: true }).waitFor();
            assert.equal(postCount, 2, 'only the new explicit upload sends the remaining file');
            assert.deepEqual(errors, []);
            assert.deepEqual(external, []);
            console.log(`PASS ${engineName}: ${cancelButton} after confirmed POST preserves results and stops the batch`);
          } finally {
            await context.close();
            for (const response of held) response.destroy();
            held.clear();
          }
        }
      } finally { await browser.close(); }
    }
    assert.ok(enginesTested > 0, 'at least one browser engine must run');
  } finally {
    for (const response of held) response.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
