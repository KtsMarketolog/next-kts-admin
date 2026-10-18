/** Synthetic browser acceptance: real client editor, fake HTTP, no application DB. */
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
import {AdminClientsSection} from './src/features/admin/clients/AdminClientsSection';
window.calls=[];window.mode='ok';window.failRefresh=false;window.holdRead=false;window.aborts=0;
const normalTimeout=window.setTimeout.bind(window);window.setTimeout=(fn,ms,...args)=>normalTimeout(fn,window.fastTimeout&&ms===20000?80:ms,...args);
window.companies=[{id:13,title:'Synthetic company',email:'synthetic@example.invalid',phone:'',note:'Original note',managerId:21,managerName:'Manager',supportManagerId:22,supportManagerName:'Support',requireTwoFactor:false,userCount:1,clientLogin:'synthetic@example.invalid',clientUserId:31,passwordChangedAt:'2026-10-01T00:00:00Z',displayPassword:'OriginalSynthetic123',chatUnreadCount:0,isActive:true,createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'}];
window.EventSource=class {addEventListener(){}close(){}};
window.fetch=async(url,init={})=>{
 const method=init.method||'GET';const body=init.body?JSON.parse(init.body):null;
 window.calls.push({url,method,body});
 if(method==='GET'){
  if(url.includes('/wholesale/managers'))return Response.json({managers:[{id:21,name:'Manager',role:'manager',isActive:true},{id:22,name:'Support',role:'support_manager',isActive:true}]});
  if(window.failRefresh)throw new TypeError('Synthetic refresh failure');
  if(window.holdRead){const snapshot=structuredClone(window.companies);return new Promise(resolve=>window.finishRead=()=>resolve(Response.json({companies:snapshot})));}
  return Response.json({companies:window.companies});
 }
 if(window.mode==='hold-write')await new Promise(resolve=>window.resumeWrite=resolve);
 if(['hung-fetch','cancel'].includes(window.mode)){init.signal?.addEventListener('abort',()=>window.aborts++);return new Promise(()=>{});}
 if(window.mode==='hung-body'){init.signal?.addEventListener('abort',()=>window.aborts++);return new Response(new ReadableStream());}
 if(window.mode==='reject')throw new TypeError('Synthetic lost response');
 if(window.mode==='rollback')return Response.json({saved:false,error:'Компания не сохранена: синтетическая ошибка транзакции'},{status:400});
 if(window.mode==='unknown')return Response.json({saved:null,code:'COMMIT_OUTCOME_UNKNOWN',error:'Не удалось подтвердить результат сохранения. Обновите данные перед повторной попыткой.'},{status:503});
 let company;
 if(method==='POST'){company={...window.companies[0],...body,id:14,displayPassword:body.password};window.companies.push(company);}
 if(method==='PUT'){company={...window.companies[0],...body,displayPassword:body.password||window.companies[0].displayPassword};window.companies[0]=company;}
 if(method==='DELETE'){company={...window.companies[0],isActive:false,archivedAt:'2026-10-18T12:00:00Z'};window.companies=[];}
 const warnings=window.mode==='warning'?[{code:'CLIENT_UPDATE_AUDIT_UNAVAILABLE',message:'Данные сохранены, запись журнала требует повторения.'}]:[];
 if(window.mode==='reload-failure')window.failRefresh=true;
 return Response.json({saved:true,company,ok:true,warnings});
};
createRoot(document.getElementById('root')).render(<AdminClientsSection onBack={()=>{}}/>);
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
    plugins: [{ name: 'fixture-platform', setup(plugin) {
      plugin.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'import React from "react";export default function Link(props){return <a {...props}/>}', loader: 'jsx', resolveDir: root }));
      plugin.onLoad({ filter: /\.module\.scss$/ }, () => ({ contents: 'export default new Proxy({},{get:(_,name)=>String(name)})', loader: 'js' }));
    } }],
  });
  const server = createServer((request, response) => {
    if (request.url === '/app.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  let tested = 0;
  try {
    for (const engineName of ['chromium', 'webkit']) {
      const engine = playwright[engineName];
      try { await access(engine.executablePath()); } catch { continue; }
      const browser = await engine.launch({ headless: true });
      try {
        for (const scenario of ['warning', 'reload-failure', 'rollback', 'reject', 'unknown', 'create', 'delete', 'busy', 'late-read', 'hung-fetch', 'hung-body', 'cancel']) {
          const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
          page.setDefaultTimeout(10_000);
          const errors: string[] = [];
          page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(origin);
          const card = page.locator('article').first();
          await card.getByRole('button', { name: 'Раскрыть', exact: true }).click();
          await card.locator('textarea').waitFor();
          if (scenario === 'create') {
            const form = page.locator('.clientCreateCard');
            await form.getByLabel('Компания', { exact: true }).fill('Synthetic new client');
            await form.getByLabel('Email', { exact: true }).fill('new@example.invalid');
            await form.locator('input[type=password]').fill('SyntheticNew123');
            await page.evaluate('window.mode="reload-failure"');
            await form.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
            await page.waitForFunction('window.calls.some(c=>c.method==="POST")');
            await page.getByRole('heading', { name: 'Synthetic new client', exact: true }).waitFor();
            assert.equal(await form.getByLabel('Компания', { exact: true }).inputValue(), '');
            assert.equal(await page.evaluate('window.calls.filter(c=>c.method==="POST").length'), 1);
            assert.equal(await form.getByRole('button', { name: 'Добавить клиента', exact: true }).isEnabled(), true);
            assert.doesNotMatch(await page.locator('.status').innerText(), /Не удалось добавить|не сохранен/);
          } else if (scenario === 'delete') {
            await page.evaluate('window.mode="warning"');
            page.once('dialog', (dialog: { accept(): Promise<void> }) => void dialog.accept());
            await card.getByRole('button', { name: 'В архив', exact: true }).click();
            await page.waitForFunction('window.calls.some(c=>c.method==="DELETE")');
            await page.waitForFunction('document.querySelectorAll("article").length===0');
            await page.getByText(/журнала требует повторения/).waitFor();
          } else {
            await card.locator('textarea').fill('New synthetic note');
            await card.getByRole('button', { name: 'Изменить пароль', exact: true }).click();
            await card.getByPlaceholder('Введите новый пароль').fill('ChangedSynthetic123');
            if (scenario === 'late-read') {
              await page.evaluate('window.holdRead=true;window.dispatchEvent(new Event("focus"))');
              await page.waitForFunction('typeof window.finishRead==="function"');
            }
            await page.evaluate(`window.mode=${JSON.stringify(scenario === 'busy' ? 'hold-write' : scenario)}`);
            if (scenario.startsWith('hung-')) await page.evaluate('window.fastTimeout=true');
            await card.getByRole('button', { name: 'Сохранить', exact: true }).click();
            await page.waitForFunction('window.calls.some(c=>c.method==="PUT")');
            if (scenario === 'cancel') await page.getByRole('button', { name: 'Отменить ожидание', exact: true }).click();
            if (scenario === 'busy') {
              assert.equal(await card.locator('textarea').isDisabled(), true);
              assert.equal(await card.getByPlaceholder('Введите новый пароль').isDisabled(), true);
              await card.getByRole('button', { name: 'Сохранить', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
              assert.equal(await page.evaluate('window.calls.filter(c=>c.method==="PUT").length'), 1);
              await page.evaluate('window.resumeWrite()');
            }
            await page.waitForFunction('!Array.from(document.querySelectorAll("article button")).find(b=>b.textContent==="Сохранить"||b.textContent==="Сохранено")?.disabled');
            assert.equal(await card.locator('textarea').inputValue(), 'New synthetic note');
            if (['warning', 'reload-failure', 'busy', 'late-read'].includes(scenario)) {
              await card.getByRole('button', { name: 'Изменить пароль', exact: true }).waitFor();
              assert.equal(await card.locator('input[readonly]').inputValue(), 'ChangedSynthetic123');
              if (scenario === 'late-read') {
                await page.evaluate('window.finishRead()');
                await page.waitForTimeout(50);
                assert.equal(await card.locator('input[readonly]').inputValue(), 'ChangedSynthetic123', 'A late pre-save GET cannot restore the old password display');
                assert.equal(await card.locator('textarea').inputValue(), 'New synthetic note');
              }
              if (scenario === 'warning') await page.getByText(/журнала требует повторения/).waitFor();
              assert.doesNotMatch(await page.locator('.status').innerText(), /Не удалось сохранить компанию|не сохранен/);
            } else {
              assert.equal(await card.getByPlaceholder('Введите новый пароль').inputValue(), 'ChangedSynthetic123');
              assert.equal(await card.locator('input[readonly]').inputValue(), 'OriginalSynthetic123');
              if (scenario === 'rollback') await page.getByText(/синтетическая ошибка транзакции/).waitFor();
              else await page.getByText(/подтвердить|могло сохраниться/).first().waitFor();
            }
            assert.equal(await page.evaluate('window.calls.filter(c=>c.method==="PUT").length'), 1);
            if (scenario.startsWith('hung-') || scenario === 'cancel') assert.equal(await page.evaluate('window.aborts'), 1);
          }
          assert.deepEqual(errors, [], `${engineName}/${scenario} has no unhandled browser rejection`);
          await page.close();
          tested++;
          console.log(`${engineName}/${scenario}: client save-result acceptance passed`);
        }
      } finally { await browser.close(); }
    }
    assert.ok(tested > 0, 'No installed browser engine was tested');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
