/** Isolated upload/preview/publication UI: synthetic API only, no production writes. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'sass';
import type { CurrencyDashboardHtmlState } from '../src/shared/lib/db/currencyDashboardHtmlRepo';

const initial: CurrencyDashboardHtmlState = {
  versions: [2, 1].map((id) => ({ id, originalName: `курсы_V${id === 2 ? 25 : 21}.html`, fileSize: 200_000, sha256: String(id).repeat(64), createdAt: '2026-10-16T10:00:00Z', createdBy: 'Тестовый администратор', sourceVersion: id === 2 ? 'V25' : 'V21' })),
  activeVersionId: 2, previousVersionId: 1, revision: 1,
};
type Route = { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> };

async function main() {
  const root = path.resolve('.');
  const require = createRequire(path.join(root, 'package.json'));
  let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!modulePath) {
    try { modulePath = path.dirname(require.resolve('playwright/package.json')); }
    catch { modulePath = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const screenshots = await mkdtemp('/private/tmp/kts-currency-html-ui-');
  const css: string[] = [];
  const bundle = await build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';
      import {CurrencyHtmlManagement} from './src/features/admin/currency-dashboard/CurrencyHtmlManagement';
      window.publishedCount=0;window.failRefresh=false;window.hangRefresh=false;window.fastTimeout=false;
      const realTimeout=window.setTimeout.bind(window);
      window.setTimeout=(work,ms,...args)=>realTimeout(work,window.fastTimeout&&ms>=20000?50:ms,...args);
      createRoot(document.getElementById('root')).render(<main><h1>Действующий дашборд</h1><div className="published">Дашборд расположен выше управления</div><CurrencyHtmlManagement onPublished={()=>{window.publishedCount++;if(window.hangRefresh)return new Promise(()=>{});if(window.failRefresh)throw new Error('synthetic refresh failure')}} renderPreview={(id)=><div data-testid="preview" data-version={id}>Синтетический предпросмотр {id}</div>}/></main>);`, resolveDir: root, loader: 'tsx' },
    absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'fixture-styles', setup(plugin) {
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        const compiled = compile(args.path).css;
        css.push(compiled);
        const names = [...compiled.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]);
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, name])))};`, loader: 'js' };
      });
    } }],
  });
  const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const fonts = new Map<string, Buffer>();
  for (const match of globals.matchAll(/url\("(\/fonts\/[^"?]+)"\)/g)) fonts.set(match[1], await readFile(path.join(root, 'public', match[1])));
  let state = structuredClone(initial);
  let mode: 'normal' | 'conflict' | 'network' | 'reject' | 'quota' | 'forbidden' | 'slow' | 'body-hang' | 'load-hang' = 'normal';
  const slow = { response: null as ServerResponse | null };
  const mutations: Array<{ method: string; payload?: Record<string, unknown>; body?: string }> = [];
  const unexpected: string[] = [];
  const json = (response: ServerResponse, status: number, body: unknown) => response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    if (url.pathname === '/fixture.js') return void response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    if (url.pathname === '/fixture.css') return void response.writeHead(200, { 'Content-Type': 'text/css' }).end(`${globals}\n${css.join('\n')}\nbody{margin:0;background:#f4f5f8}main{padding:20px;max-width:1400px;margin:auto}.published{padding:30px;background:white}h1{font-size:24px}`);
    if (fonts.has(url.pathname)) return void response.writeHead(200, { 'Content-Type': 'font/woff2' }).end(fonts.get(url.pathname));
    if (url.pathname === '/favicon.ico') return void response.writeHead(204).end();
    if (url.pathname !== '/api/admin/currency-dashboard/html') { unexpected.push(url.pathname); return void response.writeHead(404).end(); }
    if (mode === 'forbidden') return void json(response, 403, { error: 'Доступ отозван' });
    if (request.method === 'GET') {
      if (mode === 'load-hang') { slow.response = response; return; }
      return void json(response, 200, state);
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.method === 'POST') {
      mutations.push({ method: 'POST', body });
      if (mode === 'slow') { slow.response = response; return; }
      if (mode === 'body-hang') { slow.response = response; response.writeHead(201, { 'Content-Type': 'application/json' }); response.write('{"versions":['); return; }
      if (mode === 'reject') return void json(response, 422, { error: 'HTML не совместим: отсутствует требуемый блок.' });
      if (mode === 'quota') return void json(response, 409, { code: 'CURRENCY_HTML_QUOTA', error: 'Хранилище HTML-версий заполнено.' });
      const version = { ...initial.versions[0], id: 3, originalName: 'новые_курсы_V26.html', sourceVersion: 'V26' };
      state = { ...state, versions: [version, ...state.versions.filter((item) => item.id !== 3)] };
      return void json(response, 201, { ...state, version });
    }
    if (request.method === 'PATCH') {
      const payload = JSON.parse(body) as Record<string, unknown>;
      mutations.push({ method: 'PATCH', payload });
      if (mode === 'network') return response.destroy();
      if (mode === 'conflict') {
        state = { ...state, revision: state.revision + 1 };
        mode = 'normal';
        return void json(response, 409, { code: 'CURRENCY_HTML_CONFLICT', revision: state.revision });
      }
      if (payload.expectedRevision !== state.revision) return void json(response, 409, { code: 'CURRENCY_HTML_CONFLICT' });
      state = { ...state, activeVersionId: payload.action === 'rollback' ? state.previousVersionId : Number(payload.versionId), previousVersionId: state.activeVersionId, revision: state.revision + 1 };
      return void json(response, 200, state);
    }
    unexpected.push(`${request.method} ${url.pathname}`);
    response.writeHead(405).end();
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        for (const width of [1440, 390]) {
          state = structuredClone(initial); mode = 'normal'; mutations.length = 0;
          const context = await browser.newContext({ viewport: { width, height: 1000 } });
          const external: string[] = [];
          await context.route('**/*', async (route: Route) => { if (new URL(route.request().url()).origin === origin) await route.continue(); else { external.push(route.request().url()); await route.abort(); } });
          try {
            const page = await context.newPage();
            const errors: string[] = [];
            page.on('pageerror', (error: Error) => errors.push(error.message));
            await page.goto(origin);
            await page.getByRole('button', { name: 'Обновить версии', exact: true }).waitFor();
            const fileInput = page.getByLabel('Новый HTML-файл', { exact: true });
            await fileInput.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
            await page.getByRole('button', { name: 'Загрузить черновик', exact: true }).click();
            await page.getByRole('alert').filter({ hasText: 'Выберите HTML-файл' }).waitFor();
            assert.equal(mutations.length, 0);
            await fileInput.setInputFiles({ name: 'oversized.html', mimeType: 'text/html', buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 'x') });
            await page.getByRole('button', { name: 'Загрузить черновик', exact: true }).click();
            await page.getByRole('alert').filter({ hasText: 'не больше 2 МБ' }).waitFor();
            assert.equal(mutations.length, 0);
            await fileInput.setInputFiles({ name: 'new.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><html><body>fixture</body></html>') });
            await page.getByRole('button', { name: 'Загрузить черновик', exact: true }).click();
            await page.getByTestId('preview').waitFor();
            assert.equal(await page.getByTestId('preview').getAttribute('data-version'), '3');
            assert.equal(state.activeVersionId, 2, 'upload only creates draft');
            assert.equal(await page.getByRole('button', { name: 'Опубликовать эту версию', exact: true }).isDisabled(), true);
            assert.equal(mutations.length, 1);
            assert.match(mutations[0].body ?? '', /name="file"/);
            await page.getByLabel('Проверил предпросмотр и хочу показать эту версию сотрудникам').check();
            await page.getByRole('button', { name: 'Опубликовать эту версию', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'Новая HTML-версия опубликована' }).waitFor();
            assert.deepEqual(mutations[1].payload, { action: 'publish', expectedRevision: 1, versionId: 3 });
            assert.equal(await page.evaluate('window.publishedCount'), 1);
            await page.getByRole('listitem').filter({ hasText: 'курсы_V25.html' }).getByRole('button', { name: 'Предпросмотр', exact: true }).click();
            await page.getByLabel('Проверил предпросмотр и хочу показать эту версию сотрудникам').check();
            mode = 'conflict';
            await page.getByRole('button', { name: 'Опубликовать эту версию', exact: true }).click();
            await page.getByRole('alert').filter({ hasText: 'Список обновлён' }).waitFor();
            assert.equal(await page.getByLabel('Проверил предпросмотр и хочу показать эту версию сотрудникам').isChecked(), false);
            assert.equal(await page.getByRole('button', { name: 'Опубликовать эту версию', exact: true }).isDisabled(), true);
            assert.equal(state.activeVersionId, 3);
            await page.getByRole('button', { name: 'Вернуть предыдущую версию', exact: true }).click();
            assert.equal(state.activeVersionId, 3, 'rollback requires explicit confirmation');
            await page.getByRole('button', { name: 'Подтвердить восстановление', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'Предыдущая HTML-версия восстановлена' }).waitFor();
            assert.equal(state.activeVersionId, 2);
            assert.equal(mutations.at(-1)?.payload?.expectedRevision, 3);
            await page.getByRole('listitem').filter({ hasText: 'новые_курсы_V26.html' }).getByRole('button', { name: 'Предпросмотр', exact: true }).click();
            await page.getByLabel('Проверил предпросмотр и хочу показать эту версию сотрудникам').check();
            mode = 'network';
            await page.getByRole('button', { name: 'Опубликовать эту версию', exact: true }).click();
            await page.getByRole('alert').filter({ hasText: 'Изменение могло сохраниться' }).waitFor();
            assert.equal(await page.getByRole('button', { name: 'Опубликовать эту версию', exact: true }).isDisabled(), true);
            assert.equal(await page.getByRole('button', { name: 'Обновить версии', exact: true }).isEnabled(), true);
            mode = 'normal';
            await page.getByRole('button', { name: 'Обновить версии', exact: true }).click();
            await page.getByRole('alert').waitFor({ state: 'detached' });
            await page.getByLabel('Проверил предпросмотр и хочу показать эту версию сотрудникам').check();
            await page.evaluate('window.failRefresh=true');
            await page.getByRole('button', { name: 'Опубликовать эту версию', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'повторная публикация не нужна' }).waitFor();
            assert.equal(await page.getByRole('alert').count(), 0);
            assert.equal(state.activeVersionId, 3);
            await page.getByRole('listitem').filter({ hasText: 'курсы_V25.html' }).getByRole('button', { name: 'Предпросмотр', exact: true }).click();
            await page.getByLabel('Проверил предпросмотр и хочу показать эту версию сотрудникам').check();
            await page.evaluate('window.hangRefresh=true;window.fastTimeout=true');
            await page.getByRole('button', { name: 'Опубликовать эту версию', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'повторная публикация не нужна' }).waitFor();
            assert.equal(await page.getByRole('button', { name: 'Обновить версии', exact: true }).isEnabled(), true);
            assert.equal(state.activeVersionId, 2);
            await page.evaluate('window.hangRefresh=false;window.fastTimeout=false');
            await page.getByRole('listitem').filter({ hasText: 'новые_курсы_V26.html' }).getByRole('button', { name: 'Предпросмотр', exact: true }).click();
            await page.getByLabel('Проверил предпросмотр и хочу показать эту версию сотрудникам').check();
            await page.getByRole('button', { name: 'Опубликовать эту версию', exact: true }).click();
            await page.getByRole('status').filter({ hasText: 'повторная публикация не нужна' }).waitFor();
            mode = 'reject';
            await fileInput.setInputFiles({ name: 'incompatible.html', mimeType: 'text/html', buffer: Buffer.from('<html>incompatible</html>') });
            await page.getByRole('button', { name: 'Загрузить черновик', exact: true }).click();
            await page.getByRole('alert').filter({ hasText: 'отсутствует требуемый блок' }).waitFor();
            assert.equal(state.activeVersionId, 3);
            assert.equal(await page.getByRole('button', { name: 'Загрузить черновик', exact: true }).isEnabled(), true);
            mode = 'quota';
            await page.getByRole('button', { name: 'Загрузить черновик', exact: true }).click();
            await page.getByRole('alert').filter({ hasText: 'Хранилище HTML-версий заполнено' }).waitFor();
            assert.doesNotMatch(await page.getByRole('alert').innerText(), /другой администратор/);
            assert.equal(state.activeVersionId, 3);
            mode = 'slow';
            await page.getByRole('button', { name: 'Загрузить черновик', exact: true }).click();
            await page.getByRole('button', { name: 'Прервать загрузку', exact: true }).click();
            await page.getByRole('alert').filter({ hasText: 'Изменение могло сохраниться' }).waitFor();
            (slow.response as ServerResponse | null)?.destroy(); slow.response = null;
            mode = 'normal';
            await page.getByRole('button', { name: 'Обновить версии', exact: true }).click();
            await page.getByRole('alert').waitFor({ state: 'detached' });
            mode = 'body-hang';
            await page.evaluate('window.fastTimeout=true');
            const beforeHungBody = mutations.length;
            await page.getByRole('button', { name: 'Загрузить черновик', exact: true }).click();
            await page.getByRole('alert').filter({ hasText: 'Изменение могло сохраниться' }).waitFor();
            assert.equal(mutations.length, beforeHungBody + 1, 'timed-out mutations are not replayed');
            assert.equal(await fileInput.evaluate((input: HTMLInputElement) => input.files?.[0]?.name), 'incompatible.html', 'selection survives an uncertain write');
            assert.equal(await page.getByRole('button', { name: 'Обновить версии', exact: true }).isEnabled(), true);
            (slow.response as ServerResponse | null)?.destroy(); slow.response = null;
            mode = 'load-hang';
            await page.getByRole('button', { name: 'Обновить версии', exact: true }).click();
            await page.getByRole('alert').filter({ hasText: 'не ответил вовремя' }).waitFor();
            assert.equal(await page.getByRole('button', { name: 'Обновить версии', exact: true }).isEnabled(), true);
            (slow.response as ServerResponse | null)?.destroy(); slow.response = null;
            mode = 'normal';
            await page.evaluate('window.fastTimeout=false');
            await page.getByRole('button', { name: 'Обновить версии', exact: true }).click();
            await page.getByRole('alert').waitFor({ state: 'detached' });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await page.screenshot({ path: path.join(screenshots, `${engine}-${width}.png`), fullPage: true });
            mode = 'forbidden';
            await page.getByRole('button', { name: 'Обновить версии', exact: true }).click();
            await page.getByRole('alert').filter({ hasText: 'Управление версиями недоступно' }).waitFor();
            assert.equal(await page.locator('input[type="file"]').count(), 0);
            assert.equal(await page.getByTestId('preview').count(), 0);
            assert.deepEqual(errors, []);
            assert.deepEqual(external, []);
            console.log(`PASS ${engine}/${width}: upload validation, draft preview, explicit publish, optimistic concurrency, rollback, network recovery, cancellation, header/body deadlines, callback timeout, no replay, retained selection, 403 clearing.`);
          } finally { await context.close(); }
        }
      } finally { await browser.close(); }
    }
    assert.deepEqual(unexpected, []);
    console.log(`Screenshots: ${screenshots}`);
  } finally { slow.response?.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
