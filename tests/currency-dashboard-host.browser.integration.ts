/** Actual React host + opaque fixture: preview isolation, role UI and publication refresh. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import postcss from 'postcss';
import { compile } from 'sass';

const initial = { activeVersionId: 2, previousVersionId: 1, revision: 1, versions: [2, 1].map((id) => ({ id, originalName: `version-${id}.html`, sourceVersion: `V${id}`, fileSize: 1234, sha256: 'a'.repeat(64), createdAt: '2026-10-16T10:00:00Z', createdBy: 'Fixture' })) };
type Route = { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> };

async function main() {
  const root = path.resolve('.');
  const modulePath = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const css: string[] = [];
  const bundle = await build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {CurrencyDashboard} from './src/features/admin/currency-dashboard/CurrencyDashboard';
    const mode=new URLSearchParams(location.search).get('mode');
    createRoot(document.getElementById('root')).render(<CurrencyDashboard nonce="6a9aeac1-42cd-4212-9562-8fa520432d43" deviceScope="user:7" canManage={mode!=='viewer'} embedded={mode==='embedded'} previewVersion={mode==='preview'?3:undefined}/>);`, loader: 'tsx', resolveDir: root },
    absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'fixture', setup(plugin) {
      plugin.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'next/link', namespace: 'next-fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'next-fixture' }, () => ({ contents: 'import React from "react";export default function Link({children,...props}){return React.createElement("a",props,children)}', loader: 'js', resolveDir: root }));
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        const compiled = compile(args.path, { importers: [{ findFileUrl(url) { return url.startsWith('@/') ? pathToFileURL(path.join(root, 'src', url.slice(2))) : null; } }] }).css;
        const prefix = `fixture${css.length}_`;
        const names = [...compiled.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]);
        const parsed = postcss.parse(compiled);
        parsed.walkRules((rule) => { rule.selector = rule.selector.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.${prefix}${name}`); });
        css.push(parsed.toString());
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, prefix + name])))};`, loader: 'js' };
      });
    } }],
  });
  const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const fonts = new Map<string, Buffer>();
  for (const match of globals.matchAll(/url\("(\/fonts\/[^"?]+)"\)/g)) fonts.set(match[1], await readFile(path.join(root, 'public', match[1])));
  let state = structuredClone(initial);
  const remote: string[] = [], frameRequests: string[] = [], unexpected: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const json = (value: unknown) => response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
    if (url.pathname === '/') return void response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    if (url.pathname === '/fixture.js') return void response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    if (url.pathname === '/fixture.css') return void response.writeHead(200, { 'Content-Type': 'text/css' }).end(`${globals}\n${css.join('\n')}`);
    if (fonts.has(url.pathname)) return void response.writeHead(200, { 'Content-Type': 'font/woff2' }).end(fonts.get(url.pathname));
    if (url.pathname === '/favicon.ico') return void response.writeHead(204).end();
    if (url.pathname === '/api/admin/currency-dashboard/frame') {
      frameRequests.push(url.search);
      const nonce = url.searchParams.get('nonce');
      const preview = url.searchParams.has('previewVersion');
      return void response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(`<!doctype html><html><body><h1>Fixture ${preview ? 'preview' : 'published'}</h1><p id="state">starting</p><script>
        const nonce=${JSON.stringify(nonce)},channel='kts-currency-v1',pending=new Map();let id=0;
        window.fixture={ticks:0,usage:0,results:{},done:false};
        window.addEventListener('message',event=>{if(event.source!==parent)return;const m=event.data;if(m?.marker==='kts-dashboard-usage-v1'&&m.type==='init')window.fixture.usage++;
          if(m?.channel!==channel||m.nonce!==nonce)return;if(m.event==='schedule:tick')window.fixture.ticks++;if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id)}});
        const rpc=(method,params={})=>new Promise(resolve=>{const requestId='fixture-'+(++id);pending.set(requestId,resolve);parent.postMessage({channel,nonce,id:requestId,method,params},'*')});
        window.addEventListener('load',()=>setTimeout(async()=>{const r=window.fixture.results;
          r.before=await rpc('device:get');r.write=await rpc('device:set',{key:'kts_prefs',value:{sound:${!preview},notif:true}});r.after=await rpc('device:get');
          r.permission=await rpc('notification:permission');r.notification=await rpc('notification:show',{body:'Synthetic rate'});
          r.snapshot=await rpc('snapshot:get');r.source=await rpc('source',{kind:'cbr-base-history'});
          r.save=await rpc('snapshot:save',{expectedRevision:1});r.rollback=await rpc('snapshot:rollback',{expectedRevision:1});
          r.schedule=await rpc('schedule:start');window.fixture.done=true;document.getElementById('state').textContent='ready';},20));
      </script></body></html>`);
    }
    if (url.pathname === '/api/admin/currency-dashboard/html') {
      if (request.method === 'GET') return void json(state);
      let body = ''; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      assert.equal(payload.expectedRevision, state.revision);
      state = { ...state, activeVersionId: payload.versionId, previousVersionId: state.activeVersionId, revision: state.revision + 1 };
      return void json(state);
    }
    if (url.pathname === '/api/admin/currency-dashboard') {
      let body = ''; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body); remote.push(payload.method);
      return void json(payload.method === 'source' ? { data: [], _currencySource: { fetchedAt: '2026-10-16T10:00:00Z', stale: false } } : { revision: 1, current: null });
    }
    unexpected.push(`${request.method} ${url.pathname}`); response.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        for (const mode of ['preview', 'viewer', 'embedded', 'manage']) {
          state = structuredClone(initial); remote.length = 0; frameRequests.length = 0;
          const context = await browser.newContext({ viewport: { width: mode === 'manage' ? 1440 : 390, height: 1000 } });
          const external: string[] = [];
          await context.route('**/*', async (route: Route) => { if (new URL(route.request().url()).origin === origin) await route.continue(); else { external.push(route.request().url()); await route.abort(); } });
          await context.addInitScript({ content: `if(window===top){
            localStorage.setItem('kts:currency-device:v1:user:7', JSON.stringify({kts_prefs:{voice:true}}));
            Object.defineProperty(window,'Notification',{configurable:true,value:class {
              static permission='granted';static async requestPermission(){return 'granted'}
              constructor(){} /* Synthetic notification: no system UI. */
            }});
          }` });
          try {
            const page = await context.newPage();
            const errors: string[] = [];
            page.on('pageerror', (error: Error) => errors.push(error.message));
            await page.goto(`${origin}/?mode=${mode}`);
            const title = mode === 'preview' ? 'Предпросмотр HTML — курсы валют и медь' : 'Курсы валют и медь — интерактивный дашборд';
            const frame = page.frameLocator(`iframe[title="${title}"]`);
            await frame.getByText('ready', { exact: true }).waitFor();
            const element = page.locator(`iframe[title="${title}"]`);
            const browsingFrame = await (await element.elementHandle()).contentFrame();
            await browsingFrame.waitForFunction('window.fixture.ticks>0');
            if (mode !== 'preview') await browsingFrame.waitForFunction('window.fixture.usage>0');
            const result = await browsingFrame.evaluate('window.fixture');
            assert.equal(result.results.after.result.persistent, mode !== 'preview');
            assert.equal(result.results.permission.result.permission, mode === 'preview' ? 'unsupported' : 'granted');
            assert.equal(result.results.notification.result.shown, mode !== 'preview');
            assert.equal(result.results.save.error?.status, mode === 'manage' ? undefined : 403);
            assert.equal(result.results.rollback.error?.status, mode === 'manage' ? undefined : 403);
            assert.equal(remote.filter((method) => method === 'snapshot:save' || method === 'snapshot:rollback').length, mode === 'manage' ? 2 : 0);
            assert.equal(await page.getByRole('heading', { name: 'HTML-версии курсов валют', exact: true }).count(), mode === 'manage' ? 1 : 0);
            assert.equal(await element.getAttribute('sandbox'), 'allow-scripts allow-downloads allow-modals allow-forms');
            if (mode === 'preview') {
              assert.equal(new URLSearchParams(frameRequests[0]).get('readOnly'), '1');
              assert.equal(new URLSearchParams(frameRequests[0]).get('previewVersion'), '3');
              assert.deepEqual(JSON.parse(await page.evaluate('localStorage.getItem("kts:currency-device:v1:user:7")')), { kts_prefs: { voice: true } });
              assert.equal(result.usage, 0);
              assert.equal(await page.getByRole('heading', { name: 'Курсы валют и медь', exact: true }).count(), 0, 'preview forces embedded presentation');
            }
            if (mode === 'manage') {
              const before = await element.getAttribute('src');
              const stored = await page.evaluate('localStorage.getItem("kts:currency-device:v1:user:7")');
              await page.getByRole('listitem').filter({ hasText: 'version-1.html' }).getByRole('button', { name: 'Предпросмотр', exact: true }).click();
              const previewElement = page.locator('iframe[title="Предпросмотр HTML — курсы валют и медь"]');
              await page.frameLocator('iframe[title="Предпросмотр HTML — курсы валют и медь"]').getByText('ready', { exact: true }).waitFor();
              assert.notEqual(new URL(await previewElement.getAttribute('src'), origin).searchParams.get('nonce'), new URL(before, origin).searchParams.get('nonce'));
              assert.equal(await page.evaluate('localStorage.getItem("kts:currency-device:v1:user:7")'), stored);
              assert.equal(remote.filter((method) => method === 'snapshot:save' || method === 'snapshot:rollback').length, 2, 'embedded draft cannot inherit administrator snapshot writes');
              await page.getByLabel('Проверил предпросмотр и хочу показать эту версию сотрудникам').check();
              await page.getByRole('button', { name: 'Опубликовать эту версию', exact: true }).click();
              await page.getByRole('status').filter({ hasText: 'Новая HTML-версия опубликована' }).waitFor();
              await page.waitForFunction((old: string) => document.querySelector<HTMLIFrameElement>('iframe[title="Курсы валют и медь — интерактивный дашборд"]')?.getAttribute('src') !== old, before);
              await page.frameLocator('iframe[title="Курсы валют и медь — интерактивный дашборд"]').getByText('ready', { exact: true }).waitFor();
              assert.equal(await previewElement.count(), 0);
              assert.equal(state.activeVersionId, 1);
              assert.equal(await page.getByText(/История ЦБ с 2022 года:/).count(), 1);
            }
            assert.deepEqual(errors, []); assert.deepEqual(external, []);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            console.log(`PASS ${engine}/${mode}: actual React host, readonly enforcement, device and notification isolation, Worker ticks, role UI${mode === 'manage' ? ', separate draft nonce and published-frame refresh' : ''}.`);
          } finally { await context.close(); }
        }
      } finally { await browser.close(); }
    }
    assert.deepEqual(unexpected, []);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
