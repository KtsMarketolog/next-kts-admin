/**
 * Real TOP MR reader and sandbox wrapper, synthetic HTTP API only.
 * node --import tsx tests/manager-dashboard-review.browser.integration.ts
 * Serves 127.0.0.1, blocks external requests, screenshots go to /private/tmp.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import postcss from 'postcss';
import { compile } from 'sass';

import { buildPersonalDashboardReviewFrame, personalHtmlCsp } from '../src/shared/lib/managerDashboardHtml';
import { PERSONAL_PRIVATE_HEADERS } from '../src/shared/lib/managerDashboardSecurity';

type Route = { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> };
type State = {
  forbidden: boolean;
  delayManager: number | null;
  pending: { response: ServerResponse; managerId: number } | null;
  requests: Array<{ path: string; method: string; query: string }>;
};
const newState = (): State => ({ forbidden: false, delayManager: null, pending: null, requests: [] });
const managers = [
  { id: 1, name: 'Первый тестовый менеджер', email: 'first@example.test' },
  { id: 2, name: 'Второй тестовый менеджер', email: 'second@example.test' },
];
const snapshots = [
  { id: 101, managerId: 1, originalName: 'первый_текущий.ktsp', issued: '2026-10-08', expires: '2099-12-31', receivedAt: '2026-10-08T06:00:00Z', status: 'active' },
  { id: 91, managerId: 1, originalName: 'первый_архивный.ktsp', issued: '2026-10-07', expires: '2099-12-31', receivedAt: '2026-10-07T06:00:00Z', status: 'previous' },
  { id: 102, managerId: 2, originalName: 'второй_текущий.ktsp', issued: '2026-10-08', expires: '2099-12-31', receivedAt: '2026-10-08T06:00:00Z', status: 'active' },
];
function overview(managerId: number | null) {
  const manager = managers.find((item) => item.id === managerId);
  return {
    managers,
    htmlVersion: { id: 10, originalName: 'published_mr.html', audience: 'development', firstPublishedAt: '2026-10-08T06:00:00Z' },
    selected: manager ? { managerId: manager.id, name: manager.name, email: manager.email, audience: 'development', bindingStatus: 'matched',
      snapshot: snapshots.find((item) => item.managerId === manager.id && item.status === 'active'),
      history: snapshots.filter((item) => item.managerId === manager.id) } : null,
  };
}
const fixtureEntry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ManagerDashboardReview} from './src/features/admin/manager-dashboard/ManagerDashboardReview';
createRoot(document.getElementById('root')).render(<ManagerDashboardReview canViewOwn />);
`;
// The real wrapper delivers a synthetic file to this opaque document. No real report or password is used.
const content = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
body{margin:0;padding:24px;font:16px system-ui;color:#271078;background:#faf9ff}h1{font-size:24px}#binding{overflow-wrap:anywhere}
</style></head><body><h1>Тестовый отчёт МР</h1><p id="binding">Ожидается файл…</p><script>
window.addEventListener('message',function(event){
  if(event.source!==window.parent||event.data?.marker!=='kts-personal-dashboard-v1'||event.data.type!=='snapshot')return;
  document.getElementById('binding').textContent=event.data.email+' — '+event.data.originalName;
  window.fixtureBytes=event.data.bytes.byteLength;
});
window.parent.postMessage({marker:'kts-personal-dashboard-v1',type:'ready'},'*');
</script></body></html>`;

async function main() {
  const root = path.resolve('.');
  const require = createRequire(path.join(root, 'package.json'));
  let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!modulePath) {
    try { modulePath = path.dirname(require.resolve('playwright/package.json')); }
    catch { modulePath = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const screenshots = await mkdtemp('/private/tmp/kts-review-ui-');
  const styles = new Map<string, string>();
  const bundle = await build({
    stdin: { contents: fixtureEntry, resolveDir: root, loader: 'tsx' }, absWorkingDir: root,
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'fixture-components', setup(plugin) {
      plugin.onResolve({ filter: /^next\/(navigation|link)$/ }, (args) => ({ path: args.path, namespace: 'fixture-next' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture-next' }, (args) => ({ contents: args.path === 'next/navigation'
        ? 'const router={replace(path){window.fixtureRedirect=path}}; export function useRouter(){return router}'
        : 'import React from "react"; export default function Link({children,...props}){return React.createElement("a",props,children)}', loader: 'js', resolveDir: root }));
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        const css = compile(args.path, { importers: [{ findFileUrl(url) {
          return url.startsWith('@/') ? pathToFileURL(path.join(root, 'src', url.slice(2))) : null;
        } }] }).css;
        const names = [...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]);
        const prefix = `fixture${styles.size}_`;
        const parsed = postcss.parse(css);
        parsed.walkRules((rule) => { rule.selector = rule.selector.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.${prefix}${name}`); });
        styles.set(args.path, parsed.toString());
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, prefix + name])))};`, loader: 'js' };
      });
    } }],
  });
  const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const css = globals + '\n' + [...styles].sort(([a], [b]) => Number(a.endsWith('/admin.module.scss')) - Number(b.endsWith('/admin.module.scss')))
    .map(([, style]) => style).join('\n');
  const fonts = new Map<string, Buffer>();
  for (const match of globals.matchAll(/url\("(\/fonts\/[^"?]+)"\)/g)) fonts.set(match[1], await readFile(path.join(root, 'public', match[1])));
  let state = newState();
  const unexpected: string[] = [];
  const json = (response: ServerResponse, status: number, payload: unknown) => response.writeHead(status, { ...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const headers = { ...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'text/html;charset=utf-8' };
    if (url.pathname === '/') return void response.writeHead(200, headers).end('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    if (url.pathname === '/fixture.js') return void response.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    if (url.pathname === '/fixture.css') return void response.writeHead(200, { ...headers, 'Content-Type': 'text/css' }).end(css);
    if (fonts.has(url.pathname)) return void response.writeHead(200, { ...headers, 'Content-Type': 'font/woff2' }).end(fonts.get(url.pathname));
    if (url.pathname === '/favicon.ico') return void response.writeHead(204).end();
    state.requests.push({ path: url.pathname, method: request.method ?? 'GET', query: url.search });
    const managerId = Number(url.searchParams.get('manager')) || null;
    if (url.pathname === '/api/admin/manager-dashboard/review' && request.method === 'GET') {
      if (state.forbidden) return void json(response, 403, { error: 'Тестовый отзыв доступа.' });
      if (managerId === state.delayManager && managerId !== null) { state.pending = { response, managerId }; return; }
      return void json(response, 200, overview(managerId));
    }
    if (url.pathname === '/api/admin/manager-dashboard/review/frame' && request.method === 'GET' && managerId) {
      const frame = buildPersonalDashboardReviewFrame({ managerId, versionId: Number(url.searchParams.get('version')), snapshotId: Number(url.searchParams.get('snapshot')) });
      return void response.writeHead(200, { ...headers, 'Content-Security-Policy': frame.csp }).end(frame.html);
    }
    if (url.pathname === '/api/admin/manager-dashboard/review/content' && request.method === 'GET') {
      return void response.writeHead(200, { ...headers, 'Content-Security-Policy': personalHtmlCsp(content) }).end(content);
    }
    if (url.pathname === '/api/admin/manager-dashboard/review/snapshots' && request.method === 'GET') {
      const snapshot = snapshots.find((item) => item.id === Number(url.searchParams.get('snapshot')) && item.managerId === managerId);
      const manager = managers.find((item) => item.id === managerId);
      if (!snapshot || !manager) return void json(response, 404, { error: 'Synthetic snapshot is not owned by selected manager' });
      return void response.writeHead(200, { ...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'application/octet-stream',
        'X-Personal-Email': encodeURIComponent(manager.email), 'X-Personal-Filename': encodeURIComponent(snapshot.originalName) }).end(Buffer.from(`synthetic-${snapshot.id}`));
    }
    if (url.pathname === '/api/admin/dashboard-usage' && request.method === 'POST') return void json(response, 200, { ok: true });
    unexpected.push(`${request.method} ${url.pathname}`);
    response.writeHead(404).end();
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
          state = newState();
          const context = await browser.newContext({ viewport: { width, height: 1000 } });
          const external: string[] = [];
          await context.route('**/*', async (route: Route) => {
            if (new URL(route.request().url()).origin === origin) await route.continue();
            else { external.push(route.request().url()); await route.abort(); }
          });
          try {
            const page = await context.newPage();
            const errors: string[] = [];
            page.on('pageerror', (error: Error) => errors.push(error.message));
            await page.goto(origin);
            const selection = page.getByLabel('Менеджер', { exact: true });
            await selection.locator('option[value="1"]').waitFor({ state: 'attached' });
            assert.equal(await page.getByRole('link', { name:'Мой личный отчёт', exact:true }).getAttribute('href'), '/admin/manager-dashboard?view=personal&audience=development');
            assert.equal(await selection.isDisabled(), false);
            assert.equal(await page.locator('iframe').count(), 0);
            assert.equal(await selection.locator('option').count(), 3);
            assert.doesNotMatch(await page.locator('main').innerText(), /МС|сопровождени/);
            assert.equal(await page.locator('input[type="file"]').count(), 0);
            assert.equal(await page.getByRole('button', { name: /загруз|опубликов|удал|доступ/i }).count(), 0);

            await selection.selectOption('1');
            const outer = page.locator('iframe[title="Личный дашборд менеджера"]');
            const wrapper = page.frameLocator('iframe[title="Личный дашборд менеджера"]');
            const inner = wrapper.frameLocator('#personal');
            await inner.getByText('first@example.test — первый_текущий.ktsp', { exact: true }).waitFor();
            const firstUrl = new URL(await outer.getAttribute('src'), origin);
            assert.equal(firstUrl.pathname, '/api/admin/manager-dashboard/review/frame');
            assert.deepEqual(Object.fromEntries(firstUrl.searchParams), { version: '10', revision: '0', manager: '1', snapshot: '101' });
            assert.equal(await wrapper.locator('#personal').getAttribute('sandbox'), 'allow-scripts');
            assert.equal(await inner.locator('body').evaluate(() => {
              try { void window.parent.document.body; return false; } catch { return true; }
            }), true, 'the content remains opaque to its trusted wrapper');
            assert.ok(state.requests.some((item) => item.path.endsWith('/review/snapshots') && item.query === '?manager=1&snapshot=101'));
            assert.ok(state.requests.some((item) => item.path.endsWith('/review/content') && item.query === '?version=10&manager=1'));

            await page.getByLabel('Версия данных', { exact: true }).selectOption('91');
            await inner.getByText('first@example.test — первый_архивный.ktsp', { exact: true }).waitFor();
            assert.equal(new URL(await outer.getAttribute('src'), origin).searchParams.get('snapshot'), '91');
            assert.equal(await page.locator('dd').filter({ hasText: 'первый_архивный.ktsp' }).count(), 1);
            await page.getByLabel('Версия данных', { exact: true }).selectOption('');
            await inner.getByText('first@example.test — первый_текущий.ktsp', { exact: true }).waitFor();
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'selected report remains within viewport');
            await outer.screenshot({ path: path.join(screenshots, `${engine}-${width}-opaque-frame.png`) });
            await page.screenshot({ path: path.join(screenshots, `${engine}-${width}-mr-review.png`), fullPage: true });

            state.delayManager = 2;
            const delayed = page.waitForRequest((request: { url(): string }) => new URL(request.url()).pathname === '/api/admin/manager-dashboard/review' && new URL(request.url()).searchParams.get('manager') === '2');
            await selection.selectOption('2');
            await delayed;
            await outer.waitFor({ state: 'detached' });
            assert.equal(await page.locator('iframe').count(), 0, 'changing recipient removes the old frame before delayed data arrives');
            assert.doesNotMatch(await page.locator('main').innerText(), /first@example\.test|первый_текущий/);
            await page.screenshot({ path: path.join(screenshots, `${engine}-${width}-switch-pending.png`), fullPage: true });
            assert.ok(state.pending, 'the API response remains held while removal is checked');
            const pending = state.pending;
            state.delayManager = null;
            state.pending = null;
            json(pending.response, 200, overview(pending.managerId));
            await inner.getByText('second@example.test — второй_текущий.ktsp', { exact: true }).waitFor();
            const secondUrl = new URL(await outer.getAttribute('src'), origin);
            assert.equal(secondUrl.searchParams.get('manager'), '2');
            assert.equal(secondUrl.searchParams.get('snapshot'), '102');
            assert.equal(await page.getByLabel('Версия данных', { exact: true }).count(), 0, 'previous recipient history is cleared');

            state.forbidden = true;
            await page.evaluate(() => window.dispatchEvent(new Event('focus')));
            await page.waitForFunction('window.fixtureRedirect === "/admin"');
            await outer.waitFor({ state: 'detached' });
            assert.equal(await page.locator('iframe').count(), 0);
            assert.doesNotMatch(await page.locator('main').innerText(), /first@example\.test|second@example\.test/);
            assert.ok(state.requests.every((request) => request.method === 'GET' || request.method === 'POST' && request.path === '/api/admin/dashboard-usage'), 'read-only review emits no business mutation');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.deepEqual(errors, [], 'the reader and real wrapper have no browser errors');
            assert.deepEqual(external, [], 'no external or application service request');
            console.log(`PASS ${engine}/${width}: MR-only reader, scoped opaque frame, history, immediate recipient clearing, and 403 clearing/redirect.`);
          } finally { await context.close(); }
        }
      } finally { await browser.close(); }
    }
    assert.deepEqual(unexpected, [], 'only synthetic review endpoints and usage are called');
    console.log(`Screenshots: ${screenshots}`);
  } finally {
    state.pending?.response.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
