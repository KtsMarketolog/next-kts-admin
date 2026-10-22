/** Draft isolation acceptance against synthetic content APIs, never production. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const fixture = `
import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useAdminBrandPortfolio} from './src/features/admin/model/useAdminBrandPortfolio';
import {useAdminPriceGroups} from './src/features/admin/model/useAdminPriceGroups';
const category=(id,title)=>({id,revision:'1',key:'cat'+id,title,sortOrder:id,isActive:true});
const brand=(id,categoryId,name)=>({id,revision:'1',categoryId,name,imageUrl:'/'+id+'.png',iconKey:'',sortOrder:id,isActive:true});
window.server={categories:[category(1,'One'),category(2,'Two')],brands:[brand(1,1,'First'),brand(2,2,'Second')],groups:[{title:'First',imageUrl:'/first.png',productCount:1},{title:'Second',imageUrl:'/second.png',productCount:2}]};
window.calls=[];window.refreshes=0;window.confirm=()=>true;
window.fetch=async(url,init={})=>{
 const method=init.method||'GET',body=init.body?JSON.parse(init.body):null;
 window.calls.push({url,method,body});
 if(method==='GET'){
  if(window.pauseRead)await new Promise(resolve=>{window.releaseRead=resolve});
  if(window.failRead)return Response.json({error:'offline'},{status:503});
  return Response.json(url==='/api/admin/price-groups'?{groups:window.server.groups}:window.server);
 }
 if(url==='/api/admin/brand-categories/reorder'){
  if(window.pauseOrder)await new Promise(resolve=>{window.releaseOrder=resolve});
  if(window.orderFailure==='rejected')return Response.json({error:'Order rejected'},{status:500});
  if(window.orderFailure==='conflict')return Response.json({error:'Collection changed'},{status:409});
  window.server.categories=window.server.categories.map(row=>({...row,sortOrder:body.items.find(item=>item.id===row.id).sortOrder}));
  const items=window.orderFailure==='malformed'?body.items.slice(0,1):window.orderFailure==='duplicate'?[body.items[0],body.items[0]]:body.items;
  return Response.json({ok:true,items,warnings:window.orderFailure==='warning'?[{code:'cache',message:'Cache refresh pending'}]:undefined});
 }
 const categoryMatch=url.match(/brand-categories\\/(\\d+)$/),brandMatch=url.match(/brands\\/(\\d+)$/);
 if(method==='PUT'&&window.pauseWrite)await new Promise(resolve=>{window.releaseWrite=resolve});
 if(method==='PUT'&&categoryMatch){
  const id=Number(categoryMatch[1]);
  if(window.failCategory===id)return Response.json({error:'not saved'},{status:500});
  window.server.categories=window.server.categories.map(row=>row.id===id?{...row,...body,title:body.title?.trim()??row.title}:row);
 }else if(method==='PUT'&&brandMatch){window.server.brands=window.server.brands.map(row=>row.id===Number(brandMatch[1])?{...row,...body,name:body.name.trim()}:row);
 }else if(method==='PUT'){window.server.groups=window.server.groups.map(row=>row.title===body.title?{...row,imageUrl:body.imageUrl.trim()}:row);
 }else if(method==='POST'){
  const id=3;
  if(url==='/api/admin/brands')window.server.brands.push({...body,id,name:body.name.trim()});
  else window.server.categories.push({...body,id,title:body.title.trim(),key:body.key||body.title.trim().toLowerCase()});
  return Response.json({id});
 }else if(method==='DELETE'&&categoryMatch){const id=Number(categoryMatch[1]);window.server.categories=window.server.categories.filter(row=>row.id!==id);window.server.brands=window.server.brands.filter(row=>row.categoryId!==id);
 }else if(method==='DELETE'){window.server.brands=window.server.brands.filter(row=>row.id!==Number(brandMatch[1]));}
 if(method==='PUT'&&(brandMatch||categoryMatch)) {
  const item=(brandMatch?window.server.brands:window.server.categories).find(row=>row.id===Number((brandMatch||categoryMatch)[1]));
  item.revision=String(Number(item.revision)+1);
  return Response.json({ok:true,item});
 }
 return Response.json({ok:true});
};
function App(){
 const[busy,setBusy]=useState(false),[status,showStatus]=useState('');const actionLock=useRef(false);
 const options={setBusy,showStatus,actionLock,reloadAdminData:async()=>{window.refreshes++;throw new Error('Global reload is forbidden')}};
 const brands=useAdminBrandPortfolio(options),prices=useAdminPriceGroups(options);
 useEffect(()=>{brands.setBrandCategories(window.server.categories);brands.setBrands(window.server.brands);brands.initializeBrandDraft(1);prices.setPriceGroups(window.server.groups)},[]);
 window.model={brands,prices};
 return <main><div id="busy">{String(busy)}</div><div id="status">{status}</div><pre id="state">{JSON.stringify({categories:brands.brandCategories,brands:brands.brands,brandDraft:brands.brandDraft,categoryDraft:brands.brandCategoryDraft,brandDirty:brands.dirtyCount,priceDirty:prices.dirtyCount,prices:prices.priceGroups})}</pre></main>;
}
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
        for (const scenario of ['save-brand', 'late-brand', 'create-brand', 'create-category', 'reorder', 'rejected-reorder', 'conflict-reorder', 'malformed-reorder', 'duplicate-reorder', 'late-reorder', 'warning-reorder', 'reorder-clean', 'rejected-reorder-clean', 'delete-category', 'save-price', 'saved-refresh-failed']) {
          const page = await browser.newPage();
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(origin);
          await page.waitForFunction(() => JSON.parse(document.querySelector('#state')!.textContent!).brands.length === 2);
          assert.equal(JSON.parse(await page.locator('#state').innerText()).brandDirty, 0, 'automatic category selection is not an edit');
          const cleanReorder = scenario.endsWith('-clean');
          if (!cleanReorder) await page.evaluate(() => {
            const w = window as any;
            w.model.brands.updateBrand(1, { name: ' Saved first ' });
            w.model.brands.updateBrand(2, { name: 'Keep second draft' });
            w.model.brands.updateBrandCategory(1, { title: 'Keep category draft' });
            w.model.prices.updatePriceGroup('First', { imageUrl: ' /new-first.png ' });
            w.model.prices.updatePriceGroup('Second', { imageUrl: '/keep-second.png' });
          });
          if (!cleanReorder) await page.waitForFunction(() => JSON.parse(document.querySelector('#state')!.textContent!).brandDirty === 3);
          if (scenario === 'save-brand' || scenario === 'saved-refresh-failed') {
            await page.evaluate(async (fail: boolean) => { const w = window as any; w.failRead = fail; await w.model.brands.saveBrand(w.model.brands.brands[0]); }, scenario === 'saved-refresh-failed');
          } else if (scenario === 'late-brand') {
            await page.evaluate(() => { const w = window as any; w.pauseWrite = true; void w.model.brands.saveBrand(w.model.brands.brands[0]); });
            await page.waitForFunction(() => Boolean((window as any).releaseWrite));
            await page.evaluate(() => { const w = window as any; w.model.brands.updateBrand(1, { name: 'Typed after save' }); w.releaseWrite(); });
          } else if (scenario === 'create-brand') {
            await page.evaluate(() => { const w = window as any; w.model.brands.setBrandDraft({ ...w.model.brands.brandDraft, name: 'New brand', imageUrl: '/created.png' }); });
            await page.waitForFunction(() => JSON.parse(document.querySelector('#state')!.textContent!).brandDraft.name === 'New brand');
            await page.evaluate(() => { const w = window as any; w.pauseRead = true; void w.model.brands.createBrand(); });
            await page.waitForFunction(() => Boolean((window as any).releaseRead));
            await page.evaluate(() => { const w = window as any; w.model.brands.setBrandDraft({ ...w.model.brands.brandDraft, name: 'Next brand draft' }); w.releaseRead(); });
          } else if (scenario === 'create-category') {
            await page.evaluate(() => { const w = window as any; w.model.brands.setBrandCategoryDraft({ ...w.model.brands.brandCategoryDraft, title: ' New category ' }); });
            await page.waitForFunction(() => JSON.parse(document.querySelector('#state')!.textContent!).categoryDraft.title === ' New category ');
            await page.evaluate(async () => { await (window as any).model.brands.createBrandCategoryItem(); });
          } else if (scenario.includes('reorder')) {
            if (scenario === 'late-reorder') {
              await page.evaluate(() => { const w = window as any; w.pauseOrder = true; void w.model.brands.moveBrandCategory(2, 1); void w.model.brands.moveBrandCategory(2, 1); });
              await page.waitForFunction(() => Boolean((window as any).releaseOrder));
              assert.deepEqual(JSON.parse(await page.locator('#state').innerText()).categories.map((row: { id: number }) => row.id), [1, 2], 'no optimistic order change');
              await page.evaluate(() => { const w = window as any; w.model.brands.updateBrandCategory(1, { title: 'Typed during reorder' }); w.releaseOrder(); });
            } else {
              await page.evaluate(async (mode: string) => { const w = window as any; w.orderFailure = mode; await Promise.all([w.model.brands.moveBrandCategory(2, 1), w.model.brands.moveBrandCategory(2, 1)]); }, scenario.split('-')[0]);
            }
          } else if (scenario === 'delete-category') {
            await page.evaluate(() => { const w = window as any; w.model.brands.updateBrand(1, { categoryId: 2 }); w.model.brands.updateBrand(2, { categoryId: 1 }); });
            await page.waitForFunction(() => JSON.parse(document.querySelector('#state')!.textContent!).brands[0].categoryId === 2);
            await page.evaluate(async () => { await (window as any).model.brands.deleteBrandCategoryItem(1); });
          } else {
            await page.evaluate(async () => { const w = window as any; await w.model.prices.savePriceGroup(w.model.prices.priceGroups[0]); });
          }
          await page.waitForFunction(() => document.querySelector('#busy')!.textContent === 'false');
          const state = JSON.parse(await page.locator('#state').innerText());
          const calls: Array<{ method: string; body: Record<string, unknown> }> = await page.evaluate(() => (window as any).calls);
          assert.equal(await page.evaluate(() => (window as any).refreshes), 0, `${scenario}: no global reload`);
          assert.equal(state.brands.find((row: { id: number }) => row.id === 2).name, cleanReorder ? 'Second' : 'Keep second draft');
          assert.equal(state.prices[1].imageUrl, cleanReorder ? '/second.png' : '/keep-second.png');
          if (scenario === 'save-brand') { assert.equal(state.brands[0].name, 'Saved first'); assert.equal(state.brandDirty, 2); }
          if (scenario === 'late-brand') { assert.equal(state.brands[0].name, 'Typed after save'); assert.equal(state.brandDirty, 3); }
          if (scenario === 'create-brand') { assert.equal(state.brands.length, 3); assert.equal(state.brandDraft.name, 'Next brand draft'); assert.equal(state.brandDraft.imageUrl, ''); assert.equal(state.brandDraft.categoryId, 1); }
          if (scenario === 'create-category') { assert.equal(state.categories.length, 3); assert.equal(state.categoryDraft.title, ''); assert.equal(state.categories.find((row: { id: number }) => row.id === 3).title, 'New category'); }
          if (scenario.includes('reorder')) {
            assert.equal(calls.length, 1, 'one atomic request even for double click');
            assert.deepEqual(calls[0].body, { items: [{ id: 2, sortOrder: 1 }, { id: 1, sortOrder: 2 }] });
            const acknowledged = ['reorder', 'reorder-clean', 'late-reorder', 'warning-reorder'].includes(scenario);
            assert.deepEqual(state.categories.map((row: { id: number }) => row.id), acknowledged ? [2, 1] : [1, 2]);
            assert.equal(state.categories.find((row: { id: number }) => row.id === 1).title, cleanReorder ? 'One' : scenario === 'late-reorder' ? 'Typed during reorder' : 'Keep category draft');
            assert.equal(await page.evaluate(() => (window as any).server.categories.find((row: any) => row.id === 1).title), 'One');
            if (['malformed-reorder', 'duplicate-reorder'].includes(scenario)) assert.match(await page.locator('#status').innerText(), /не подтвердил/);
            if (scenario === 'warning-reorder') assert.match(await page.locator('#status').innerText(), /Cache refresh pending/);
            assert.equal(state.brandDirty, cleanReorder ? 0 : 3, 'order operation never changes content dirty state');
          }
          if (scenario === 'delete-category') { assert.deepEqual(state.brands.map((row: { id: number }) => row.id), [2]); assert.equal(state.brands[0].categoryId, 1); assert.equal(state.categories.length, 1); }
          if (scenario === 'save-price') { assert.equal(state.prices[0].imageUrl, '/new-first.png'); assert.equal(state.priceDirty, 1); assert.equal(state.brandDirty, 3); }
          if (scenario === 'saved-refresh-failed') { assert.equal(state.brands[0].name, 'Saved first'); assert.equal(calls.length, 1, 'no follow-up read after saving'); }
          await page.close(); tested++;
        }
      } finally { await browser.close(); }
    }
    console.log(`Brand/category/price draft isolation passed: ${tested} browser cases (Chromium + WebKit)`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
