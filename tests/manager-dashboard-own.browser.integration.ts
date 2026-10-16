/** Isolated leader own-reader acceptance: real UI and wrapper, synthetic API, no production data. */
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
import { buildPersonalDashboardOwnFrame, personalHtmlCsp } from '../src/shared/lib/managerDashboardHtml';
import { PERSONAL_PRIVATE_HEADERS } from '../src/shared/lib/managerDashboardSecurity';
import type { ManagerDashboardOverview } from '../src/features/admin/manager-dashboard/types';

type Route = { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> };
const snapshots = [
  { id:101, originalName:'руководитель_текущий.ktsp', issued:'2026-10-16', expires:'2099-12-31', receivedAt:'2026-10-16T06:00:00Z' },
  { id:91, originalName:'руководитель_предыдущий.ktsp', issued:'2026-10-15', expires:'2099-12-31', receivedAt:'2026-10-15T06:00:00Z' },
];
const overview:Extract<ManagerDashboardOverview, { mode:'view' }> = {
  mode:'view', audience:'development', recipientKey:'admin:7', bindingStatus:'matched', email:'leader@example.test', snapshot:snapshots[0], history:snapshots,
  htmlVersion:{ id:10, originalName:'published_mr.html', audience:'development', firstPublishedAt:'2026-10-16T06:00:00Z' },
};
const entry = `import React from 'react';import {createRoot} from 'react-dom/client';
import {ManagerDashboard} from './src/features/admin/manager-dashboard/ManagerDashboard';
createRoot(document.getElementById('root')).render(<ManagerDashboard mode="view" audience="development" own ownReturn={new URLSearchParams(location.search).get('role')==='admin'?'manage':'team'} />);`;
const content = `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body><h1>Тестовый личный отчёт руководителя</h1><p id="binding">Ожидается файл…</p><script>
window.addEventListener('message',function(event){if(event.source!==window.parent||event.data?.marker!=='kts-personal-dashboard-v1')return;
if(event.data.type==='snapshot')document.getElementById('binding').textContent=event.data.email+' — '+event.data.originalName;
if(event.data.type==='empty')document.getElementById('binding').textContent='empty:'+event.data.reason;});
window.parent.postMessage({marker:'kts-personal-dashboard-v1',type:'ready'},'*');</script></body></html>`;

