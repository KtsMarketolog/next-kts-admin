/** Synthetic archive UI acceptance. No application server, production data or credentials. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const fixture = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {AdminClientsSection} from './src/features/admin/clients/AdminClientsSection';
import {AdminClientDetailSection} from './src/features/admin/clients/AdminClientDetailSection';
const query=new URLSearchParams(location.search);
const base={id:1,title:'Synthetic active',email:'synthetic@example.invalid',phone:'',note:'Original note',managerId:null,managerName:'',supportManagerId:null,supportManagerName:'',requireTwoFactor:false,userCount:1,clientLogin:'synthetic',clientUserId:1,passwordChangedAt:'2026-10-01T00:00:00Z',displayPassword:'Synthetic123',chatUnreadCount:0,isActive:true,archivedAt:null,createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'};
window.companies=[base,{...base,id:2,title:'Synthetic archived',email:'archived@example.invalid',isActive:false,archivedAt:'2026-10-17T00:00:00Z'}];
window.calls=[];window.mode='ok';window.releaseReads=[];window.EventSource=class {addEventListener(){}close(){}};
window.fetch=async(url,init={})=>{
 const method=init.method||'GET';const body=init.body?JSON.parse(init.body):null;window.calls.push({url,method,body});
 if(method==='GET'){
  if(url.includes('/wholesale/managers'))return Response.json({managers:[]});
  if(url.startsWith('/api/admin/clients')&&!/\\/clients\\/\\d/.test(url)){
   const scope=new URL(url,location.origin).searchParams.get('scope');
   const companies=structuredClone(window.companies.filter(c=>scope==='all'||Boolean(c.archivedAt)===(scope==='archived')));
   if(window.holdArchive&&scope==='archived')return new Promise(resolve=>window.releaseReads.push(()=>resolve(Response.json({companies}))));
   return Response.json({companies,canPermanentlyDelete:!query.has('restricted')});
  }
  if(url.endsWith('/deletion-preview')){
   if(window.mode==='preview-fail')return Response.json({error:'Синтетическая ошибка проверки состава'},{status:503});
   const company=window.companies.find(c=>c.id===2);
   return Response.json({preview:{id:2,title:company.title,archivedAt:company.archivedAt,updatedAt:'2026-10-18T09:00:00Z',revision:'a'.repeat(64),counts:{users:1,sessions:0,twoFactorChallenges:0,chatMessages:8,chatReadStates:1,documents:2,files:2,fileBytes:2048,priceRequests:3,priceLists:4}}});
  }
  if(url.endsWith('/documents'))return Response.json({documents:[{id:5,companyId:2,title:'Preserved document',originalName:'preserved.pdf',fileSize:100,isVisible:true,createdAt:base.createdAt}]});
  if(url.endsWith('/price-lists'))return Response.json({priceLists:[]});
  if(url.endsWith('/price-requests'))return Response.json({requests:[]});
  if(url.endsWith('/chat/unread'))return Response.json({unreadCount:0});
  if(url.endsWith('/chat'))return Response.json({messages:[{id:1,authorType:'client',authorName:'Synthetic author',body:'Preserved conversation',createdAt:base.createdAt,readByOther:true}],unreadCount:0});
  throw new Error('Unexpected read '+url);
 }
 if(window.mode==='conflict')return Response.json({error:'Данные уже изменены другим пользователем. Обновите список.'},{status:409});
 if(window.mode==='network')throw new TypeError('Synthetic offline');
 if(url.endsWith('/purge')){window.companies=window.companies.filter(c=>c.id!==2);return Response.json({ok:true,saved:true,removed:{users:1},detachedPriceLists:4,cleanupQueued:2,cleanupPending:2,warnings:[{message:'Синтетическое предупреждение очистки.'}]});}
 const id=Number(url.match(/\\/clients\\/(\\d+)/)[1]);const previous=window.companies.find(c=>c.id===id);
 const company={...previous,isActive:false,archivedAt:method==='DELETE'?'2026-10-18T10:00:00Z':null,updatedAt:'2026-10-18T10:00:00Z'};
 window.companies=window.companies.map(c=>c.id===id?company:c);
 return Response.json({ok:true,saved:true,company,warnings:[{message:'Синтетическое предупреждение журнала.'}]});
};
createRoot(document.getElementById('root')).render(query.get('view')==='detail'?<AdminClientDetailSection clientId={2} onBack={()=>{}}/>:<AdminClientsSection onBack={()=>{}}/>);
`;

async function main() {
  const root = path.resolve('.'), require = createRequire(path.join(root, 'package.json'));
  let runtime = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!runtime) {
    try { runtime = path.dirname(require.resolve('playwright/package.json')); }
    catch { runtime = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const bundle = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@': path.join(root, 'src') },
    define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'fixture-ui', setup(plugin) {
      plugin.onResolve({ filter: /^next\/(navigation|link)$/ }, (args) => ({ path: args.path, namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => args.path.endsWith('navigation')
        ? { contents: "const router={replace:()=>{}};export const useRouter=()=>router,usePathname=()=>'/admin/clients/2',useSearchParams=()=>new URLSearchParams(location.search);", loader: 'js' }
        : { contents: 'import React from "react";export default function Link(props){return <a {...props}/>}', loader: 'jsx', resolveDir: root });
      plugin.onLoad({ filter: /\.module\.scss$/ }, () => ({ contents: 'export default new Proxy({},{get:(_,name)=>String(name)})', loader: 'js' }));
    } }],
  });
  const server = createServer((request, response) => {
    if (request.url === '/app.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const engineName of ['chromium', 'webkit']) {
      const browser = await playwright[engineName].launch({ headless: true });
      try {
        for (const scenario of ['archive', 'cancel', 'conflict', 'network', 'restore', 'drafts', 'late-scope', 'documents', 'chat', 'purge', 'purge-cancel', 'purge-conflict', 'purge-network', 'preview-fail', 'no-purge-permission']) {
          const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
          page.setDefaultTimeout(10_000);
          const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
          const detail = ['documents', 'chat'].includes(scenario);
          await page.goto(detail ? `${origin}/?view=detail&tab=${scenario}` : scenario === 'no-purge-permission' ? `${origin}/?restricted=1` : origin);
          if (detail) {
            await page.getByRole('heading', { name: 'Synthetic archived', exact: true }).waitFor();
            await page.getByRole('status').getByText(/Клиент в архиве с/).waitFor();
            if (scenario === 'documents') {
              await page.getByRole('heading', { name: 'Preserved document', exact: true }).waitFor();
              assert.equal(await page.getByRole('link', { name: 'Скачать', exact: true }).count(), 1);
              assert.equal(await page.locator('input[type=file]').count(), 0);
              assert.equal(await page.getByRole('button', { name: 'Удалить', exact: true }).count(), 0);
            } else {
              await page.getByText('Preserved conversation', { exact: true }).waitFor();
              assert.equal(await page.locator('textarea').count(), 0);
              assert.equal(await page.getByRole('button', { name: 'Отправить', exact: true }).count(), 0);
            }
            assert.equal(await page.evaluate('window.calls.filter(c=>c.method!=="GET").length'), 0);
          } else if (scenario.startsWith('purge') || scenario === 'preview-fail' || scenario === 'no-purge-permission') {
            await page.getByRole('button', { name: 'Архив', exact: true }).click();
            await page.getByRole('heading', { name: 'Synthetic archived', exact: true }).waitFor();
            if (scenario === 'no-purge-permission') {
              assert.equal(await page.getByRole('button', { name: 'Удалить навсегда', exact: true }).count(), 0);
            } else {
              if (scenario === 'preview-fail') await page.evaluate('window.mode="preview-fail"');
              await page.getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
              if (scenario === 'preview-fail') {
                await page.getByRole('status').getByText(/ошибка проверки состава/).waitFor();
                assert.equal(await page.getByRole('dialog').count(), 0);
              } else {
                const dialog = page.getByRole('dialog');
                await dialog.waitFor();
                await dialog.getByText(/Сообщения: 8/).waitFor();
                await dialog.getByText(/Прайсы \(4\), их товары и публичные ссылки не удаляются/).waitFor();
                assert.equal(await dialog.getByRole('button', { name: 'Удалить навсегда', exact: true }).isDisabled(), true);
                await dialog.getByRole('textbox').fill('wrong name');
                assert.equal(await dialog.getByRole('button', { name: 'Удалить навсегда', exact: true }).isDisabled(), true);
                if (scenario === 'purge-cancel') {
                  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
                  assert.equal(await page.getByRole('dialog').count(), 0);
                } else {
                  await dialog.getByRole('textbox').fill('Synthetic archived');
                  if (scenario === 'purge-conflict') await page.evaluate('window.mode="conflict"');
                  if (scenario === 'purge-network') await page.evaluate('window.mode="network"');
                  await dialog.getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
                  if (scenario === 'purge') {
                    await page.getByRole('status').getByText(/Клиент удалён навсегда/).waitFor();
                    await page.getByRole('status').getByText(/Заданий очистки файлов, ожидающих отдельного подтверждения: 2/).waitFor();
                    assert.equal(await page.getByRole('heading', { name: 'Synthetic archived', exact: true }).count(), 0);
                    assert.deepEqual(await page.evaluate('window.calls.find(c=>c.url.endsWith("/purge")).body'), { expectedUpdatedAt: '2026-10-18T09:00:00Z', expectedRevision: 'a'.repeat(64), confirmationTitle: 'Synthetic archived' });
                  } else {
                    await dialog.getByRole('alert').waitFor();
                    assert.equal(await dialog.getByRole('button', { name: 'Удалить навсегда', exact: true }).isEnabled(), true);
                    assert.equal(await page.getByRole('heading', { name: 'Synthetic archived', exact: true }).count(), 1);
                  }
                }
              }
            }
            assert.equal(await page.evaluate('window.calls.filter(c=>c.method==="POST"&&c.url.endsWith("/purge")).length'), ['purge', 'purge-conflict', 'purge-network'].includes(scenario) ? 1 : 0);
          } else if (scenario === 'restore') {
            await page.getByRole('button', { name: 'Архив', exact: true }).click();
            await page.getByRole('heading', { name: 'Synthetic archived', exact: true }).waitFor();
            assert.equal(await page.locator('article input').count(), 0);
            page.once('dialog', (dialog: { accept(): Promise<void> }) => void dialog.accept());
            await page.getByRole('button', { name: 'Восстановить', exact: true }).click();
            await page.getByRole('status').getByText(/Клиент восстановлен/).waitFor();
            await page.getByRole('button', { name: 'Клиенты', exact: true }).click();
            const restored = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Synthetic archived', exact: true }) });
            await restored.getByText('Отключен', { exact: true }).waitFor();
            assert.equal(await page.evaluate('window.calls.find(c=>c.url.endsWith("/restore")).body.expectedUpdatedAt'), '2026-10-01T00:00:00Z');
          } else {
            const card = page.locator('article').first();
            await card.getByRole('button', { name: 'Раскрыть', exact: true }).click();
            await card.locator('textarea').fill('Unsaved draft');
            if (['drafts', 'late-scope'].includes(scenario)) {
              if (scenario === 'late-scope') await page.evaluate('window.holdArchive=true');
              await page.getByRole('button', { name: 'Архив', exact: true }).click();
              if (scenario === 'drafts') await page.getByRole('heading', { name: 'Synthetic archived', exact: true }).waitFor();
              else await page.waitForFunction('window.releaseReads.length>0');
              await page.getByRole('button', { name: 'Клиенты', exact: true }).click();
              await page.getByRole('heading', { name: 'Synthetic active', exact: true }).waitFor();
              if (scenario === 'late-scope') {
                await page.evaluate('window.releaseReads.forEach(f=>f())');
                await page.waitForTimeout(100);
              }
              assert.equal(await page.locator('article textarea').inputValue(), 'Unsaved draft');
              assert.equal(await page.getByRole('heading', { name: 'Synthetic archived', exact: true }).count(), 0);
            } else {
              await page.evaluate(`window.mode=${JSON.stringify(scenario)}`);
              let confirmation = '';
              page.once('dialog', (dialog: { message(): string; accept(): Promise<void>; dismiss(): Promise<void> }) => {
                confirmation = dialog.message(); void (scenario === 'cancel' ? dialog.dismiss() : dialog.accept());
              });
              await card.getByRole('button', { name: 'В архив', exact: true }).click();
              assert.match(confirmation, /Публичные ссылки на прайсы НЕ отключаются/);
              assert.match(confirmation, /пользователи и пароли, переписка, документы, заявки/);
              if (scenario === 'archive') {
                await page.getByRole('status').getByText(/Клиент перенесён в архив/).waitFor();
                assert.equal(await page.locator('article').count(), 0);
                assert.equal(await page.evaluate('window.calls.find(c=>c.method==="DELETE").body.expectedUpdatedAt'), '2026-10-01T00:00:00Z');
              } else {
                if (scenario !== 'cancel') await page.getByRole('status').getByText(scenario === 'conflict' ? /изменены другим пользователем/ : /подтвердить|могло сохраниться/).waitFor();
                assert.equal(await card.locator('textarea').inputValue(), 'Unsaved draft');
                assert.equal(await card.getByRole('button', { name: 'В архив', exact: true }).isEnabled(), true);
                if (scenario === 'cancel') assert.equal(await page.evaluate('window.calls.filter(c=>c.method==="DELETE").length'), 0);
              }
            }
          }
          assert.deepEqual(errors, [], `${engineName}/${scenario}`);
          await page.close(); console.log(`${engineName}/${scenario}: passed`);
        }
      } finally { await browser.close(); }
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
