/** AdminPanel integration with real state/hooks/navigation and synthetic server data. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {renderToString} from 'react-dom/server.browser';
import {usePathname} from 'next/navigation';
import AdminPanel from './src/app/admin/AdminPanel';
const slide={id:1,title:'Server slide',imageUrl:'/slide.png',tabletImageUrl:null,mobileImageUrl:null,popupImageUrl:null,popupTabletImageUrl:null,popupMobileImageUrl:null,popupTitle:null,popupText:null,linkUrl:null,sortOrder:1,isActive:true};
const news={id:1,title:'Server news',date:'2026-10-18',imageUrl:'/news.png',linkUrl:'',sortOrder:1,isActive:true};
window.calls=[];window.confirms=[];window.confirmResult=false;window.panelMounts=0;
window.confirm=(message)=>{window.confirms.push(message);return window.confirmResult;};
window.data={settings:{phone:'Old phone',email:'old@example.test',address:'Old address'},slides:{slides:[slide]},news:{news:[news]},'group-companies':{companies:[]},'brand-categories':{categories:[{id:7,key:'test',title:'Test category',sortOrder:1,isActive:true}],brands:[]},'price-groups':{groups:[]}};
window.fetch=async(url,init={})=>{
 const method=init.method||'GET',body=init.body?JSON.parse(init.body):null;
 window.calls.push({url,method,body});
 const endpoint=url.split('/')[3],id=Number(url.split('/')[4]);
 if(method==='GET')return Response.json(window.data[endpoint]);
 if(endpoint==='settings'){
  if(window.deferSettings)await new Promise(resolve=>window.resumeSettings=resolve);
  window.data.settings={...window.data.settings,...Object.fromEntries(Object.entries(body).map(([key,value])=>[key,typeof value==='string'?value.trim():value]))};
  return Response.json({ok:true,...window.data.settings});
 }
 if(endpoint==='logout')return Response.json({ok:true});
 const key=endpoint==='slides'?'slides':'news';
 window.data[endpoint][key]=window.data[endpoint][key].map(row=>row.id===id?{...row,...body,title:body.title.trim()}:row);
 return Response.json({ok:true,item:{...window.data[endpoint][key].find(row=>row.id===id),revision:'2'}});
};
const start=location.href;history.replaceState({},'', '/outside');history.pushState({},'',start);
function RoutedApp(){
 const pathname=usePathname(),[identity,setIdentity]=useState(41);
 window.switchIdentity=setIdentity;
 const session={role:'admin',sessionId:'fixture-session-'+identity,adminUserId:identity};
 window.fakeSession=session;
 window.renderSnapshot=()=>renderToString(<AdminPanel initialArea="site" initialSession={session}/>);
 return pathname==='/admin/site'?<AdminPanel key={identity} initialArea="site" initialSession={session}/>:<p data-testid="outside">Outside editor</p>;
}
createRoot(document.getElementById('root')).render(<RoutedApp/>);
`;

const siteContent = `
import React from 'react';
export function AdminSiteContent(props){
 window.contentProps=props;
 const{activeSection,phone,email,address,busy,onPhoneChange,onEmailChange,onAddressChange,onSaveInfo,slideAdmin,newsAdmin}=props;
 if(activeSection==='info')return <section>
  <input aria-label="Phone" value={phone} onChange={event=>onPhoneChange(event.target.value)}/>
  <input aria-label="Email" value={email} onChange={event=>onEmailChange(event.target.value)}/>
  <input aria-label="Address" value={address} onChange={event=>onAddressChange(event.target.value)}/>
  <button disabled={busy} onClick={()=>void onSaveInfo('phone')}>Save phone</button>
  <button disabled={busy} onClick={()=>void onSaveInfo('email')}>Save email</button>
 </section>;
 if(activeSection==='slider')return <section>{slideAdmin.slides.map(slide=><div key={slide.id}>
  <input aria-label={'Slide '+slide.id} value={slide.title} onChange={event=>slideAdmin.updateSlide(slide.id,{title:event.target.value})}/>
  <button disabled={busy} onClick={()=>void slideAdmin.saveSlide(slide)}>Save slide {slide.id}</button>
 </div>)}</section>;
 if(activeSection==='news')return <section>{newsAdmin.news.map(item=><div key={item.id}>
  <input aria-label={'News '+item.id} value={item.title} onChange={event=>newsAdmin.updateNews(item.id,{title:event.target.value})}/>
  <button disabled={busy} onClick={()=>void newsAdmin.saveNews(item)}>Save news {item.id}</button>
 </div>)}</section>;
 return <section>Other section</section>;
}
`;

const navigation = `
import {useMemo,useSyncExternalStore} from 'react';
const listeners=new Set();window.routerLog=[];
const subscribe=listener=>{listeners.add(listener);return()=>listeners.delete(listener);};
window.addEventListener('popstate',()=>{for(const listener of listeners)listener();});
const move=(url,kind)=>{window.routerLog.push({url,kind});history[kind==='push'?'pushState':'replaceState']({},'',url);for(const listener of listeners)listener();};
const router={replace:url=>move(url,'replace'),push:url=>move(url,'push'),refresh:()=>{}};
window.navigate=url=>router.push(url);
export const useRouter=()=>router;
export const usePathname=()=>useSyncExternalStore(subscribe,()=>location.pathname,()=>location.pathname);
export const useSearchParams=()=>{const query=useSyncExternalStore(subscribe,()=>location.search,()=>location.search);return useMemo(()=>new URLSearchParams(query),[query]);};
`;

type Call = { url: string; method: string; body: Record<string, unknown> | null };

async function main() {
  const root = path.resolve('.');
  const require = createRequire(path.join(root, 'package.json'));
  let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!modulePath) {
    try { modulePath = path.dirname(require.resolve('playwright/package.json')); }
    catch { modulePath = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const heavyChildren = new Set(['AdminDashboard', 'AnalogFinder', 'AdminClientDetailSection', 'AdminClientsSection', 'AdminTopDashboardCatalog', 'AdminTopDashboardSection', 'TopDashboardViewer', 'AdminWholesaleGateway']);
  const bundle = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'panel-fixture-boundaries', setup(plugin) {
      plugin.onResolve({ filter: /./ }, (args) => {
        const name = args.path.split('/').at(-1);
        if (args.path === 'next/navigation') return { path: 'navigation', namespace: 'fixture' };
        if (name === 'AdminSiteContent' || name === 'adminSessionClient' || name && heavyChildren.has(name)) return { path: name, namespace: 'fixture' };
        if (args.path.endsWith('.scss')) return { path: 'styles', namespace: 'fixture' };
      });
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => {
        if (args.path === 'navigation') return { contents: navigation, loader: 'tsx', resolveDir: root };
        if (args.path === 'AdminSiteContent') return { contents: siteContent, loader: 'tsx', resolveDir: root };
        if (args.path === 'adminSessionClient') return { contents: "export const fetchAdminSessionWithRetry=async()=>({authenticated:true,...window.fakeSession});export const normalizeSessionRole=role=>role;", loader: 'js' };
        if (args.path === 'styles') return { contents: 'export default new Proxy({}, {get:(_,key)=>String(key)});', loader: 'js' };
        return { contents: `export function ${args.path}(){return null;}`, loader: 'js' };
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
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        for (const scenario of ['settings-isolation', 'typing-during-save', 'sections', 'cancel-users', 'cancel-back', 'cancel-logout', 'history-drafts', 'logout-clears', 'user-isolation', 'ssr-clean']) {
          const page = await browser.newPage();
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(`${origin}/admin/site?section=info`);
          await page.waitForFunction('window.contentProps && !window.contentProps.busy');
          assert.equal(await page.getByText('Есть несохранённые изменения.', { exact: true }).count(), 0, 'hydration is not a user edit');
          assert.equal(await page.evaluate('window.contentProps.brandAdmin.brandDraft.categoryId'), 7, 'default brand category hydrated cleanly');
          assert.equal(await page.getByText(/Не сохранено:/).count(), 0);
          assert.equal((await page.evaluate('window.calls') as Call[]).length, 6, 'only six initial reads');

          if (scenario === 'settings-isolation') {
            await page.getByLabel('Phone', { exact: true }).fill(' New phone ');
            await page.getByLabel('Email', { exact: true }).fill('draft@example.test');
            await page.getByRole('button', { name: 'Save phone', exact: true }).click();
            await page.waitForFunction('!window.contentProps.busy && window.contentProps.phone === "New phone"');
            assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'draft@example.test');
            const calls = await page.evaluate('window.calls') as Call[];
            assert.equal(calls.length, 7);
            assert.deepEqual(calls[6], { url: '/api/admin/settings', method: 'PUT', body: { phone: ' New phone ' } });
            assert.equal(await page.getByText('Есть несохранённые изменения.', { exact: true }).count(), 1);
          } else if (scenario === 'typing-during-save') {
            await page.evaluate('window.deferSettings=true');
            await page.getByLabel('Phone', { exact: true }).fill('Submitted phone');
            await page.getByRole('button', { name: 'Save phone', exact: true }).click();
            await page.waitForFunction('typeof window.resumeSettings === "function"');
            await page.getByLabel('Phone', { exact: true }).fill('Newer typing');
            await page.evaluate('window.deferSettings=false;window.resumeSettings()');
            await page.waitForFunction('!window.contentProps.busy');
            assert.equal(await page.getByLabel('Phone', { exact: true }).inputValue(), 'Newer typing');
            assert.equal(await page.getByText('Есть несохранённые изменения.', { exact: true }).count(), 1);
            await page.getByRole('button', { name: 'Save phone', exact: true }).click();
            await page.waitForFunction('!window.contentProps.busy && window.data.settings.phone === "Newer typing"');
            assert.equal(await page.getByText('Есть несохранённые изменения.', { exact: true }).count(), 0);
          } else if (scenario === 'sections') {
            await page.getByRole('button', { name: /^Слайдер/ }).click();
            await page.getByLabel('Slide 1', { exact: true }).fill('Keep slider draft');
            await page.getByRole('button', { name: /^Новости/ }).click();
            await page.getByLabel('News 1', { exact: true }).fill(' Saved news ');
            await page.getByRole('button', { name: 'Save news 1', exact: true }).click();
            await page.waitForFunction('!window.contentProps.busy && window.contentProps.newsAdmin.news[0].title === "Saved news"');
            await page.getByRole('button', { name: /^Слайдер/ }).click();
            assert.equal(await page.getByLabel('Slide 1', { exact: true }).inputValue(), 'Keep slider draft');
            assert.equal(await page.evaluate('window.confirms.length'), 0, 'section changes keep drafts and need no discard prompt');
            assert.equal(await page.getByRole('button', { name: /^Слайдер/ }).getByText('Не сохранено: 1').count(), 1);
            const calls = await page.evaluate('window.calls') as Call[];
            assert.equal(calls.length, 7, 'section navigation never reruns all initial GETs');
            assert.deepEqual(calls.slice(6).map((call) => [call.method, call.url]), [['PUT', '/api/admin/news/1']]);
            assert.equal(new URL(page.url()).searchParams.get('section'), 'slider');
          } else if (['history-drafts', 'logout-clears', 'user-isolation', 'ssr-clean'].includes(scenario)) {
            await page.getByLabel('Email', { exact: true }).fill('Private unsaved email');
            await page.getByRole('button', { name: /^Новости/ }).click();
            await page.getByLabel('News 1', { exact: true }).fill('Private unsaved news');
            if (scenario === 'ssr-clean') {
              const html = await page.evaluate('window.renderSnapshot()') as string;
              assert.doesNotMatch(html, /Private unsaved|Не сохранено:|Есть несохранённые изменения/);
              assert.equal(await page.getByLabel('News 1', { exact: true }).inputValue(), 'Private unsaved news', 'server render cannot mutate mounted drafts');
            } else if (scenario === 'history-drafts') {
              await page.evaluate('history.back()');
              await page.getByTestId('outside').waitFor();
              assert.equal(await page.getByRole('heading', { name: 'Управление сайтом' }).count(), 0, 'editor actually unmounted');
              await page.evaluate('window.data.settings.phone="Fresh server phone";window.data.settings.email="fresh@example.test";window.data.news.news[0].title="Fresh server news";history.forward()');
              await page.getByLabel('News 1', { exact: true }).waitFor();
              await page.waitForFunction('!window.contentProps.busy');
              assert.equal(await page.getByLabel('News 1', { exact: true }).inputValue(), 'Private unsaved news');
              await page.getByRole('button', { name: /^Информация/ }).click();
              assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'Private unsaved email');
              assert.equal(await page.getByLabel('Phone', { exact: true }).inputValue(), 'Fresh server phone', 'untouched field receives fresh server value');
              assert.equal(await page.getByText('Есть несохранённые изменения.', { exact: true }).count(), 1);
              assert.equal(await page.getByRole('button', { name: /^Новости/ }).getByText('Не сохранено: 1').count(), 1);
              assert.equal(await page.evaluate('window.confirms.length'), 0, 'native traversal is never intercepted');
              assert.equal((await page.evaluate('window.calls') as Call[]).length, 12, 'remount reads fresh server state once');
            } else if (scenario === 'logout-clears') {
              await page.evaluate('window.confirmResult=true');
              await page.getByRole('button', { name: 'Выйти', exact: true }).click();
              await page.getByTestId('outside').waitFor();
              await page.evaluate('window.navigate("/admin/site?section=info")');
              await page.getByLabel('Email', { exact: true }).waitFor();
              await page.waitForFunction('!window.contentProps.busy');
              assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'old@example.test');
              assert.equal(await page.getByText('Есть несохранённые изменения.', { exact: true }).count(), 0);
              await page.getByRole('button', { name: /^Новости/ }).click();
              assert.equal(await page.getByLabel('News 1', { exact: true }).inputValue(), 'Server news');
              assert.equal((await page.evaluate('window.calls') as Call[]).filter((call) => call.url === '/api/admin/logout').length, 1);
            } else {
              await page.evaluate('window.switchIdentity(42)');
              await page.waitForFunction('window.fakeSession.adminUserId===42 && !window.contentProps.busy');
              assert.equal(await page.getByLabel('News 1', { exact: true }).inputValue(), 'Server news', 'another account cannot read cached news draft');
              await page.getByRole('button', { name: /^Информация/ }).click();
              assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'old@example.test', 'another account cannot read cached contact draft');
              assert.equal(await page.getByText('Есть несохранённые изменения.', { exact: true }).count(), 0);
              await page.evaluate('window.switchIdentity(41)');
              await page.waitForFunction('window.fakeSession.adminUserId===41 && !window.contentProps.busy');
              assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'Private unsaved email', 'original account retains its separate workspace');
            }
          } else {
            await page.getByLabel('Email', { exact: true }).fill('Keep before leaving');
            const routerBefore = await page.evaluate('window.routerLog.length');
            const name = scenario === 'cancel-users' ? /^Пользователи и доступы/ : scenario === 'cancel-back' ? 'Вернуться в панель управления' : 'Выйти';
            await page.getByRole('button', { name }).click();
            assert.equal(await page.evaluate('window.confirms.length'), 1);
            assert.equal(await page.evaluate('window.routerLog.length'), routerBefore, 'cancel prevents navigation');
            assert.equal(await page.getByLabel('Email', { exact: true }).inputValue(), 'Keep before leaving');
            assert.equal((await page.evaluate('window.calls') as Call[]).length, 6, 'cancel prevents logout request too');
            assert.equal(await page.getByText('Есть несохранённые изменения.', { exact: true }).count(), 1);
          }
          await page.close(); tested++;
        }
      } finally { await browser.close(); }
    }
    console.log(`AdminPanel draft integration passed: ${tested} cases (Chromium + WebKit)`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
