/** Real AdminPanel, client editor and leave guard; all accounts/HTTP are synthetic. */
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
import {usePathname} from 'next/navigation';
import AdminPanel from './src/app/admin/AdminPanel';
window.calls=[];window.confirms=[];window.confirmResult=false;window.revision=1;window.saved=[];window.sessionValid=true;
window.confirm=message=>{window.confirms.push(message);return window.confirmResult;};
window.EventSource=class {addEventListener(){}close(){}};
const stamp=()=> '2026-10-23 00:00:00.'+String(window.revision).padStart(6,'0')+'+00';
const company=id=>({id,title:'Synthetic company '+id,email:'synthetic'+id+'@example.invalid',phone:'Original phone',note:'Original note',managerId:21,managerName:'Manager',supportManagerId:22,supportManagerName:'Support',requireTwoFactor:false,userCount:1,clientLogin:'synthetic'+id+'@example.invalid',clientUserId:id+20,passwordChangedAt:'2026-10-01T00:00:00Z',chatUnreadCount:0,isActive:true,archivedAt:null,createdAt:'2026-10-01T00:00:00Z',updatedAt:stamp()});
window.companies=[company(13),company(14)];
window.changeCompany=(id,patch)=>{window.revision++;window.companies=window.companies.map(item=>item.id===id?{...item,...patch,updatedAt:stamp()}:item);};
const siteData={settings:{phone:'',email:'',address:''},slides:{slides:[]},news:{news:[]},'group-companies':{companies:[]},'brand-categories':{categories:[],brands:[]},'price-groups':{groups:[]}};
window.fetch=async(url,init={})=>{
 const method=init.method||'GET',body=init.body?JSON.parse(init.body):null;
 window.calls.push({url,method,body});
 if(url.includes('/wholesale/managers'))return Response.json({managers:[{id:21,name:'Manager',role:'manager',isActive:true},{id:22,name:'Support',role:'support_manager',isActive:true}]});
 if(url.endsWith('/password'))return Response.json({password:'SyntheticDisplayed123'});
 if(url==='/api/admin/logout')return Response.json({ok:true});
 if(method==='GET'&&url.startsWith('/api/admin/clients'))return Response.json({companies:structuredClone(window.companies.filter(item=>url.includes('scope=all')||Boolean(item.archivedAt)===url.includes('scope=archived'))),canPermanentlyDelete:false});
 if(method==='GET'){
  const endpoint=url.split('/')[3];if(siteData[endpoint])return Response.json(siteData[endpoint]);
  throw Error('Unexpected fixture read '+url);
 }
 if(method==='POST'&&url==='/api/admin/clients'){
  window.revision++;const created={...company(15),...body,updatedAt:stamp()};delete created.password;window.companies.push(created);window.saved.push({id:15});
  return Response.json({saved:true,company:created,warnings:[]});
 }
 if(method!=='PUT'||!/^\\/api\\/admin\\/clients\\/\\d+$/.test(url))throw Error('Unexpected fixture write '+method+' '+url);
 const id=Number(url.split('/').pop()),current=window.companies.find(item=>item.id===id);
 if(!current||body.expectedUpdatedAt!==current.updatedAt)return Response.json({saved:false,error:'Данные уже изменены другим пользователем. Обновите карточку.'},{status:409});
 if(window.deferSave)await new Promise(resolve=>window.resumeSave=resolve);
 const {password,expectedUpdatedAt,...fields}=body;window.changeCompany(id,fields);
 const saved=window.companies.find(item=>item.id===id);window.saved.push({id,password,expectedUpdatedAt});
 return Response.json({saved:true,company:saved,warnings:[]});
};
const initial=location.href;history.replaceState({},'', '/outside');history.pushState({},'',initial);
function RoutedApp(){
 const pathname=usePathname(),[identity,setIdentity]=useState(41),[sessionVersion,setSessionVersion]=useState(1);
 window.switchIdentity=setIdentity;window.switchSession=setSessionVersion;
 const session={role:'admin',sessionId:'fixture-'+identity+'-'+sessionVersion,adminUserId:identity};window.fakeSession=session;
 if(!pathname.startsWith('/admin'))return <p data-testid="outside">Outside editor</p>;
 return <AdminPanel key={pathname+':'+identity+':'+sessionVersion} initialArea={pathname.startsWith('/admin/clients')?'clients':'home'} initialSession={session}/>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><RoutedApp/></React.StrictMode>);
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

