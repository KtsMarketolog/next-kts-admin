/** Real Gateway/editor regressions with synthetic HTTP data only; never accesses production or a database. */
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AdminWholesaleGateway} from './src/features/admin/wholesale/AdminWholesaleGateway';
const params=new URLSearchParams(location.search);
window.calls=[]; window.navigations=[]; window.pending=[];
window.fault=params.get('fault')||''; window.writeFault=''; window.hold=''; window.catalogMode=params.get('catalog')||'normal';
window.priceRevision='7';window.pricePatch={};
window.navigate=href=>{history.pushState(null,'',href);window.dispatchEvent(new Event('fixture:navigate'));};
window.EventSource=class{addEventListener(){}removeEventListener(){}close(){}};
window.fixtureItems=[
  {productId:101,variantId:null,customWholesalePrice:'81.25',discountPercent:'5',priceManuallyChanged:true,visible:true,sortOrder:7},
  {productId:102,variantId:12,customWholesalePrice:'42.00',discountPercent:null,priceManuallyChanged:true,visible:false,sortOrder:11},
  {productId:102,variantId:13,customWholesalePrice:'37.19',discountPercent:'3',priceManuallyChanged:true,visible:true,sortOrder:19},
  {productId:997,variantId:null,customWholesalePrice:'99.05',discountPercent:null,priceManuallyChanged:false,visible:true,sortOrder:70},
  {productId:998,variantId:71,customWholesalePrice:'51.37',discountPercent:'12.5',priceManuallyChanged:true,visible:true,sortOrder:73},
  {productId:999,variantId:null,customWholesalePrice:'0',discountPercent:'0',priceManuallyChanged:true,visible:false,sortOrder:91},
];
const managers=[{id:7,name:'Synthetic MR',login:'synthetic-mr',role:'manager'}, {id:8,name:'Synthetic MS',login:'synthetic-ms',role:'support_manager'}]
 .map(row=>({...row,revision:'1',email:'',phone:'',supportManagerId:null,supportManagerName:'',isActive:true,canAccessTopDashboard:false,canManageTopDashboard:false,priceListCount:1}));
