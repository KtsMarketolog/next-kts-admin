/** Client document UI fault acceptance; only synthetic data, no production access. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AdminClientDetailSection} from './src/features/admin/clients/AdminClientDetailSection';
const params=new URLSearchParams(location.search),mode=params.get('mode');
const client={id:1,title:'Synthetic client',email:'client@example.test',phone:'',note:'',managerId:1,managerName:'Synthetic manager',supportManagerId:null,supportManagerName:'',userCount:1,clientLogin:'synthetic',clientUserId:1,chatUnreadCount:0,isActive:true,createdAt:'2026-10-18T00:00:00Z',updatedAt:'2026-10-18T00:00:00Z'};
const saved={id:2,companyId:1,title:'Saved document',originalName:'draft.txt',mimeType:'text/plain',fileSize:8,isVisible:true,createdAt:'2026-10-18T00:00:00Z'};
const previous={...saved,id:1,title:'Existing document',originalName:'existing.txt'};
window.calls=[];window.signals=[];window.reads=[];window.finish=null;window.finishRead=null;window.client=client;window.companyMode='ok';
window.fetch=async(url,init={})=>{
 if(!init.method||init.method==='GET'){
  window.reads.push(url);
  if(url==='/api/admin/clients/1'){
   if(window.companyMode==='offline')throw new TypeError('Synthetic offline');
   if(window.companyMode==='denied')return Response.json({error:'Клиент не найден или недоступен'},{status:404});
   if(window.companyMode==='invalid')return Response.json({company:{...window.client,id:2}});
   const snapshot=structuredClone(window.client);
   if(window.companyMode==='hold')return new Promise(resolve=>window.releaseCompany=()=>resolve(Response.json({company:snapshot})));
   return Response.json({company:snapshot});
  }
  if(url.endsWith('/price-lists'))return Response.json({priceLists:[]});
  if(url.endsWith('/price-requests'))return Response.json({requests:[]});
  if(url.endsWith('/chat/unread'))return Response.json({unreadCount:0});
  if(url.endsWith('/documents')){
   if(window.holdRead)return new Promise(resolve=>window.finishRead=()=>resolve(Response.json({documents:[previous]})));
   return Response.json({documents:[previous]});
  }
  throw new Error('Unexpected GET '+url);
 }
 window.calls.push({url,method:init.method});window.signals.push(init.signal);
 if(mode.endsWith('network'))throw new TypeError('Offline');
 if(mode.endsWith('headers-hang')||mode==='cancel'||mode==='unmount'||mode==='duplicate')return new Promise(resolve=>window.finish=()=>resolve(Response.json({document:saved})));
 if(mode.endsWith('body-hang'))return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}));
 if(mode==='missing')return Response.json({});
 if(mode==='invalid-json')return new Response('{');
 if(init.method==='DELETE')return Response.json({ok:true});
 return Response.json({document:saved});
};
function App(){const[shown,setShown]=useState(true);return <><button onClick={()=>setShown(false)}>Unmount</button>{shown&&<AdminClientDetailSection clientId={1} onBack={()=>setShown(false)}/>}</>;}
createRoot(document.getElementById('root')).render(<App/>);
`;
let currentCase = '';

async function main() {
  const root = path.resolve('.');
  assert.match(await readFile(path.join(root, 'src/app/admin/AdminPanel.tsx'), 'utf8'),
    /<AdminClientDetailSection\b[^>]*key=\{clientDetailId\}/,
    'Changing the selected client must remount and cancel the previous document request scope');
  const require = createRequire(path.join(root, 'package.json'));
  let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!modulePath) {
    try { modulePath = path.dirname(require.resolve('playwright/package.json')); }
    catch { modulePath = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const bundle = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@': path.join(root, 'src') },
    define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'isolated-ui', setup(plugin) {
      plugin.onLoad({ filter: /\/adminRequest\.ts$/ }, async (args) => ({
        contents: (await readFile(args.path, 'utf8')).replace('ADMIN_REQUEST_TIMEOUT_MS = 20_000', 'ADMIN_REQUEST_TIMEOUT_MS = 150')
          .replace('ADMIN_UPLOAD_TIMEOUT_MS = 5 * 60_000', "ADMIN_UPLOAD_TIMEOUT_MS = new URLSearchParams(location.search).has('manual') ? 3000 : 75"), loader: 'ts',
      }));
      plugin.onLoad({ filter: /\.module\.scss$/ }, () => ({ contents: 'export default new Proxy({}, {get:(_,name)=>name});', loader: 'js' }));
      plugin.onResolve({ filter: /^next\/(navigation|link)$/ }, (args) => ({ path: args.path, namespace: 'fixture' }));
      plugin.onResolve({ filter: /^(?:@\/features\/(?:client-chat\/ClientChatPanel|client-requests\/ClientPriceRequestList)|@\/shared\/lib\/clientRealtimeSync)$/ }, (args) => ({ path: args.path, namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => {
        if (args.path === 'next/navigation') return { contents: "const router={replace:()=>{}};export const useRouter=()=>router,usePathname=()=>'/admin/clients/1',useSearchParams=()=>new URLSearchParams('tab=documents');", loader: 'js' };
        if (args.path === 'next/link') return { contents: "import React from 'react';export default function Link({children,...props}){return React.createElement('a',props,children);}", loader: 'js', resolveDir: root };
        if (args.path.endsWith('clientRealtimeSync')) return { contents: 'export function startClientRealtimeSync(options){window.refresh=()=>options.refresh(new AbortController().signal);return ()=>{};}', loader: 'js' };
        return { contents: 'export const ClientChatPanel=()=>null;export const ClientPriceRequestList=()=>null;', loader: 'js' };
      });
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
        for (const mode of (process.env.KTS_DOC_UI_MODES?.split(',') ?? ['network', 'headers-hang', 'body-hang', 'cancel', 'duplicate', 'unmount', 'missing', 'invalid-json', 'stale-read', 'patch-network', 'patch-body-hang', 'delete-network', 'delete-headers-hang', 'client-refresh', 'client-offline', 'client-denied', 'client-invalid', 'client-stale'])) {
          currentCase = `${engineName}/${mode}`;
          const page = await browser.newPage();
          page.setDefaultTimeout(5000);
          const errors: string[] = [];
          page.on('pageerror', (error: Error) => errors.push(error.message));
          page.on('dialog', (dialog: { accept: () => Promise<void> }) => void dialog.accept());
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(`${origin}/?mode=${mode}${['cancel', 'unmount', 'duplicate'].includes(mode) ? '&manual=1' : ''}`);
          await page.getByPlaceholder('Название документа').fill('Keep document draft');
          await page.locator('input[type=file]').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic data') });
          if (mode.startsWith('client-')) {
            if (mode === 'client-stale') {
              await page.evaluate('window.companyMode="hold";window.pendingCompany=window.refresh()');
              await page.waitForFunction('Boolean(window.releaseCompany)');
            }
            await page.evaluate(`window.companyMode=${JSON.stringify(mode === 'client-stale' || mode === 'client-refresh' ? 'ok' : mode.slice('client-'.length))};window.client={...window.client,title:'Updated synthetic client'}`);
            await page.evaluate('window.refresh()');
            if (mode === 'client-stale') await page.evaluate('window.releaseCompany();window.pendingCompany');
            if (mode === 'client-denied') {
              await page.getByRole('heading', { name: 'Клиент не найден', exact: true }).waitFor();
              await page.getByText('Клиент не найден или недоступен', { exact: true }).waitFor();
              assert.equal(await page.locator('form').count(), 0);
            } else {
              const updated = mode === 'client-stale' || mode === 'client-refresh';
              await page.getByRole('heading', { name: updated ? 'Updated synthetic client' : 'Synthetic client', exact: true }).waitFor();
              if (!updated) await page.getByRole('status').filter({ hasText: /Показаны последние загруженные данные/ }).waitFor();
              assert.equal(await page.getByPlaceholder('Название документа').inputValue(), 'Keep document draft');
              assert.equal(await page.locator('input[type=file]').evaluate((element: HTMLInputElement) => element.files?.[0]?.name), 'draft.txt');
            }
            assert.equal(await page.evaluate('window.reads.filter(url=>url==="/api/admin/clients/1").length>=2'), true);
            assert.equal(await page.evaluate('window.reads.some(url=>url.startsWith("/api/admin/clients?"))'), false);
            assert.equal(await page.evaluate('window.calls.length'), 0);
            assert.deepEqual(errors, []);
            await page.close(); tested++; continue;
          }
          if (mode === 'stale-read') {
            await page.evaluate(() => { const state = window as unknown as { holdRead: boolean; refresh: () => Promise<void> }; state.holdRead = true; void state.refresh(); });
            await page.waitForFunction(() => Boolean((window as unknown as { finishRead: unknown }).finishRead));
          }
          if (mode.startsWith('delete-')) {
            await page.getByRole('button', { name: 'Удалить', exact: true }).click();
          } else if (mode.startsWith('patch-')) {
            await page.locator('.clientDocumentCard input[type=checkbox]').click();
          } else {
            await page.evaluate(() => {
              const form = document.querySelector('form')!;
              form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            });
          }
          if (mode === 'cancel') {
            await page.getByRole('button', { name: 'Отменить ожидание' }).click();
            await page.locator('.clientDocumentStatus').filter({ hasText: 'могло сохраниться' }).waitFor();
            await page.evaluate(() => (window as unknown as { finish: () => void }).finish());
          } else if (mode === 'unmount') {
            await page.getByRole('button', { name: 'Unmount', exact: true }).click();
            await page.evaluate(() => (window as unknown as { finish: () => void }).finish());
            assert.equal(await page.locator('form').count(), 0);
            assert.equal(await page.evaluate(() => (window as unknown as { signals: AbortSignal[] }).signals[0].aborted), true);
          } else if (mode === 'duplicate') {
            assert.equal(await page.getByRole('button', { name: 'Обработка...' }).isDisabled(), true);
            assert.equal(await page.getByRole('button', { name: 'Удалить', exact: true }).isDisabled(), true);
            assert.equal(await page.getByPlaceholder('Название документа').isDisabled(), true);
            await page.evaluate(() => (window as unknown as { finish: () => void }).finish());
            await page.getByText('Документ прикреплен', { exact: true }).waitFor();
            assert.equal(await page.locator('input[type=file]').evaluate((element: HTMLInputElement) => element.files?.length), 0);
          } else if (mode === 'stale-read') {
            await page.getByText('Документ прикреплен', { exact: true }).waitFor();
            await page.evaluate(() => (window as unknown as { finishRead: () => void }).finishRead());
            await page.getByRole('heading', { name: 'Saved document', exact: true }).waitFor();
          } else {
            await page.locator('.clientDocumentStatus').filter({ hasText: /могло сохраниться|Не удалось подтвердить/ }).waitFor();
          }
          if (!['unmount', 'duplicate', 'stale-read'].includes(mode)) {
            assert.equal(await page.getByRole('button', { name: 'Прикрепить документ', exact: true }).isEnabled(), true);
            assert.equal(await page.getByPlaceholder('Название документа').inputValue(), 'Keep document draft');
            assert.equal(await page.locator('input[type=file]').evaluate((element: HTMLInputElement) => element.files?.[0]?.name), 'draft.txt');
            assert.equal(await page.getByRole('heading', { name: 'Existing document', exact: true }).count(), 1);
            if (mode.endsWith('hang') || mode === 'cancel') assert.equal(await page.evaluate(() => (window as unknown as { signals: AbortSignal[] }).signals[0].aborted), true);
          }
          assert.equal(await page.evaluate(() => (window as unknown as { calls: unknown[] }).calls.length), 1, 'duplicate submit sends exactly one mutation');
          assert.deepEqual(errors, []);
          await page.close(); tested++;
        }
      } finally { await browser.close(); }
    }
    console.log(`Client documents fault acceptance passed: ${tested} browser cases (Chromium + WebKit)`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

void main().catch((error) => { console.error(currentCase, error); process.exitCode = 1; });