async function main() {
  const root = path.resolve('.');
  const require = createRequire(path.join(root, 'package.json'));
  let runtime = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!runtime) {
    try { runtime = path.dirname(require.resolve('playwright/package.json')); }
    catch { runtime = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const heavyChildren = new Set(['AnalogFinder', 'AdminSiteContent', 'AdminTopDashboardCatalog', 'AdminTopDashboardSection', 'TopDashboardViewer', 'AdminWholesaleGateway']);
  const bundle = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'navigation-fixture-boundaries', setup(plugin) {
      plugin.onResolve({ filter: /./ }, (args) => {
        const name = args.path.split('/').at(-1);
        if (args.path === 'next/navigation') return { path: 'navigation', namespace: 'fixture' };
        if (args.path === 'next/link') return { path: 'link', namespace: 'fixture' };
        if (name === 'adminSessionClient' || name === 'AdminClientDetailSection' || name && heavyChildren.has(name)) return { path: name, namespace: 'fixture' };
        if (args.path.endsWith('.scss')) return { path: 'styles', namespace: 'fixture' };
      });
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => {
        if (args.path === 'navigation') return { contents: navigation, loader: 'tsx', resolveDir: root };
        if (args.path === 'link') return { contents: 'import React from "react";import {useRouter} from "next/navigation";export default function Link({href,replace,scroll,onClick,...props}){const router=useRouter();return <a {...props} href={href} onClick={event=>{onClick?.(event);if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();router[replace?"replace":"push"](href);}}/>}', loader: 'tsx', resolveDir: root };
        if (args.path === 'AdminClientDetailSection') return { contents: 'import React from "react";export function AdminClientDetailSection({onBack}){return <section data-testid="detail"><button onClick={onBack}>Return to clients</button></section>}', loader: 'tsx', resolveDir: root };
        if (args.path === 'adminSessionClient') return { contents: 'export const fetchAdminSessionWithRetry=async()=>({authenticated:window.sessionValid,...window.fakeSession});export const normalizeSessionRole=role=>role;', loader: 'js' };
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
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engineName of ['chromium', 'webkit']) {
      const browser = await playwright[engineName].launch({ headless: true });
      try {
        for (const scenario of ['back-restore', 'save-one-preserves-other', 'frozen-version', 'create-draft', 'create-saved', 'password-only', 'detail-anchor', 'beforeunload', 'busy-save', 'history', 'history-password', 'home-beforeunload', 'identity', 'session', 'logout', 'expired-session']) {
          const page = await browser.newPage(); page.setDefaultTimeout(10_000);
          const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(`${origin}/admin/clients`);
          const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Synthetic company 13', exact: true }) });
          const other = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Synthetic company 14', exact: true }) });
          await card.getByRole('button', { name: 'Раскрыть', exact: true }).click();
          const create = page.locator('fieldset.clientCreateCard');
          const back = page.getByRole('button', { name: 'Вернуться в панель управления', exact: true });
          const homeClients = page.getByRole('link').filter({ has: page.getByRole('heading', { name: 'Клиенты', exact: true }) });
          const leaveAndReturn = async () => {
            await page.evaluate('window.confirmResult=true'); await back.click();
            await homeClients.waitFor(); await homeClients.click();
            await card.getByRole('heading', { name: 'Synthetic company 13', exact: true }).waitFor();
          };
          const assertStorageEmpty = async () => {
            assert.deepEqual(await page.evaluate('({local:Object.entries(localStorage),session:Object.entries(sessionStorage)})'), { local: [], session: [] }, 'client data and passwords must not be stored in persistent/session web storage');
          };
          assert.equal(await page.evaluate('window.confirms.length'), 0, 'loading an unchanged card is clean');

          if (scenario === 'create-draft' || scenario === 'create-saved') {
            await create.getByLabel('Компания', { exact: true }).fill('Pending company');
            await create.getByLabel('Email', { exact: true }).fill('pending@example.invalid');
            await create.getByLabel('Телефон', { exact: true }).fill('Pending phone');
            await create.locator('input[type="password"]').fill('PendingCreationSecret123');
            await assertStorageEmpty();
            if (scenario === 'create-draft') {
              await back.click(); assert.equal(await page.evaluate('window.confirms.length'), 1);
              assert.equal(await create.locator('input[type="password"]').inputValue(), 'PendingCreationSecret123', 'cancelling leave keeps the current password input');
              await leaveAndReturn();
              assert.equal(await create.getByLabel('Компания', { exact: true }).inputValue(), 'Pending company');
              assert.equal(await create.getByLabel('Email', { exact: true }).inputValue(), 'pending@example.invalid');
              assert.equal(await create.getByLabel('Телефон', { exact: true }).inputValue(), 'Pending phone');
              assert.equal(await create.locator('input[type="password"]').inputValue(), '', 'password is never restored from the section workspace');
            } else {
              await create.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
              await page.waitForFunction('window.saved.some(item=>item.id===15)');
              await page.waitForFunction('document.querySelector("fieldset.clientCreateCard input").value===""');
              await leaveAndReturn();
              assert.equal(await page.evaluate('window.confirms.length'), 0, 'successful creation clears dirty state');
              assert.equal(await create.getByLabel('Компания', { exact: true }).inputValue(), '');
            }
          } else if (scenario === 'password-only') {
            await card.getByRole('button', { name: 'Изменить пароль', exact: true }).click();
            await card.getByLabel('Новый пароль клиента', { exact: true }).fill('PendingOnlySecret123');
            await assertStorageEmpty(); await back.click();
            assert.equal(await page.evaluate('window.confirms.length'), 1, 'a password-only edit participates in the guard');
            assert.equal(await card.getByLabel('Новый пароль клиента', { exact: true }).inputValue(), 'PendingOnlySecret123');
            await leaveAndReturn();
            assert.equal(await card.getByLabel('Новый пароль клиента', { exact: true }).count(), 0, 'leaving clears the pending password and password-edit mode');
            const count = await page.evaluate('window.confirms.length'); await back.click(); await homeClients.waitFor();
            assert.equal(await page.evaluate('window.confirms.length'), count, 'cleared password does not leave a phantom dirty form');
          } else {
            await card.locator('textarea').fill('Private unsaved note');
            if (scenario === 'back-restore') {
              await back.click(); assert.equal(await page.evaluate('window.confirms.length'), 1);
              assert.equal(new URL(page.url()).pathname, '/admin/clients');
              assert.equal(await card.locator('textarea').inputValue(), 'Private unsaved note');
              await leaveAndReturn();
              assert.equal(await card.locator('textarea').inputValue(), 'Private unsaved note');
              assert.ok([2, 3].includes(await page.evaluate('window.confirms.length')), 'Back and optional guarded home link must each prompt at most once');
            } else if (scenario === 'save-one-preserves-other') {
              await other.getByRole('button', { name: 'Раскрыть', exact: true }).click();
              await other.locator('textarea').fill('Second private note');
              await card.getByRole('button', { name: 'Сохранить', exact: true }).click();
              await card.getByRole('button', { name: 'Сохранено', exact: true }).waitFor();
              await leaveAndReturn();
              assert.equal(await card.locator('textarea').inputValue(), 'Private unsaved note');
              assert.equal(await other.locator('textarea').inputValue(), 'Second private note');
              await other.getByRole('button', { name: 'Сохранить', exact: true }).click();
              await other.getByRole('button', { name: 'Сохранено', exact: true }).waitFor();
              const count = await page.evaluate('window.confirms.length'); await back.click(); await homeClients.waitFor();
              assert.equal(await page.evaluate('window.confirms.length'), count, 'saved drafts must not be resurrected as dirty');
            } else if (scenario === 'frozen-version') {
              const originalVersion = await page.evaluate('window.companies[0].updatedAt');
              await page.evaluate('window.confirmResult=true'); await back.click(); await homeClients.waitFor();
              await page.evaluate('window.changeCompany(13,{isActive:false,note:"Remote note"})');
              await homeClients.click(); await card.getByRole('heading', { name: 'Карточка изменена другим пользователем', exact: true }).waitFor();
              assert.equal(await card.locator('textarea').inputValue(), 'Private unsaved note');
              assert.equal(await card.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(), true);
              await card.getByRole('button', { name: 'Загрузить актуальную карточку', exact: true }).click();
              await card.getByRole('checkbox', { name: 'Перенести: Заметка', exact: true }).waitFor();
              assert.equal(await page.evaluate('window.calls.filter(call=>call.method==="PUT").length'), 0, 'returning never silently rebases and saves an obsolete form');
              assert.notEqual(await page.evaluate('window.companies[0].updatedAt'), originalVersion);
              assert.equal(await page.evaluate('window.companies[0].isActive'), false);
            } else if (scenario === 'detail-anchor') {
              await card.getByRole('link', { name: 'Перейти', exact: true }).click();
              assert.equal(await page.evaluate('window.confirms.length'), 1);
              assert.equal(new URL(page.url()).pathname, '/admin/clients');
              await page.evaluate('window.confirmResult=true'); await card.getByRole('link', { name: 'Перейти', exact: true }).click();
              await page.getByTestId('detail').waitFor();
              assert.equal(await page.evaluate('window.confirms.length'), 2, 'accepted Next Link must not prompt twice');
              await page.getByRole('button', { name: 'Return to clients', exact: true }).click();
              await card.locator('textarea').waitFor();
              assert.equal(await card.locator('textarea').inputValue(), 'Private unsaved note');
            } else if (scenario === 'beforeunload') {
              assert.equal(await page.evaluate('(()=>{const event=new Event("beforeunload",{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})()'), true, 'reload/close receives native leave warning');
              await card.getByRole('button', { name: 'Сохранить', exact: true }).click();
              await card.getByRole('button', { name: 'Сохранено', exact: true }).waitFor();
              assert.equal(await page.evaluate('(()=>{const event=new Event("beforeunload",{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})()'), false);
            } else if (scenario === 'busy-save') {
              await page.evaluate('window.deferSave=true');
              await card.getByRole('button', { name: 'Сохранить', exact: true }).click();
              await page.waitForFunction('typeof window.resumeSave==="function"');
              await back.click();
              assert.equal(await page.evaluate('window.confirms.length'), 1, 'an in-flight request is included in the leave guard');
              assert.equal(new URL(page.url()).pathname, '/admin/clients');
              assert.equal(await card.locator('textarea').inputValue(), 'Private unsaved note');
              await page.evaluate('window.deferSave=false;window.resumeSave()');
              await card.getByRole('button', { name: 'Сохранено', exact: true }).waitFor();
              await back.click(); await homeClients.waitFor();
              assert.equal(await page.evaluate('window.confirms.length'), 1, 'completed save releases both dirty and pending-request guard');
            } else if (scenario === 'history' || scenario === 'history-password') {
              if (scenario === 'history-password') {
                await card.getByRole('button', { name: 'Изменить пароль', exact: true }).click();
                await card.getByLabel('Новый пароль клиента', { exact: true }).fill('HistoryPendingSecret123');
              }
              await page.evaluate('history.back()'); await page.getByTestId('outside').waitFor();
              await page.evaluate('history.forward()'); await card.locator('textarea').waitFor();
              assert.equal(await card.locator('textarea').inputValue(), 'Private unsaved note');
              assert.equal(await page.evaluate('window.confirms.length'), 0, 'native history is not rewritten or trapped');
              if (scenario === 'history-password') assert.equal(await card.getByLabel('Новый пароль клиента', { exact: true }).count(), 0, 'native history restores business fields, never an entered password');
            } else if (scenario === 'home-beforeunload') {
              await page.evaluate('window.confirmResult=true'); await back.click(); await homeClients.waitFor();
              assert.equal(await page.evaluate('(()=>{const event=new Event("beforeunload",{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})()'), true, 'cached dirty drafts remain protected on the home panel');
              await page.evaluate('window.confirmResult=false');
              const before = await page.evaluate('window.confirms.length');
              await page.getByRole('button', { name: 'Выйти', exact: true }).click();
              assert.equal(await page.evaluate('window.confirms.length'), before + 1, 'logout from home also warns about cached client drafts');
              assert.equal(await page.evaluate('window.calls.filter(call=>call.url==="/api/admin/logout").length'), 0);
            } else if (scenario === 'identity' || scenario === 'session') {
              await page.evaluate(scenario === 'identity' ? 'window.switchIdentity(42)' : 'window.switchSession(2)');
              await card.getByRole('button', { name: 'Раскрыть', exact: true }).click();
              assert.equal(await card.locator('textarea').inputValue(), 'Original note', 'a new account/session cannot restore the previous employee workspace');
            } else if (scenario === 'logout') {
              await page.getByRole('button', { name: 'Выйти', exact: true }).click();
              assert.equal(await page.evaluate('window.confirms.length'), 1);
              assert.equal(await page.evaluate('window.calls.filter(call=>call.url==="/api/admin/logout").length'), 0, 'cancelled logout performs no request');
              await page.evaluate('window.confirmResult=true'); await page.getByRole('button', { name: 'Выйти', exact: true }).click();
              await page.getByTestId('outside').waitFor();
              await page.evaluate('window.navigate("/admin/clients")'); await card.getByRole('button', { name: 'Раскрыть', exact: true }).click();
              assert.equal(await card.locator('textarea').inputValue(), 'Original note', 'logout invalidation must survive the outgoing component cleanup');
            } else {
              await page.evaluate('window.sessionValid=false;window.navigate("/admin/clients/")'); await page.getByTestId('outside').waitFor();
              await page.evaluate('window.sessionValid=true;window.navigate("/admin/clients")'); await card.getByRole('button', { name: 'Раскрыть', exact: true }).click();
              assert.equal(await card.locator('textarea').inputValue(), 'Original note', 'expired sessions clear retained drafts as well');
            }
          }
          await assertStorageEmpty();
          assert.deepEqual(errors, [], `${engineName}/${scenario}: no unhandled errors`);
          await page.close(); tested++; console.log(`${engineName}/${scenario}: passed`);
        }
      } finally { await browser.close(); }
    }
    console.log(`Client draft navigation integration passed: ${tested} cases (Chromium + WebKit)`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