async function main() {
  const root = path.resolve('.');
  const require = createRequire(path.join(root, 'package.json'));
  let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!modulePath) {
    try { modulePath = path.dirname(require.resolve('playwright/package.json')); }
    catch { modulePath = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const screenshots = await mkdtemp('/private/tmp/kts-own-dashboard-ui-');
  const styles = new Map<string, string>();
  const bundle = await build({
    stdin:{ contents:entry, resolveDir:root, loader:'tsx' }, absWorkingDir:root, bundle:true, write:false, platform:'browser', format:'iife', jsx:'automatic',
    alias:{ '@':path.join(root, 'src') }, define:{ 'process.env.NODE_ENV':'"test"' },
    plugins:[{ name:'fixture', setup(plugin) {
      plugin.onResolve({ filter:/^next\/(navigation|link)$/ }, args => ({ path:args.path, namespace:'next-fixture' }));
      plugin.onLoad({ filter:/.*/, namespace:'next-fixture' }, args => ({ contents:args.path === 'next/navigation'
        ? 'const router={replace(path){window.fixtureRedirect=path}};export function useRouter(){return router}'
        : 'import React from "react";export default function Link({children,...props}){return React.createElement("a",props,children)}', loader:'js', resolveDir:root }));
      plugin.onLoad({ filter:/\.module\.scss$/ }, args => {
        const css = compile(args.path, { importers:[{ findFileUrl(url) { return url.startsWith('@/') ? pathToFileURL(path.join(root, 'src', url.slice(2))) : null; } }] }).css;
        const names = [...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(match => match[1]);
        const prefix = `fixture${styles.size}_`;
        const parsed = postcss.parse(css);
        parsed.walkRules(rule => { rule.selector = rule.selector.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.${prefix}${name}`); });
        styles.set(args.path, parsed.toString());
        return { contents:`export default ${JSON.stringify(Object.fromEntries(names.map(name => [name, prefix + name])))};`, loader:'js' };
      });
    } }],
  });
  const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const css = globals + '\n' + [...styles].sort(([a], [b]) => Number(a.endsWith('/admin.module.scss')) - Number(b.endsWith('/admin.module.scss'))).map(([, style]) => style).join('\n');
  const fonts = new Map<string, Buffer>();
  for (const match of globals.matchAll(/url\("(\/fonts\/[^"?]+)"\)/g)) fonts.set(match[1], await readFile(path.join(root, 'public', match[1])));
  let forbidden = false;
  let currentOverview = overview;
  const requests: Array<{ path:string; method:string; query:string }> = [];
  const unexpected: string[] = [];
  const json = (response:ServerResponse, status:number, payload:unknown) => response.writeHead(status, { ...PERSONAL_PRIVATE_HEADERS, 'Content-Type':'application/json' }).end(JSON.stringify(payload));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const headers = { ...PERSONAL_PRIVATE_HEADERS, 'Content-Type':'text/html;charset=utf-8' };
    if (url.pathname === '/') return void response.writeHead(200, headers).end('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    if (url.pathname === '/fixture.js') return void response.writeHead(200, { ...headers, 'Content-Type':'text/javascript' }).end(bundle.outputFiles[0].contents);
    if (url.pathname === '/fixture.css') return void response.writeHead(200, { ...headers, 'Content-Type':'text/css' }).end(css);
    if (fonts.has(url.pathname)) return void response.writeHead(200, { ...headers, 'Content-Type':'font/woff2' }).end(fonts.get(url.pathname));
    if (url.pathname === '/favicon.ico') return void response.writeHead(204).end();
    requests.push({ path:url.pathname, method:request.method ?? 'GET', query:url.search });
    if (url.pathname === '/api/admin/manager-dashboard/own') return void json(response, forbidden ? 403 : 200, forbidden ? { error:'Тестовый отзыв доступа.' } : currentOverview);
    if (url.pathname === '/api/admin/manager-dashboard/own/frame') {
      const snapshotId = Number(url.searchParams.get('snapshot')) || undefined;
      const selected = currentOverview.history.find(item => item.id === snapshotId) ?? currentOverview.snapshot;
      const emptyState = !selected ? 'no_snapshot' : Date.parse(selected.expires) < Date.now() ? 'expired' : undefined;
      const frame = buildPersonalDashboardOwnFrame({ versionId:Number(url.searchParams.get('version')), snapshotId, emptyState });
      return void response.writeHead(200, { ...headers, 'Content-Security-Policy':frame.csp }).end(frame.html);
    }
    if (url.pathname === '/api/admin/manager-dashboard/own/content') return void response.writeHead(200, { ...headers, 'Content-Security-Policy':personalHtmlCsp(content) }).end(content);
    if (url.pathname === '/api/admin/manager-dashboard/own/snapshots') {
      const snapshot = currentOverview.history.find(item => item.id === Number(url.searchParams.get('snapshot')));
      if (!snapshot) return void json(response, 404, { error:'Unknown synthetic snapshot' });
      return void response.writeHead(200, { ...PERSONAL_PRIVATE_HEADERS, 'Content-Type':'application/octet-stream', 'X-Personal-Email':encodeURIComponent(overview.email), 'X-Personal-Filename':encodeURIComponent(snapshot.originalName) }).end(Buffer.from(`synthetic-${snapshot.id}`));
    }
    if (url.pathname === '/api/admin/dashboard-usage' && request.method === 'POST') return void json(response, 200, { ok:true });
    unexpected.push(`${request.method} ${url.pathname}`);
    response.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless:true });
      try {
        for (const width of [1440, 390]) {
          for (const role of ['top', 'admin']) {
            forbidden = false;
            currentOverview = overview;
            requests.length = 0;
            const context = await browser.newContext({ viewport:{ width, height:1000 } });
            const external:string[] = [];
            await context.route('**/*', async (route:Route) => {
              if (new URL(route.request().url()).origin === origin) await route.continue();
              else { external.push(route.request().url()); await route.abort(); }
            });
            try {
              const page = await context.newPage();
              const errors:string[] = [];
              page.on('pageerror', (error:Error) => errors.push(error.message));
              await page.goto(`${origin}/?role=${role}`);
              const outer = page.locator('iframe[title="Мой личный дашборд МР"]');
              const wrapper = page.frameLocator('iframe[title="Мой личный дашборд МР"]');
              const inner = wrapper.frameLocator('#personal');
              await inner.getByText('leader@example.test — руководитель_текущий.ktsp', { exact:true }).waitFor();
              assert.equal(await page.getByRole('link', { name:role === 'top' ? 'Отчёты менеджеров МР' : 'Управление дашбордами МР', exact:true }).getAttribute('href'), role === 'top' ? '/admin/manager-dashboard?view=team&audience=development' : '/admin/manager-dashboard?audience=development');
              assert.equal(await page.locator('input[type="file"]').count(), 0);
              assert.equal(await page.getByRole('button', { name:/^(?:Загрузить|Опубликовать|Удалить|Сохранить доступ)/i }).count(), 0);
              assert.equal(await wrapper.locator('#personal').getAttribute('sandbox'), 'allow-scripts');
              await page.getByLabel('Версия данных', { exact:true }).selectOption('91');
              await inner.getByText('leader@example.test — руководитель_предыдущий.ktsp', { exact:true }).waitFor();
              await page.getByRole('button', { name:'Перезагрузить отчёт', exact:true }).click();
              await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('iframe[title="Мой личный дашборд МР"]')?.src.includes('revision=1'));
              await inner.getByText('leader@example.test — руководитель_предыдущий.ktsp', { exact:true }).waitFor();
              assert.equal(new URL(await outer.getAttribute('src'), origin).searchParams.get('revision'), '1');
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
              await page.screenshot({ path:path.join(screenshots, `${engine}-${width}-${role}.png`), fullPage:true });
              const changedAccountSnapshot = { ...snapshots[0], id:201, originalName:'другая_учётная_запись.ktsp' };
              currentOverview = { ...overview, recipientKey:'admin:8', snapshot:changedAccountSnapshot, history:[changedAccountSnapshot] };
              await page.evaluate(() => window.dispatchEvent(new Event('focus')));
              await inner.getByText('leader@example.test — другая_учётная_запись.ktsp', { exact:true }).waitFor();
              assert.equal(new URL(await outer.getAttribute('src'), origin).searchParams.get('revision'), '0', 'changing account clears the previous selection even with an identical email');
              assert.equal(await page.getByLabel('Версия данных', { exact:true }).count(), 0);
              assert.doesNotMatch(await page.locator('main').innerText(), /руководитель_предыдущий|Доступна новая версия/);
              currentOverview = { ...overview, snapshot:null, history:[] };
              const snapshotRequests = requests.filter(item => item.path.endsWith('/own/snapshots')).length;
              await page.getByRole('button', { name:'Обновить', exact:true }).click();
              await inner.getByText('empty:no_snapshot', { exact:true }).waitFor();
              assert.match(await page.locator('main').innerText(), /Ваш файл ещё не поступил/);
              assert.equal(await page.getByLabel('Версия данных', { exact:true }).count(), 0);
              currentOverview = { ...overview, snapshot:{ ...snapshots[0], expires:'2000-01-01' }, history:[], snapshotStatus:'expired' };
              await page.getByRole('button', { name:'Обновить', exact:true }).click();
              await inner.getByText('empty:expired', { exact:true }).waitFor();
              assert.match(await page.locator('main').innerText(), /Срок доступа к этому снимку истёк/);
              assert.equal(requests.filter(item => item.path.endsWith('/own/snapshots')).length, snapshotRequests, 'empty/expired report never requests personal bytes');
              forbidden = true;
              await page.evaluate(() => window.dispatchEvent(new Event('focus')));
              await page.waitForFunction('window.fixtureRedirect === "/admin"');
              await outer.waitFor({ state:'detached' });
              assert.doesNotMatch(await page.locator('main').innerText(), /leader@example\.test|руководитель_текущий/);
              assert.ok(requests.every(item => item.path.startsWith('/api/admin/manager-dashboard/own') && item.method === 'GET' || item.path === '/api/admin/dashboard-usage' && item.method === 'POST'));
              assert.ok(requests.every(item => !new URLSearchParams(item.query).has('manager')), 'owner identity is never supplied by UI');
              assert.deepEqual(errors, []);
              assert.deepEqual(external, []);
              console.log(`PASS ${engine}/${width}/${role}: own scope, history/refresh, empty/expired, opaque wrapper, navigation, 403 clearing.`);
            } finally { await context.close(); }
          }
        }
      } finally { await browser.close(); }
    }
    assert.deepEqual(unexpected, []);
    console.log(`Screenshots: ${screenshots}`);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
void main().catch((error:unknown) => { console.error(error); process.exitCode = 1; });