const companies=[{id:5,title:'Synthetic company',managerId:7,supportManagerId:8,isActive:true}];
const product=(id,variants)=>({id,title:'Synthetic product '+id,sku:'S-'+id,model:'',description:'',imageUrl:null,priceGroup:'Synthetic group',priceGroupImageUrl:null,priceEur:null,priceRub:'100.00',priceCny:null,generalDiscount:null,manualDiscount:null,manualDiscountRop:null,stock:2,unit:'шт.',isExpected:false,stockUpdatedAt:null,variants});
const variant=(id)=>({id,title:id===null?'Base':'Variant '+id,retailPrice:'120.00',wholesalePrice:'100.00'});
const categories=[{id:1,title:'Synthetic category',products:[product(101,[variant(null)]),product(102,[variant(12),variant(14)]),product(103,[variant(null)])]}];
const priceList=id=>({id,revision:window.priceRevision,title:'Synthetic price '+id,clientCompanyId:5,clientName:'Synthetic company',token:'synthetic-token-'+id,validUntil:'',comment:'preserved comment',workflowStatus:'not_sent',showRetailPrices:false,showStock:true,showStockText:false,isActive:true,managerId:7,supportManagerId:8,items:window.fixtureItems,priceGroupStockSettings:[{priceGroup:'Inactive group',showStock:true,showStockText:false}],...window.pricePatch});
window.fetch=async(input,init={})=>{
  const url=String(input),method=init.method||'GET';
  window.calls.push({url,method,body:init.body?JSON.parse(init.body):null});
  if(method!=='GET'){
    if(window.writeFault==='reject')throw new TypeError('Synthetic save interruption');
    if(window.writeFault==='headers')return new Promise(()=>{});
    if(window.writeFault==='body')return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));}}));
    if(window.writeFault==='http')return Response.json({error:'Synthetic save unavailable'},{status:503});
    if(method==='PUT'&&JSON.parse(init.body).expectedRevision!==window.priceRevision)return Response.json({error:'Данные уже изменены другим пользователем. Обновите данные и повторите изменения.',code:'RECORD_VERSION_CONFLICT'},{status:409});
    return Response.json({ok:true,id:41,revision:String(Number(window.priceRevision)+1)});
  }
  const target=url==='/api/admin/wholesale/catalog'?'catalog':url==='/api/admin/clients'?'clients':/^\\/api\\/admin\\/wholesale\\/price-lists\\/\\d+$/.test(url)?'detail':'';
  const id=target==='detail'?Number(url.split('/').pop()):null;
  const fault=window.fault;
  let payload=target==='catalog'?{categories:window.catalogMode==='empty'?[]:categories}:target==='clients'?{companies}:target==='detail'?{priceList:priceList(id)}:
    url==='/api/admin/wholesale/managers'?{managers}:url==='/api/admin/wholesale/price-lists'?{priceLists:[]}:
    url==='/api/admin/session'?{manager:managers[0]}:null;
  if(payload===null)throw new Error('Unmocked API: '+url);
  if(fault===target+'-shape')payload={unexpected:[]};
  if(fault==='catalog-nested'&&target==='catalog')payload={categories:[{id:1,title:'Broken category',products:null}]};
  if(fault==='detail-items'&&target==='detail')payload={priceList:{...priceList(id),items:null}};
  if(fault==='detail-id'&&target==='detail')payload={priceList:priceList(id+1)};
  if(fault==='detail-revision'&&target==='detail')payload={priceList:{...priceList(id),revision:undefined}};
  const captured=JSON.stringify(payload);
  const finish=()=>{
    if(fault===target+'-reject')throw new TypeError('Synthetic network interruption');
    if(fault===target+'-http')return Response.json({error:'Synthetic unavailable'},{status:503});
    if(fault===target+'-json')return new Response('{invalid',{headers:{'Content-Type':'application/json'}});
    return new Response(captured,{headers:{'Content-Type':'application/json'}});
  };
  // Deliberately ignore AbortSignal: a late response must also be rejected by Gateway identity guards.
  if(window.hold&&(window.hold===target||(window.hold==='detail:'+id&&target==='detail')))return new Promise((resolve,reject)=>window.pending.push({target,id,release(){try{resolve(finish());}catch(error){reject(error);}}}));
  return finish();
};
createRoot(document.getElementById('root')).render(<AdminWholesaleGateway canManageWholesale={true} onBack={()=>{}}/>);
`;

const navigationFixture = `
import {useMemo,useSyncExternalStore} from 'react';
const subscribe=listener=>{window.addEventListener('fixture:navigate',listener);return()=>window.removeEventListener('fixture:navigate',listener);};
const snapshot=()=>location.pathname+location.search;
const useLocation=()=>useSyncExternalStore(subscribe,snapshot);
const router={push:href=>window.navigations.push(href),replace:href=>window.navigations.push(href),refresh(){},back(){}};
export const useRouter=()=>router;
export const usePathname=()=>useLocation().split('?')[0];
export const useSearchParams=()=>{const current=useLocation();return useMemo(()=>new URLSearchParams(current.split('?')[1]||''),[current]);};
`;

async function main() {
  const root = path.resolve('.');
  const require = createRequire(path.join(root, 'package.json'));
  let runtime = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!runtime) {
    try { runtime = path.dirname(require.resolve('playwright/package.json')); }
    catch { runtime = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const bundle = await build({
    absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'synthetic-boundaries', setup(plugin) {
      plugin.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: navigationFixture, loader: 'js', resolveDir: root }));
      // This suite tests data safety, not style; keep every real React editor component.
      plugin.onLoad({ filter: /\.module\.scss$/ }, () => ({ contents: 'export default new Proxy({}, {get: (_, key) => String(key)});', loader: 'js' }));
    } }],
  });
  const server = createServer((request, response) => {
    if (request.url === '/app.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  let engines = 0;
  try {
    for (const engineName of ['chromium', 'webkit']) {
      const engine = playwright[engineName];
      try { await access(engine.executablePath()); } catch { continue; }
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
        page.setDefaultTimeout(5_000);
        await page.clock.install();
        const errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
        const save = page.getByRole('button', { name: 'Сохранить прайс', exact: true });
        const title = page.getByLabel('Название прайса', { exact: true });
        const writes = () => page.evaluate('window.calls.filter(call=>call.method==="PUT"||call.method==="POST")');
        const ready = async (expected = 'Synthetic price 41') => {
          await title.waitFor();
          assert.equal(await title.inputValue(), expected);
          assert.equal(await save.isEnabled(), true, 'fully loaded editor enables save');
          assert.equal(await page.getByRole('alert').count(), 0);
        };
        const blocked = async () => {
          await page.getByRole('alert').waitFor();
          assert.ok((await save.count()) === 0 || await save.isDisabled(), 'failed load must not expose enabled save');
          assert.equal(await title.count(), 0, 'failed load does not present a fabricated or stale editor');
          assert.equal((await writes()).length, 0, 'failed reads never send a save request');
        };

        // Each failure previously allowed an empty, fabricated or stale editor to become saveable.
        for (const fault of [
          'catalog-http', 'catalog-reject', 'catalog-json', 'catalog-shape', 'catalog-nested',
          'clients-http', 'clients-reject', 'clients-json', 'clients-shape',
          'detail-http', 'detail-reject', 'detail-json', 'detail-shape', 'detail-items', 'detail-id', 'detail-revision',
        ]) {
          await page.goto(`${origin}/admin/wholesale/41/edit?fault=${fault}`);
          await blocked();
          await page.clock.fastForward(3_001);
          await blocked(); // Unlike the old two-second status toast, the load failure stays visible.
          await page.evaluate('window.fault=""');
          await page.getByRole('button', { name: /Повторить/ }).click();
          await ready();
        }
        console.log(`${engineName}: 16 HTTP/network/JSON/shape/revision failures fail closed and retry recovers`);

        // Creation needs the same protection; a successful empty response is not an error response.
        await page.goto(`${origin}/admin/wholesale/create?fault=catalog-http`);
        await blocked();
        await page.evaluate('window.fault=""');
        await page.getByRole('button', { name: /Повторить/ }).click();
        await title.waitFor();
        await title.fill('Synthetic newly created price');
        await page.getByLabel(/^Клиент \/ компания/).selectOption('5');
        await save.click();
        await page.waitForFunction('window.calls.some(call=>call.method==="POST")');
        assert.equal((await writes())[0].body.items.length, 4);

        await page.goto(`${origin}/admin/wholesale/41/edit?catalog=empty`);
        await ready();
        await page.getByText(/Каталог загружен: активных позиций нет/).waitFor();
        await save.click();
        await page.waitForFunction('window.calls.some(call=>call.method==="PUT")');
        assert.deepEqual((await writes())[0].body.items, [], 'valid empty catalogue sends no item updates; merge-only server preserves stored rows');

        // An inactive product/variant must retain visibility, manual prices, discounts and order.
        await page.goto(`${origin}/admin/wholesale/41/edit`);
        await ready();
        await title.fill('Renamed without losing hidden products');
        await save.click();
        await page.waitForFunction('window.calls.some(call=>call.method==="PUT")');
        const written = (await writes())[0];
        assert.equal(written.url, '/api/admin/wholesale/price-lists/41');
        assert.equal(written.body.title, 'Renamed without losing hidden products');
        assert.equal(written.body.items.length, 4, 'only four active catalogue keys are updated');
        assert.deepEqual(written.body.items.map((item: { productId: number; variantId: number | null }) => `${item.productId}:${item.variantId ?? 'base'}`).sort(), ['101:base', '102:12', '102:14', '103:base']);
        assert.deepEqual(written.body.items.find((item: { productId: number }) => item.productId === 101), await page.evaluate('window.fixtureItems.find(item=>item.productId===101)'));
        assert.equal(written.body.items.some((item: { productId: number; variantId: number }) => item.productId >= 997 || (item.productId === 102 && item.variantId === 13)), false, 'inactive legacy custom prices and inactive variants are not sent for normalization');
        assert.deepEqual(written.body.priceGroupStockSettings, { 'inactive group': { priceGroup: 'Inactive group', showStock: true, showStockText: false } });

        // Bulk product/group visibility and discounts must only edit displayed catalogue variants.
        await page.goto(`${origin}/admin/wholesale/41/edit`);
        await ready();
        await page.getByRole('button', { name: 'Раскрыть', exact: true }).click();
        await page.locator('article').filter({ hasText: 'Synthetic product 102' }).getByRole('button', { name: 'Убрать все позиции', exact: true }).click();
        await page.getByRole('button', { name: 'Убрать все', exact: true }).click();
        await page.locator('input[placeholder*="максимальная скидка"]').fill('10');
        await page.getByRole('button', { name: 'Рассчитать', exact: true }).click();
        await save.click();
        await page.waitForFunction('window.calls.some(call=>call.method==="PUT")');
        const bulkItems = (await writes())[0].body.items;
        assert.equal(bulkItems.some((item: { productId: number; variantId: number }) => item.productId >= 997 || (item.productId === 102 && item.variantId === 13)), false, 'bulk edits never submit hidden product or variant updates');
        assert.ok(bulkItems.every((item: { visible: boolean; discountPercent: string }) => item.visible === false && item.discountPercent === '10'), 'bulk edits still affect visible catalogue keys');

        for (const failure of ['http', 'reject', 'headers', 'body']) {
          await page.goto(`${origin}/admin/wholesale/41/edit`);
          await ready();
          await title.fill('Unsaved title retained after network failure');
          await page.evaluate(`window.writeFault=${JSON.stringify(failure)}`);
          await save.click();
          if (failure === 'headers' || failure === 'body') {
            assert.equal(await save.isDisabled(), true);
            await page.clock.fastForward(60_001);
          }
          await page.getByRole('alert').waitFor();
          await page.clock.fastForward(3_001);
          assert.equal(await save.isEnabled(), true, 'failed save releases its busy lock');
          assert.equal(await title.inputValue(), 'Unsaved title retained after network failure');
          assert.equal(await page.getByRole('alert').count(), 1, 'save failure persists until resolved');
          assert.equal(await page.evaluate('window.navigations.length'), 0, 'failed save does not navigate away');
          if (failure !== 'http') assert.match(await page.getByRole('alert').innerText(), /могло сохраниться/);
          await page.evaluate('window.writeFault=""');
          await save.click();
          await page.waitForFunction('window.navigations.length===1');
          assert.equal((await writes()).length, 2, 'successful explicit retry remains available');
        }

        // Another admin saves different prices while this editor has an unsaved comment.
        // A 409 must keep the draft and its original revision, not silently rebase it.
        await page.goto(`${origin}/admin/wholesale/41/edit`);
        await ready();
        const comment = page.getByLabel(/^Комментарий/);
        await title.fill('Unsaved local title');
        await comment.fill('Unsaved local comment');
        const readsBeforeConflict = await page.evaluate('window.calls.filter(call=>call.method==="GET"&&call.url==="/api/admin/wholesale/price-lists/41").length');
        await page.evaluate('window.priceRevision="8";window.pricePatch={title:"New server price",comment:"New server comment"};window.fixtureItems=window.fixtureItems.map(item=>item.productId===101?{...item,customWholesalePrice:"95.30"}:item)');
        await save.click();
        await page.getByRole('heading', { name: 'Прайс уже изменён другим пользователем' }).waitFor();
        assert.equal((await writes())[0].body.expectedRevision, '7');
        assert.equal((await writes())[0].body.items.find((item: { productId: number }) => item.productId === 101).customWholesalePrice, '81.25');
        assert.equal(await title.inputValue(), 'Unsaved local title');
        assert.equal(await comment.inputValue(), 'Unsaved local comment');
        assert.equal(await save.isDisabled(), true);
        assert.equal(await page.evaluate('window.navigations.length'), 0);
        await page.clock.fastForward(15_001);
        assert.equal(await page.evaluate('window.calls.filter(call=>call.method==="GET"&&call.url==="/api/admin/wholesale/price-lists/41").length'), readsBeforeConflict, 'background sync does not rebase the stale price revision');
        assert.equal(await title.inputValue(), 'Unsaved local title');
        assert.equal((await writes()).length, 1);

        const reload = page.getByRole('button', { name: 'Загрузить актуальные данные', exact: true });
        page.once('dialog', async (dialog: { type(): string; message(): string; dismiss(): Promise<void> }) => {
          assert.equal(dialog.type(), 'confirm');
          assert.match(dialog.message(), /несохранённые изменения/);
          await dialog.dismiss();
        });
        await reload.click();
        assert.equal(await title.inputValue(), 'Unsaved local title');
        assert.equal(await comment.inputValue(), 'Unsaved local comment');
        assert.equal(await page.evaluate('window.calls.filter(call=>call.method==="GET"&&call.url==="/api/admin/wholesale/price-lists/41").length'), readsBeforeConflict);
        page.once('dialog', async (dialog: { accept(): Promise<void> }) => { await dialog.accept(); });
        await reload.click();
        await ready('New server price');
        assert.equal(await comment.inputValue(), 'New server comment');
        await comment.fill('Local comment after explicit reload');
        await save.click();
        await page.waitForFunction('window.navigations.length===1');
        const rebased = (await writes())[1].body;
        assert.equal(rebased.expectedRevision, '8');
        assert.equal(rebased.title, 'New server price');
        assert.equal(rebased.comment, 'Local comment after explicit reload');
        assert.equal(rebased.items.find((item: { productId: number }) => item.productId === 101).customWholesalePrice, '95.30', 'explicit reload preserves the other administrator’s new price');
        console.log(`${engineName}: conflict keeps draft/version, blocks silent resave, and confirmed reload pairs fresh fields with fresh revision`);

        // A loaded editor must not remain saveable while a different route loads or fails.
        await page.goto(`${origin}/admin/wholesale/41/edit`);
        await ready();
        await page.evaluate('window.fault="detail-http";window.hold="detail:42";window.navigate("/admin/wholesale/42/edit")');
        await page.waitForFunction('window.pending.some(request=>request.id===42)');
        assert.ok((await save.count()) === 0 || await save.isDisabled(), 'new route loading cannot save old price');
        await page.evaluate('window.hold="";window.pending.shift().release()');
        await blocked();
        await page.evaluate('window.fault=""');
        await page.getByRole('button', { name: /Повторить/ }).click();
        await ready('Synthetic price 42');
        await save.click();
        await page.waitForFunction('window.calls.some(call=>call.method==="PUT")');
        assert.equal((await writes())[0].url, '/api/admin/wholesale/price-lists/42');

        // A late detail response for A cannot overwrite successfully loaded B even if abort is ignored.
        await page.goto(`${origin}/admin/wholesale/41/edit`);
        await ready();
        await page.evaluate('window.hold="detail:42";window.navigate("/admin/wholesale/42/edit")');
        await page.waitForFunction('window.pending.some(request=>request.id===42)');
        await page.evaluate('window.hold="";window.navigate("/admin/wholesale/43/edit")');
        await ready('Synthetic price 43');
        await page.evaluate('window.pending.shift().release()');
        await page.waitForTimeout(50);
        await ready('Synthetic price 43');
        await save.click();
        await page.waitForFunction('window.calls.some(call=>call.method==="PUT")');
        assert.equal((await writes())[0].url, '/api/admin/wholesale/price-lists/43');

        // The catalogue setter itself also needs route protection, not only the eventual editor setter.
        await page.goto(`${origin}/admin/wholesale/41/edit`);
        await ready();
        await page.evaluate('window.catalogMode="empty";window.hold="catalog";window.navigate("/admin/wholesale/42/edit")');
        await page.waitForFunction('window.pending.some(request=>request.target==="catalog")');
        await page.evaluate('window.catalogMode="normal";window.hold="";window.navigate("/admin/wholesale/43/edit")');
        await ready('Synthetic price 43');
        await page.getByRole('heading', { name: 'Synthetic group', exact: true }).waitFor();
        await page.evaluate('window.pending.shift().release()');
        await page.waitForTimeout(50);
        await ready('Synthetic price 43');
        assert.equal(await page.getByRole('heading', { name: 'Synthetic group', exact: true }).count(), 1, 'late empty catalogue cannot clear the active route');

        await page.goto(`${origin}/admin/wholesale/41/edit`);
        await ready();
        await page.evaluate('window.hold="catalog";window.navigate("/admin/wholesale/42/edit")');
        await page.waitForFunction('window.pending.some(request=>request.target==="catalog")');
        await page.clock.fastForward(60_001);
        await blocked();
        await page.evaluate('window.hold="";window.pending.shift().release()');
        await page.waitForTimeout(50);
        await blocked();
        await page.getByRole('button', { name: /Повторить/ }).click();
        await ready('Synthetic price 42');
        assert.deepEqual(errors, [], `${engineName}: no unhandled React/fetch errors`);
        console.log(`${engineName}: empty catalogue, inactive configuration, creation and route-race regressions passed`);
        await page.close();
        engines += 1;
      } finally { await browser.close(); }
    }
    assert.ok(engines > 0, 'No supported Playwright browser installed; this suite must not silently skip');
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
