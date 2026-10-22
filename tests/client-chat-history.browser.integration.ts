/** Real chat/CSS with synthetic HTTP responses only; no application DB or customer messages. */
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import postcss from 'postcss';
import { compile } from 'sass';

const fixture = `
import React,{useState,useCallback} from 'react';
import {createRoot} from 'react-dom/client';
import {ClientChatPanel} from './src/features/client-chat/ClientChatPanel';
const params=new URLSearchParams(location.search), scenario=params.get('scenario')||'history';
const viewer=params.get('viewer')||'employee', incoming=viewer==='employee'?'client':'employee';
const timestamp='2026-10-23 12:00:00.123456+00';
window.calls=[];window.badAcknowledgements=[];window.unread=[];window.pendingGets=[];window.pendingPosts=[];
window.holdGets=false;window.holdPosts=false;window.ackMode=scenario==='ack-failure'?'failure':'ok';window.historyFailure=scenario==='history-failure';
window.hidden=false;
Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.hidden?'hidden':'visible'});
const message=(id,authorType=incoming,body='Synthetic message '+id)=>({id,companyId:13,authorType,authorName:'Synthetic author',body,createdAt:timestamp,readByOther:false,readByViewer:false});
window.conversations={alpha:Array.from({length:scenario==='empty-live-gap'?0:301},(_,i)=>message(i+1)),beta:Array.from({length:3},(_,i)=>message(i+1001))};
window.receipts={alpha:new Set(),beta:new Set()};window.otherReceipts=new Set();
window.addIncoming=(count)=>{const list=window.conversations.alpha;for(let i=0;i<count;i++)list.push(message((list.at(-1)?.id||0)+1));};
const callbacks=[];
window.EventSource=class{constructor(url){this.url=url;this.listeners=[];}addEventListener(type,callback){if(type==='chat.updated'){callbacks.push(callback);this.listeners.push(callback);}}close(){for(const fn of this.listeners){const index=callbacks.indexOf(fn);if(index>=0)callbacks.splice(index,1);}}};
window.emitChat=()=>callbacks.slice().forEach(callback=>callback());
window.releaseGets=()=>window.pendingGets.splice(0).forEach(resolve=>resolve());
window.releasePosts=()=>window.pendingPosts.splice(0).forEach(resolve=>resolve());
window.visibleMessageIds=()=>{
 const root=document.querySelector('[data-testid="chat-messages"]');if(!root)return[];
 const outer=root.getBoundingClientRect();
 return [...root.querySelectorAll('[data-chat-message-id]')].filter(node=>{
  const bounds=node.getBoundingClientRect();
  return bounds.width>0&&bounds.height>0&&bounds.bottom>Math.max(outer.top,0)&&bounds.top<Math.min(outer.bottom,innerHeight)&&bounds.right>Math.max(outer.left,0)&&bounds.left<Math.min(outer.right,innerWidth);
 }).map(node=>Number(node.dataset.chatMessageId));
};
const unread=key=>window.conversations[key].filter(item=>item.authorType===incoming&&!window.receipts[key].has(item.id)).length;
window.fetch=async(input,init={})=>{
 const url=new URL(String(input),location.origin),key=url.pathname.includes('/beta/')?'beta':'alpha',method=init.method||'GET';
 const body=init.body?JSON.parse(init.body):null;
 const call={url:url.pathname+url.search,method,body,key,visible:window.visibleMessageIds(),hidden:window.hidden,focused:document.hasFocus()};window.calls.push(call);
 if(method==='POST'&&url.pathname.endsWith('/read')){
  if(!Array.isArray(body?.messageIds))throw Error('Missing explicit receipt IDs');
  for(const id of body.messageIds){
   const item=window.conversations[key].find(value=>value.id===id);
   if(!item||item.authorType!==incoming||!call.visible.includes(id)||call.hidden||!call.focused||scenario==='archived')window.badAcknowledgements.push({id,...call});
  }
  if(window.ackMode==='failure')return Response.json({error:'Synthetic read acknowledgement failed'},{status:503});
  const acknowledgedIds=body.messageIds.filter(id=>window.conversations[key].some(item=>item.id===id&&item.authorType===incoming));
  const changed=acknowledgedIds.some(id=>!window.receipts[key].has(id));
  acknowledgedIds.forEach(id=>window.receipts[key].add(id));
  return Response.json({acknowledgedIds,unreadCount:unread(key),changed});
 }
 if(method==='POST'){
  const list=window.conversations[key],item=message(list.at(-1).id+1,viewer,body.message);list.push(item);
  if(window.holdPosts)await new Promise(resolve=>window.pendingPosts.push(resolve));
  return Response.json({message:item,unreadCount:unread(key)});
 }
 if(method!=='GET')throw Error('Unexpected synthetic request '+method);
 const list=window.conversations[key],before=Number(url.searchParams.get('before')),after=Number(url.searchParams.get('after')),hasAfter=url.searchParams.has('after');
 if(before&&window.historyFailure)return Response.json({error:'Synthetic older history unavailable'},{status:503});
 const limit=100;
 const selected=hasAfter?list.filter(item=>item.id>after).slice(0,limit):before?list.filter(item=>item.id<before).slice(-limit):list.slice(-limit);
 const messages=selected.map(item=>({...item,readByViewer:window.receipts[key].has(item.id),readByOther:window.otherReceipts.has(item.id)}));
 const first=messages[0]?.id??null,last=messages.at(-1)?.id??null;
 const receiptIds=(url.searchParams.get('receiptIds')||'').split(',').map(Number);
 const response={messages,unreadCount:unread(key),olderCursor:first,newerCursor:last,hasOlder:first!==null&&list.some(item=>item.id<first),hasNewer:last!==null&&list.some(item=>item.id>last),readMessageIds:receiptIds.filter(id=>window.otherReceipts.has(id))};
 if(scenario==='hidden-document'&&window.calls.filter(call=>call.method==='GET').length===1)window.hidden=true;
 if(scenario==='strict-delayed')await new Promise(resolve=>setTimeout(resolve,300));
 if(window.holdGets&&key==='alpha')await new Promise(resolve=>window.pendingGets.push(resolve));
 return Response.json(response);
};
function Fixture(){
 const [chat,setChat]=useState('alpha');
 const onUnread=useCallback(count=>window.unread.push({chat,count}),[chat]);
 return <><button id="switch-chat" onClick={()=>setChat('beta')}>Switch synthetic chat</button><div id="panel" style={scenario==='offscreen'?{marginTop:1800}:scenario==='hidden-panel'?{display:'none'}:scenario==='hidden-visibility'?{visibility:'hidden'}:scenario==='hidden-opacity'?{opacity:0}:{}}><ClientChatPanel endpoint={'/api/synthetic/'+chat+'/chat'} eventsEndpoint={'/api/synthetic/'+chat+'/events'} currentAuthorType={viewer} readOnly={scenario==='archived'} onUnreadCountChange={onUnread}/></div>{scenario==='occluded'?<div id="cover" style={{position:'fixed',inset:0,zIndex:99999,background:'white'}}>Synthetic modal covering the chat</div>:null}</>;
}
createRoot(document.getElementById('root')).render(scenario==='strict-delayed'?<React.StrictMode><Fixture/></React.StrictMode>:<Fixture/>);
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
  const output = await mkdtemp('/private/tmp/kts-client-chat-history-ui-');
  const cssModules = new Map<string, string>();
  const bundle = await build({
    absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'fixture-css', setup(plugin) {
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        const css = compile(args.path, { importers: [{ findFileUrl(url) { return url.startsWith('@/') ? pathToFileURL(path.join(root, 'src', url.slice(2))) : null; } }] }).css;
        const names = [...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]);
        const prefix = `fixture_${path.basename(args.path, '.module.scss').replace(/\W/g, '_')}_`;
        const parsed = postcss.parse(css);
        parsed.walkRules((rule) => { rule.selector = rule.selector.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.${prefix}${name}`); });
        cssModules.set(args.path, parsed.toString());
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, prefix + name])))};`, loader: 'js' };
      });
    } }],
  });
  const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const css = globals + [...cssModules.values()].join('\n') + '\n#root{max-width:1000px;padding:16px;margin:auto}html,body{overflow-x:visible}';
  const fonts = new Map<string, Buffer>();
  for (const match of globals.matchAll(/url\("(\/fonts\/[^"?]+)"\)/g)) fonts.set(match[1], await readFile(path.join(root, 'public', match[1])));
  const server = createServer((request, response) => {
    if (request.url === '/app.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else if (request.url === '/style.css') response.writeHead(200, { 'Content-Type': 'text/css' }).end(css);
    else if (fonts.has(request.url || '')) response.writeHead(200, { 'Content-Type': 'font/woff2' }).end(fonts.get(request.url || ''));
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script>');
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
        const cases = ['history', 'client-history', 'mobile-history', 'strict-delayed', 'hidden-panel', 'hidden-visibility', 'hidden-opacity', 'occluded', 'hidden-document', 'offscreen', 'archived', 'ack-failure', 'history-failure', 'stale-unread-count', 'live-gap', 'empty-live-gap', 'endpoint-race', 'send-endpoint-race', 'send-poll-race', 'old-own-receipt'];
        for (const scenario of cases.filter((name) => !process.env.CHAT_BROWSER_CASES || process.env.CHAT_BROWSER_CASES.split(',').includes(name))) {
          const page = await browser.newPage({ viewport: { width: scenario === 'mobile-history' ? 390 : 1280, height: 1000 } });
          page.setDefaultTimeout(12_000);
          const errors: string[] = [];
          page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(`${origin}?scenario=${scenario}&viewer=${scenario === 'client-history' ? 'client' : 'employee'}`);
          if (scenario === 'empty-live-gap') await page.getByText('Сообщений пока нет', { exact: true }).waitFor();
          else await page.waitForFunction('document.querySelectorAll("[data-chat-message-id]").length===100', null, { timeout: scenario === 'strict-delayed' ? 4000 : 12_000 });
          const messages = page.locator('[data-chat-message-id]');
          const container = page.getByTestId('chat-messages');
          const older = page.getByRole('button', { name: 'Загрузить предыдущие сообщения', exact: true });

          if (scenario === 'mobile-history') {
            const fonts = await messages.last().evaluate((node: Element) => {
              const text = node.querySelector('p');
              const metadata = node.querySelector('span');
              return [text, metadata].map((element) => element ? Number.parseFloat(getComputedStyle(element).fontSize) : 0);
            });
            assert.ok(fonts.every((size: number) => size >= 12), `mobile chat text and metadata must be legible, got ${fonts.join(', ')}px`);
            const historyBounds = await older.boundingBox();
            assert.ok(historyBounds && historyBounds.height >= 44, 'history navigation needs a usable mobile touch target');
            assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true, 'chat/history control must fit narrow screens');
          }

          assert.equal(await page.evaluate('window.unread[0].count'), scenario === 'empty-live-gap' ? 0 : 301, 'GET reports actual unread, never implicitly marks the whole conversation');
          assert.equal(await page.evaluate('window.receipts.alpha.has(1)'), false, 'the 301st oldest, not-yet-loaded message must remain unread');

          if (['hidden-panel', 'hidden-visibility', 'hidden-opacity', 'occluded', 'hidden-document', 'offscreen', 'archived'].includes(scenario)) {
            await page.waitForTimeout(1100);
            assert.equal(await page.evaluate('window.calls.filter(call=>call.url.endsWith("/read")).length'), 0, `${scenario}: no acknowledgements for invisible or read-only history`);
            assert.equal(await page.evaluate('window.unread.at(-1).count'), 301);
            if (scenario === 'hidden-panel') await page.evaluate('document.getElementById("panel").style.display="block";window.dispatchEvent(new Event("resize"))');
            if (scenario === 'hidden-visibility') await page.evaluate('document.getElementById("panel").style.visibility="visible";window.dispatchEvent(new Event("resize"))');
            if (scenario === 'hidden-opacity') await page.evaluate('document.getElementById("panel").style.opacity="1";window.dispatchEvent(new Event("resize"))');
            if (scenario === 'occluded') await page.evaluate('document.getElementById("cover").remove();window.dispatchEvent(new Event("resize"))');
            if (scenario === 'hidden-document') await page.evaluate('window.hidden=false;document.dispatchEvent(new Event("visibilitychange"))');
            if (scenario === 'offscreen') await container.scrollIntoViewIfNeeded();
            if (scenario !== 'archived') await page.waitForFunction('window.receipts.alpha.size>0');
            else {
              await older.click();
              await page.waitForFunction('document.querySelectorAll("[data-chat-message-id]").length===200');
              assert.equal(await page.getByPlaceholder('Введите сообщение').count(), 0);
            }
          } else if (scenario === 'ack-failure') {
            await page.waitForFunction('window.calls.some(call=>call.url.endsWith("/read"))');
            assert.equal(await page.evaluate('window.receipts.alpha.size'), 0);
            assert.equal(await page.evaluate('window.unread.at(-1).count'), 301, 'failed receipts cannot optimistically clear unread');
            await page.evaluate('window.ackMode="ok";window.dispatchEvent(new Event("online"));window.dispatchEvent(new Event("focus"))');
            await page.waitForFunction('window.receipts.alpha.size>0');
            assert.ok(await page.evaluate('window.calls.filter(call=>call.url.endsWith("/read")).length') >= 2, 'failed visible receipt is retried');
          } else if (scenario === 'history-failure') {
            await older.click();
            await page.getByText('Synthetic older history unavailable', { exact: true }).waitFor();
            assert.equal(await messages.count(), 100, 'failed history page must leave existing messages intact');
            assert.equal(await older.isEnabled(), true, 'failed history loading must release its button');
            await page.evaluate('window.historyFailure=false');
            await older.click();
            await page.waitForFunction('document.querySelectorAll("[data-chat-message-id]").length===200');
            assert.equal(await page.getByText('Synthetic older history unavailable', { exact: true }).count(), 0);
          } else if (scenario === 'stale-unread-count') {
            await page.evaluate('window.holdGets=true;window.emitChat()');
            await page.waitForFunction('window.pendingGets.length===1');
            await page.waitForFunction('window.receipts.alpha.size>0');
            const acknowledgedUnread = await page.evaluate('window.unread.at(-1).count');
            await page.evaluate('window.holdGets=false;window.releaseGets()');
            await page.waitForTimeout(700);
            assert.ok(await page.evaluate('window.unread.at(-1).count') <= acknowledgedUnread, 'a GET started before explicit acknowledgement cannot restore its stale unread count');
          } else if (scenario === 'live-gap' || scenario === 'empty-live-gap') {
            if (scenario === 'live-gap') await page.waitForFunction('window.receipts.alpha.size>0');
            await page.evaluate(`window.addIncoming(${scenario === 'live-gap' ? 250 : 301});window.emitChat()`);
            await page.waitForFunction(`document.querySelectorAll("[data-chat-message-id]").length===${scenario === 'live-gap' ? 350 : 301}`);
            const ids: number[] = await messages.evaluateAll((nodes: Element[]) => nodes.map((node) => Number(node.getAttribute('data-chat-message-id'))));
            assert.deepEqual(ids, Array.from({ length: scenario === 'live-gap' ? 350 : 301 }, (_, index) => (scenario === 'live-gap' ? 202 : 1) + index), 'catch-up follows every forward page, including the empty-conversation after=0 cursor, without gaps or duplicate IDs');
            assert.ok(await page.evaluate('window.calls.filter(call=>call.method==="GET"&&call.url.includes("after=")).length') >= 3);
          } else if (scenario === 'endpoint-race') {
            await page.evaluate('window.holdGets=true;window.emitChat()');
            await page.waitForFunction('window.pendingGets.length===1');
            await page.locator('#switch-chat').click();
            await page.locator('[data-chat-message-id="1001"]').waitFor();
            await page.evaluate('window.releaseGets()');
            await page.waitForTimeout(700);
            assert.deepEqual(await messages.evaluateAll((nodes: Element[]) => nodes.map((node) => Number(node.getAttribute('data-chat-message-id')))), [1001, 1002, 1003], 'late prior endpoint response cannot contaminate the new conversation');
            assert.equal(await page.evaluate('window.unread.at(-1).chat'), 'beta');
          } else if (scenario === 'send-endpoint-race') {
            await page.evaluate('window.holdPosts=true');
            await page.getByPlaceholder('Введите сообщение').fill('Synthetic old-conversation pending message');
            await page.getByRole('button', { name: 'Отправить', exact: true }).click();
            await page.waitForFunction('window.pendingPosts.length===1');
            await page.locator('#switch-chat').click();
            await page.locator('[data-chat-message-id="1001"]').waitFor();
            await page.getByPlaceholder('Введите сообщение').fill('New-conversation draft');
            await page.evaluate('window.releasePosts()');
            await page.waitForTimeout(700);
            assert.deepEqual(await messages.evaluateAll((nodes: Element[]) => nodes.map((node) => Number(node.getAttribute('data-chat-message-id')))), [1001, 1002, 1003]);
            assert.equal(await page.getByPlaceholder('Введите сообщение').inputValue(), 'New-conversation draft', 'old send completion must not clear the next conversation draft');
          } else if (scenario === 'send-poll-race') {
            await page.evaluate('window.holdGets=true;window.emitChat()');
            await page.waitForFunction('window.pendingGets.length===1');
            await page.getByPlaceholder('Введите сообщение').fill('Synthetic sent during stale poll');
            await page.getByRole('button', { name: 'Отправить', exact: true }).click();
            await page.getByText('Synthetic sent during stale poll', { exact: true }).waitFor();
            await page.evaluate('window.holdGets=false;window.releaseGets();window.addIncoming(105);window.emitChat()');
            await page.locator('[data-chat-message-id="407"]').waitFor();
            assert.equal(await page.getByText('Synthetic sent during stale poll', { exact: true }).count(), 1);
            const ids: number[] = await messages.evaluateAll((nodes: Element[]) => nodes.map((node) => Number(node.getAttribute('data-chat-message-id'))));
            assert.deepEqual(ids, Array.from({ length: 206 }, (_, index) => 202 + index), 'POST and stale poll merge without losing sent or incoming messages');
            assert.equal(await page.getByPlaceholder('Введите сообщение').inputValue(), '');
          } else if (scenario === 'old-own-receipt') {
            await page.getByPlaceholder('Введите сообщение').fill('Synthetic old outgoing message');
            await page.getByRole('button', { name: 'Отправить', exact: true }).click();
            const sent = page.locator('[data-chat-message-id="302"]');
            await sent.getByLabel('Отправлено', { exact: true }).waitFor();
            await page.evaluate('window.addIncoming(130);window.emitChat()');
            await page.locator('[data-chat-message-id="432"]').waitFor();
            await page.evaluate('window.otherReceipts.add(302);window.emitChat()');
            await sent.getByLabel('Прочитано', { exact: true }).waitFor();
          } else {
            await page.waitForFunction('window.receipts.alpha.size>0');
            if (scenario === 'history' || scenario === 'mobile-history') {
              await page.evaluate('document.fonts.ready');
              await page.locator('#panel').screenshot({ path: path.join(output, `${engineName}-${scenario}.png`) });
            }
            const firstReadCount = await page.evaluate('window.receipts.alpha.size');
            assert.ok(firstReadCount < 100, 'offscreen messages in the loaded page are not silently marked as read');
            assert.ok(await page.evaluate('window.unread.at(-1).count') > 200);
            await container.evaluate((node: HTMLElement) => { node.scrollTop = Math.round(node.scrollHeight / 2); });
            await page.waitForTimeout(150);
            const anchor = await page.evaluate(`(()=>{const root=document.querySelector('[data-testid="chat-messages"]'),bounds=root.getBoundingClientRect(),node=[...root.querySelectorAll('[data-chat-message-id]')].find(item=>item.getBoundingClientRect().top>=bounds.top);return{id:node.dataset.chatMessageId,top:node.getBoundingClientRect().top-bounds.top};})()`);
            await older.click();
            await page.waitForFunction('document.querySelectorAll("[data-chat-message-id]").length===200');
            const anchoredTop = await page.evaluate(`(()=>{const root=document.querySelector('[data-testid="chat-messages"]'),node=document.querySelector('[data-chat-message-id="${anchor.id}"]');return node.getBoundingClientRect().top-root.getBoundingClientRect().top;})()`);
            assert.ok(Math.abs(anchoredTop - anchor.top) < 3, `prepending older messages must preserve the visible reading anchor (${anchor.top} versus ${anchoredTop})`);
            await older.click();
            await page.waitForFunction('document.querySelectorAll("[data-chat-message-id]").length===300');
            await older.click();
            await page.waitForFunction('document.querySelectorAll("[data-chat-message-id]").length===301');
            const ids: number[] = await messages.evaluateAll((nodes: Element[]) => nodes.map((node) => Number(node.getAttribute('data-chat-message-id'))));
            assert.deepEqual(ids, Array.from({ length: 301 }, (_, index) => index + 1), 'all 301 history messages remain accessible, sorted by ID for equal timestamps');
            assert.equal(await older.count() === 0 || await older.isDisabled(), true, 'history exhaustion stops further older-page requests');
            assert.equal(await page.evaluate('window.receipts.alpha.has(1)'), false, 'loading an older page alone does not mean the oldest message was seen');
            await container.evaluate((node: HTMLElement) => { node.scrollTop = 0; });
            await page.waitForFunction('window.receipts.alpha.has(1)');
            assert.ok(await page.evaluate('window.unread.at(-1).count') > 0, 'unseen middle messages stay unread after viewing oldest and newest');
            assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true, 'chat/history control must fit narrow screens');
          }

          assert.deepEqual(await page.evaluate('window.badAcknowledgements'), [], `${engineName}/${scenario}: every receipt refers only to a visible incoming message`);
          assert.deepEqual(errors, [], `${engineName}/${scenario}: no unhandled browser errors`);
          await page.close();
          tested++;
          console.log(`${engineName}/${scenario}: paginated history and visible-only read acceptance passed`);
        }
      } finally { await browser.close(); }
    }
    assert.ok(tested > 0, 'No installed browser engine was tested');
    console.log(`Client chat history: ${tested} browser cases passed`);
    console.log(`Full CSS screenshots: ${output}`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
