/** Real React/browser fault acceptance with synthetic fetch; no production requests. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const fixture = `
import React,{useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {useAdminSlides} from './src/features/admin/model/useAdminSlides';
import {useAdminNews} from './src/features/admin/model/useAdminNews';
import {useAdminBrandPortfolio} from './src/features/admin/model/useAdminBrandPortfolio';
import {useAdminGroupCompanies} from './src/features/admin/model/useAdminGroupCompanies';
import {useAdminPriceGroups} from './src/features/admin/model/useAdminPriceGroups';
const params=new URLSearchParams(location.search), mode=params.get('mode'), kind=params.get('kind');
window.calls=[];window.signals=[];window.reloads=0;
window.fetch=async (url,init={})=>{window.calls.push({url,method:init.method||'GET'});window.signals.push(init.signal);
 if(mode==='network')throw new TypeError('Offline');
 if(mode==='headers-hang')return new Promise(()=>{});
 if(mode==='body-hang')return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}));
 if(mode==='refresh-fail'&&(!init.method||init.method==='GET'))throw new TypeError('Scoped read offline');
 return Response.json({ok:true});
};
function Form(){const[busy,setBusy]=useState(false),[message,showStatus]=useState(''),[text,setText]=useState('Original draft');
 const actionLock=useRef(false), options={setBusy,showStatus,actionLock,reloadAdminData:async()=>{window.reloads++;throw new Error('Broad reload is forbidden');}};
 const forms={slides:useAdminSlides(options),news:useAdminNews(options),brands:useAdminBrandPortfolio(options),companies:useAdminGroupCompanies(options),priceGroups:useAdminPriceGroups(options)};
 const saveNames={slides:'saveSlide',news:'saveNews',brands:'saveBrand',companies:'saveGroupCompany',priceGroups:'savePriceGroup'};
 const save=()=>forms[kind][saveNames[kind]]({id:1,title:text,name:text,imageUrl:'/fixture.png',categoryId:1});
 return <section><input aria-label="Draft" value={text} onChange={e=>setText(e.target.value)}/><button disabled={busy} onClick={()=>{void save();void save();}}>{busy?'Saving':'Save'}</button><p role="status">{message}</p></section>;
}
function App(){const[shown,setShown]=useState(true);return <><button onClick={()=>setShown(false)}>Close</button>{shown&&<Form/>}</>;}
createRoot(document.getElementById('root')).render(<App/>);
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
  const bundle = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'short-test-deadline', setup(plugin) {
      plugin.onLoad({ filter: /\/adminRequest\.ts$/ }, async (args) => ({
        contents: (await readFile(args.path, 'utf8')).replace('ADMIN_REQUEST_TIMEOUT_MS = 20_000', 'ADMIN_REQUEST_TIMEOUT_MS = 75'), loader: 'ts',
      }));
    } }],
  });
  const server = createServer((request, response) => {
    if (request.url === '/app.js') response.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script></html>');
  });
  let tested = 0;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engineName of ['chromium', 'webkit']) {
      const browser = await playwright[engineName].launch({ headless: true });
      try {
        for (const kind of ['slides', 'news', 'brands', 'companies', 'priceGroups']) {
          for (const mode of ['network', 'headers-hang', 'body-hang', 'refresh-fail']) {
            const page = await browser.newPage();
            await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
            await page.goto(`${origin}/?kind=${kind}&mode=${mode}`);
            await page.getByLabel('Draft').fill('Keep my draft');
            await page.getByRole('button', { name: 'Save', exact: true }).click();
            await page.getByRole('status').filter({ hasText: mode === 'refresh-fail' ? 'Изменения уже сохранены' : 'могло сохраниться' }).waitFor();
            assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true);
            assert.equal(await page.getByLabel('Draft').inputValue(), 'Keep my draft');
            const calls = await page.evaluate(() => (window as unknown as { calls: Array<{ url: string; method: string }> }).calls);
            assert.equal(calls.length, mode === 'refresh-fail' ? 2 : 1);
            assert.equal(calls.filter((call: { method: string }) => call.method !== 'GET').length, 1, 'no duplicate write or automatic mutation retry');
            assert.equal(calls.filter((call: { method: string }) => call.method === 'GET').length, mode === 'refresh-fail' ? 1 : 0);
            assert.equal(await page.evaluate(() => (window as unknown as { reloads: number }).reloads), 0, 'no cross-section reload');
            if (mode.endsWith('hang')) assert.equal(await page.evaluate(() => (window as unknown as { signals: AbortSignal[] }).signals[0].aborted), true);
            await page.close(); tested++;
          }
        }
      } finally { await browser.close(); }
    }
    console.log(`Admin content fault acceptance passed: ${tested} browser cases (Chromium + WebKit)`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
