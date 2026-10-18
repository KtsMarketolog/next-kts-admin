/** Real React draft-isolation acceptance with synthetic data; never contacts production. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const fixture = `
import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useAdminSlides} from './src/features/admin/model/useAdminSlides';
import {useAdminNews} from './src/features/admin/model/useAdminNews';
import {useAdminGroupCompanies} from './src/features/admin/model/useAdminGroupCompanies';
const kind=new URLSearchParams(location.search).get('kind');
const config={
 slides:{endpoint:'slides',key:'slides',rows:'slides',hydrate:'setSlides',draft:'draft',setDraft:'setDraft',field:'title',update:'updateSlide',save:'saveSlide',create:'createSlide',remove:'deleteSlide',move:'moveSlide'},
 news:{endpoint:'news',key:'news',rows:'news',hydrate:'setNews',draft:'newsDraft',setDraft:'setNewsDraft',field:'title',update:'updateNews',save:'saveNews',create:'createNews',remove:'deleteNews',move:'moveNews'},
 companies:{endpoint:'group-companies',key:'companies',rows:'groupCompanies',hydrate:'setGroupCompanies',draft:'groupCompanyDraft',setDraft:'setGroupCompanyDraft',field:'linkUrl',update:'updateGroupCompany',save:'saveGroupCompany',create:'createGroupCompany',remove:'deleteGroupCompany',move:'moveGroupCompany'},
};
const base={title:'Original',date:'2026-10-18',imageUrl:'/fixture.png',linkUrl:'Original',tabletImageUrl:null,mobileImageUrl:null,popupImageUrl:null,popupTabletImageUrl:null,popupMobileImageUrl:null,popupTitle:null,popupText:null,isActive:true};
window.calls=[];window.reloads=0;window.server={slides:[{...base,id:1,sortOrder:1},{...base,id:2,sortOrder:2}],news:[{...base,id:1,sortOrder:1},{...base,id:2,sortOrder:2}],companies:[{...base,id:1,sortOrder:1},{...base,id:2,sortOrder:2}]};
window.confirm=()=>true;
window.fetch=async(url,init={})=>{
 const method=init.method||'GET',parts=url.split('/'),endpoint=parts[3],selected=Object.keys(config).find(name=>config[name].endpoint===endpoint),id=Number(parts[4]);
 const body=init.body?JSON.parse(init.body):null;window.calls.push({url,method,body});
 if(method==='GET'){
  if(window.failRead)throw new TypeError('Read offline');
  return Response.json({[config[selected].key]:window.server[selected]});
 }
 if(window.defer)await new Promise(resolve=>window.resume=resolve);
 if(parts[4]==='reorder'){
  if(window.orderFailure==='rejected')return Response.json({error:'Order rejected'}, {status:500});
  if(window.orderFailure==='conflict')return Response.json({error:'Collection changed'}, {status:409});
  if(window.orderFailure==='network')throw new TypeError('Offline');
  if(window.orderFailure==='timeout')return new Promise(()=>{});
  window.server[selected]=window.server[selected].map(row=>({...row,sortOrder:body.items.find(item=>item.id===row.id).sortOrder}));
  const items=window.orderFailure==='malformed'?body.items.slice(0,1):window.orderFailure==='duplicate'?[body.items[0],body.items[0]]:body.items;
  return Response.json({ok:true,items,warnings:window.orderFailure==='warning'?[{code:'cache',message:'Cache refresh pending'}]:undefined});
 }
 if(method==='DELETE'){window.server[selected]=window.server[selected].filter(row=>row.id!==id);return Response.json({ok:true});}
 const normalized=Object.fromEntries(Object.entries(body).map(([key,value])=>[key,typeof value==='string'?value.trim():value]));
 if(method==='POST'){window.server[selected].push({...normalized,id:3});return Response.json({id:3});}
 window.server[selected]=window.server[selected].map(row=>row.id===id?{...row,...normalized}:row);return Response.json({ok:true});
};
function App(){
 const[busy,setBusy]=useState(false),[message,showStatus]=useState(''),lock=useRef(false);
 const options={setBusy,showStatus,actionLock:lock,reloadAdminData:async()=>{window.reloads++;throw new Error('Broad reload is forbidden');}};
 const forms={slides:useAdminSlides(options),news:useAdminNews(options),companies:useAdminGroupCompanies(options)};
 useEffect(()=>{for(const name of Object.keys(forms))forms[name][config[name].hydrate](structuredClone(window.server[name]));},[]);
 window.forms=forms;window.config=config;
 const settings=config[kind],form=forms[kind],rows=form[settings.rows],draft=form[settings.draft];
 const crossKind=kind==='slides'?'news':'slides',crossConfig=config[crossKind],cross=forms[crossKind];
 const state=Object.fromEntries(Object.keys(forms).map(name=>[name,{rows:forms[name][config[name].rows],draft:forms[name][config[name].draft],dirtyCount:forms[name].dirtyCount}]));
 return <>
  {[1,2].map(id=>{const row=rows.find(row=>row.id===id);return row&&<input key={id} aria-label={'Row '+id} value={row[settings.field]} onChange={event=>form[settings.update](id,{[settings.field]:event.target.value})}/>;})}
  <input aria-label="New draft" value={draft[settings.field]} onChange={event=>form[settings.setDraft]({...draft,[settings.field]:event.target.value,imageUrl:'/draft.png',title:settings.field==='title'?event.target.value:'New company'})}/>
  <input aria-label="Other section" value={cross[crossConfig.rows][0]?.[crossConfig.field]||''} onChange={event=>cross[crossConfig.update](1,{[crossConfig.field]:event.target.value})}/>
  <button disabled={busy} onClick={()=>void form[settings.save](rows.find(row=>row.id===1))}>Save one</button>
  <button disabled={busy} onClick={()=>void form[settings.create]()}>Create</button>
  <button disabled={busy} onClick={()=>void form[settings.remove](1)}>Delete one</button>
  <button disabled={busy} onClick={()=>{void form[settings.move](1,2);void form[settings.move](1,2);}}>Move</button>
  <p role="status">{message}</p><pre id="state">{JSON.stringify({busy,...state})}</pre>
 </>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;

type Row = { id: number; sortOrder: number; title: string; linkUrl: string };
type DraftState = Record<string, { rows: Row[]; draft: Record<string, unknown>; dirtyCount: number }>;

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
        contents: (await readFile(args.path, 'utf8')).replace('ADMIN_REQUEST_TIMEOUT_MS = 20_000', 'ADMIN_REQUEST_TIMEOUT_MS = 750'), loader: 'ts',
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
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        for (const kind of ['slides', 'news', 'companies']) {
          const field = kind === 'companies' ? 'linkUrl' : 'title';
          for (const scenario of ['save', 'typing-during-save', 'create', 'delete', 'reorder', 'rejected-reorder', 'conflict-reorder', 'network-reorder', 'timeout-reorder', 'malformed-reorder', 'duplicate-reorder', 'late-reorder', 'warning-reorder', 'read-fails']) {
            const page = await browser.newPage();
            await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
            await page.goto(`${origin}/?kind=${kind}`);
            await page.getByLabel('Row 1', { exact: true }).fill(' Saved A ');
            await page.getByLabel('Row 2', { exact: true }).fill('Keep B');
            await page.getByLabel('New draft', { exact: true }).fill('Keep new');
            await page.getByLabel('Other section', { exact: true }).fill('Keep cross section');

            if (scenario === 'typing-during-save' || scenario === 'create' || scenario === 'late-reorder') await page.evaluate('window.defer=true');
            if (scenario.endsWith('-reorder')) await page.evaluate((mode: string) => { (window as any).orderFailure = mode; }, scenario.split('-')[0]);
            if (scenario === 'read-fails') await page.evaluate('window.failRead=true');
            const button = scenario === 'create' ? 'Create' : scenario === 'delete' ? 'Delete one' : scenario.includes('reorder') ? 'Move' : 'Save one';
            await page.getByRole('button', { name: button, exact: true }).click();
            if (scenario === 'typing-during-save' || scenario === 'create' || scenario === 'late-reorder') {
              await page.waitForFunction('typeof window.resume === "function"');
              if (scenario === 'late-reorder') assert.deepEqual((JSON.parse(await page.locator('#state').textContent()) as DraftState)[kind].rows.map(({ id }) => id), [1, 2], 'no optimistic reorder');
              await page.getByLabel(scenario === 'create' ? 'New draft' : 'Row 1', { exact: true }).fill('Newer typing');
              await page.evaluate('window.defer=false;window.resume()');
            }
            await page.waitForFunction('JSON.parse(document.getElementById("state").textContent).busy === false && document.querySelector("[role=status]").textContent.length > 0');
            const state = JSON.parse(await page.locator('#state').textContent()) as DraftState;
            const rows = state[kind].rows;
            const cross = kind === 'slides' ? 'news' : 'slides';
            assert.equal(state[cross].rows[0].title, 'Keep cross section', `${kind}/${scenario}: other section draft`);
            assert.equal(rows.find((row) => row.id === 2)?.[field], 'Keep B', `${kind}/${scenario}: sibling row draft`);
            assert.equal(await page.evaluate('window.reloads'), 0, 'never broad reload');
            const calls = await page.evaluate('window.calls') as Array<{ url: string; method: string; body: Record<string, unknown> | null }>;
            if (scenario.includes('reorder')) {
              assert.equal(calls.length, 1, 'one atomic request, including duplicate click or unknown outcome');
              assert.equal(calls[0].url, `/api/admin/${kind === 'companies' ? 'group-companies' : kind}/reorder`);
              assert.equal(calls[0].method, 'PUT');
              assert.deepEqual(calls[0].body, { items: [{ id: 2, sortOrder: 1 }, { id: 1, sortOrder: 2 }] });
              assert.equal(rows.find((row) => row.id === 1)?.[field], scenario === 'late-reorder' ? 'Newer typing' : ' Saved A ');
              const acknowledged = ['reorder', 'late-reorder', 'warning-reorder'].includes(scenario);
              assert.deepEqual(rows.map((row) => row.id), acknowledged ? [2, 1] : [1, 2]);
              assert.equal(state[kind].dirtyCount, 3, 'acknowledge order only; all text drafts remain');
              assert.equal(await page.evaluate((name: string) => (window as any).server[name][0].title, kind), 'Original', 'server content unchanged by order request');
              if (scenario === 'warning-reorder') assert.match(await page.getByRole('status').textContent(), /Cache refresh pending/);
              if (['malformed-reorder', 'duplicate-reorder'].includes(scenario)) assert.match(await page.getByRole('status').textContent(), /не подтвердил/);
              if (['network-reorder', 'timeout-reorder'].includes(scenario)) assert.match(await page.getByRole('status').textContent(), /могло сохраниться/);
            } else if (scenario === 'create') {
              assert.equal(rows.find((row) => row.id === 3)?.[field], 'Keep new');
              assert.equal(state[kind].draft[field], 'Newer typing');
              assert.equal(state[kind].draft.imageUrl, '', 'only unchanged submitted fields reset');
              assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
            } else if (scenario === 'delete') {
              assert.equal(rows.some((row) => row.id === 1), false);
              assert.equal(calls.length, 1, 'delete does not reload any list');
            } else if (scenario === 'read-fails') {
              assert.equal(rows.find((row) => row.id === 1)?.[field], ' Saved A ');
              assert.match(await page.getByRole('status').textContent(), /Изменения уже сохранены/);
              assert.equal(state[kind].dirtyCount, 3);
            } else {
              assert.equal(rows.find((row) => row.id === 1)?.[field], scenario === 'typing-during-save' ? 'Newer typing' : 'Saved A');
              assert.equal(state[kind].dirtyCount, scenario === 'typing-during-save' ? 3 : 2);
              assert.equal(calls.length, 2, 'one mutation and one scoped read');
              assert.ok(calls.every((call) => call.url.startsWith(`/api/admin/${kind === 'companies' ? 'group-companies' : kind}`)));
            }
            if (scenario !== 'create') assert.equal(state[kind].draft[field], 'Keep new');
            await page.close(); tested++;
          }
        }
      } finally { await browser.close(); }
    }
    console.log(`Admin content draft isolation passed: ${tested} cases (Chromium + WebKit)`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
