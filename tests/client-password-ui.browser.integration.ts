/** Real client editor + real styles; synthetic APIs only, no application DB or credentials. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import postcss from 'postcss';
import { compile } from 'sass';

const fixture = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {AdminClientsSection} from './src/features/admin/clients/AdminClientsSection';
import styles from './src/app/admin/admin.module.scss';
const company={id:13,title:'Synthetic company',email:'synthetic@example.invalid',phone:'',note:'Original note',managerId:null,managerName:'',supportManagerId:null,supportManagerName:'',requireTwoFactor:false,userCount:1,clientLogin:'synthetic@example.invalid',clientUserId:31,passwordChangedAt:'2026-10-01T00:00:00Z',chatUnreadCount:0,isActive:true,archivedAt:null,createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'};
window.companies=[company,{...company,id:14,title:'Synthetic archived',isActive:false,archivedAt:'2026-10-01T00:00:00Z'}];
window.mode='ok';window.password='CurrentSynthetic123';window.calls=[];window.pending=[];window.copied=[];window.aborts=0;
window.EventSource=class {addEventListener(){}close(){}};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>window.copied.push(value)}});
localStorage.setItem('kts-admin-client-company-passwords-v1',JSON.stringify({'13':{password:'StaleBrowserCopy123',passwordChangedAt:company.passwordChangedAt}}));
window.fetch=async(url,init={})=>{
 const method=init.method||'GET',body=init.body?JSON.parse(init.body):null;
 window.calls.push({url,method,cache:init.cache,body});
 if(method==='GET'){
  if(url.includes('/wholesale/managers'))return Response.json({managers:[]});
  if(window.mode==='body-timeout')throw new TypeError('Synthetic network stall also prevents background list refresh');
  const archived=new URL(url,location.origin).searchParams.get('scope')==='archived';
  return Response.json({companies:window.companies.filter(c=>Boolean(c.archivedAt)===archived).map(c=>({...c,displayPassword:'UnexpectedListCopy123',password:'UnexpectedPassword123',password_hash:'unexpected-hash',password_ciphertext:'unexpected-ciphertext'}))});
 }
 if(url.endsWith('/password')){
  if(window.mode==='reject')throw new TypeError('Synthetic offline');
  if(window.mode==='denied')return Response.json({error:'Нет доступа к паролю клиента'},{status:403});
  if(window.mode==='unavailable')return Response.json({error:'Не удалось получить актуальный пароль с сервера. Повторите позже.'},{status:503});
  if(window.mode==='malformed')return Response.json({password:{bad:true}});
  if(window.mode==='body-timeout'){init.signal.addEventListener('abort',()=>window.aborts++);return new Response(new ReadableStream());}
  const password=window.password;
  if(window.mode==='hold')return new Promise(resolve=>{init.signal.addEventListener('abort',()=>window.aborts++);window.pending.push(()=>resolve(Response.json({password})));});
  return Response.json({password});
 }
 if(method==='PUT'){
  const {password,...safe}=body;if(password)window.password=password;
  const saved={...window.companies[0],...safe,updatedAt:'2026-10-19T00:00:00Z',displayPassword:'UnexpectedSavedCopy123'};
  window.companies[0]=saved;return Response.json({saved:true,company:saved,warnings:[]});
 }
 throw new Error('Unexpected request '+url);
};
createRoot(document.getElementById('root')).render(<main id="fixture" className={styles.page}><AdminClientsSection onBack={()=>{}}/></main>);
`;

async function main() {
  const root = path.resolve('.'), require = createRequire(path.join(root, 'package.json'));
  let runtime = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!runtime) {
    try { runtime = path.dirname(require.resolve('playwright/package.json')); }
    catch { runtime = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const output = await mkdtemp('/private/tmp/kts-client-password-ui-');
  const cssModules = new Map<string, string>();
  const bundle = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@': path.join(root, 'src') },
    define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'fixture-ui', setup(plugin) {
      plugin.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'import React from "react";export default function Link(props){return <a {...props}/>}', loader: 'jsx', resolveDir: root }));
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        const css = compile(args.path, { importers: [{ findFileUrl(url) { return url.startsWith('@/') ? pathToFileURL(path.join(root, 'src', url.slice(2))) : null; } }] }).css;
        const names = [...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]);
        const parsed = postcss.parse(css);
        parsed.walkRules((rule) => { rule.selector = rule.selector.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.fixture_${name}`); });
        cssModules.set(args.path, parsed.toString());
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, 'fixture_' + name])))};`, loader: 'js' };
      });
    } }],
  });
  const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const css = globals + [...cssModules].sort(([left], [right]) => Number(left.endsWith('/admin.module.scss')) - Number(right.endsWith('/admin.module.scss'))).map(([, value]) => value).join('\n')
    + '\n#fixture{max-width:1500px;padding:16px;margin:auto}html,body{overflow-x:visible}';
  const fonts = new Map<string, Buffer>();
  for (const match of globals.matchAll(/url\("(\/fonts\/[^"?]+)"\)/g)) fonts.set(match[1], await readFile(path.join(root, 'public', match[1])));
  const server = createServer((request, response) => {
    if (request.url === '/app.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else if (request.url === '/style.css') response.writeHead(200, { 'Content-Type': 'text/css' }).end(css);
    else if (fonts.has(request.url || '')) response.writeHead(200, { 'Content-Type': 'font/woff2' }).end(fonts.get(request.url || ''));
    else response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const engineName of ['chromium', 'webkit']) {
      const browser = await playwright[engineName].launch({ headless: true });
      try {
        for (const width of [1440, 390]) {
          const page = await browser.newPage({ viewport: { width, height: 1100 } });
          page.setDefaultTimeout(10_000);
          const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(origin);
          const card = page.locator('article').first();
          await card.getByRole('button', { name: 'Раскрыть', exact: true }).click();
          const current = card.getByLabel('Текущий пароль', { exact: true });
          const show = card.getByRole('button', { name: 'Показать пароль', exact: true });
          const copy = card.getByRole('button', { name: 'Скопировать пароль', exact: true });
          await current.waitFor(); await page.clock.install();
          assert.equal(await current.inputValue(), '••••••••');
          assert.equal(await page.evaluate('window.calls.filter(c=>c.url.endsWith("/password")).length'), 0, 'neither loading nor expanding bulk-fetches passwords');
          assert.equal(await page.locator('input[value="UnexpectedListCopy123"],input[value="UnexpectedPassword123"],input[value="StaleBrowserCopy123"]').count(), 0);
          assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true, 'mobile/desktop card has no horizontal overflow');
          assert.equal(await copy.evaluate((button: HTMLButtonElement) => button.getBoundingClientRect().right <= button.closest('article')!.getBoundingClientRect().right + 1), true);
          await page.screenshot({ path: path.join(output, `${engineName}-${width}.png`), fullPage: true });

          for (const [mode, text] of [['reject', /Не удалось получить ответ сервера/], ['denied', /Нет доступа/], ['unavailable', /актуальный пароль с сервера/], ['malformed', /корректный ответ/]] as const) {
            await page.evaluate(`window.mode=${JSON.stringify(mode)}`);
            await show.click(); await card.getByText(text).waitFor();
            assert.equal(await current.inputValue(), '••••••••'); assert.equal(await show.isEnabled(), true);
          }
          await page.evaluate('window.mode="ok"');
          await show.click(); await page.waitForFunction('document.querySelector("article input[readonly]")?.value==="CurrentSynthetic123"');
          await page.evaluate('window.password="ChangedElsewhere123"');
          await copy.click(); await page.waitForFunction('window.copied.length===1');
          assert.deepEqual(await page.evaluate('window.copied'), ['ChangedElsewhere123']);
          assert.equal(await current.inputValue(), '••••••••', 'copy fetches current value and forgets prior reveal');
          const calls = await page.evaluate('window.calls.filter(c=>c.url.endsWith("/password"))');
          assert.ok(calls.every((call: { method: string; cache: string; body: object }) => call.method === 'POST' && call.cache === 'no-store' && Object.keys(call.body).length === 0));
          assert.match(await page.evaluate('localStorage.getItem("kts-admin-client-company-passwords-v1")'), /StaleBrowserCopy123/, 'legacy cache is never trusted or overwritten');

          await page.evaluate('window.password=null'); await show.click(); await card.getByText(/только для проверки входа/).waitFor();
          assert.equal(await card.getByRole('button', { name: 'Изменить пароль', exact: true }).isEnabled(), true, 'hash-only credential is not mistaken for a missing login');
          assert.equal(await card.getByText(/чтобы клиент мог войти/).count(), 0);

          await page.evaluate('window.password="LateSynthetic123";window.mode="hold"'); await show.click();
          await page.evaluate('window.dispatchEvent(new Event("blur"));window.pending.shift()()'); await page.waitForTimeout(20);
          assert.equal(await current.inputValue(), '••••••••', 'late reveal after blur is discarded');
          await page.evaluate('window.mode="ok"'); await show.click();
          await page.waitForFunction('document.querySelector("article input[readonly]")?.value==="LateSynthetic123"');
          await page.clock.fastForward(30_001); assert.equal(await current.inputValue(), '••••••••');
          await show.click(); await page.waitForFunction('document.querySelector("article input[readonly]")?.value==="LateSynthetic123"');
          await page.evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"));delete document.hidden');
          assert.equal(await current.inputValue(), '••••••••');

          await page.evaluate('window.mode="body-timeout"'); await show.click(); await page.clock.fastForward(20_001);
          await card.getByText(/Не удалось получить ответ сервера/).waitFor(); assert.equal(await show.isEnabled(), true);
          await page.evaluate('window.mode="ok"'); await show.click(); await page.waitForFunction('document.querySelector("article input[readonly]")?.value==="LateSynthetic123"');
          await card.getByRole('button', { name: 'Изменить пароль', exact: true }).click();
          assert.equal(await current.inputValue(), '••••••••'); assert.equal(await copy.isDisabled(), true);
          await card.getByPlaceholder('Введите новый пароль').fill('UpdatedSynthetic123');
          await card.locator('textarea').fill('Preserved note');
          await card.getByRole('button', { name: 'Сохранить', exact: true }).click();
          await card.getByRole('button', { name: 'Изменить пароль', exact: true }).waitFor();
          assert.equal(await current.inputValue(), '••••••••', 'successful save response does not reveal or retain password');
          assert.equal(await card.locator('textarea').inputValue(), 'Preserved note');
          await copy.click(); await page.waitForFunction('window.copied.length===2');
          assert.deepEqual(await page.evaluate('window.copied'), ['ChangedElsewhere123', 'UpdatedSynthetic123']);
          const write = await page.evaluate('window.calls.find(c=>c.method==="PUT").body');
          assert.equal(write.password, 'UpdatedSynthetic123');
          assert.equal('displayPassword' in write || 'password_hash' in write || 'password_ciphertext' in write, false);

          await page.evaluate('window.mode="hold"'); await show.click();
          await card.getByRole('button', { name: 'Скрыть', exact: true }).click();
          await page.evaluate('window.pending.shift()()');
          await card.getByRole('button', { name: 'Раскрыть', exact: true }).click();
          assert.equal(await current.inputValue(), '••••••••', 'collapsed editor unmounts/discards pending password');
          await page.evaluate('window.mode="ok"'); await show.click(); await page.waitForFunction('document.querySelector("article input[readonly]")?.value==="UpdatedSynthetic123"');
          await page.getByRole('button', { name: 'Архив', exact: true }).click();
          await page.getByRole('heading', { name: 'Synthetic archived', exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: 'Показать пароль', exact: true }).count(), 0);
          await page.getByRole('button', { name: 'Клиенты', exact: true }).click();
          await current.waitFor(); assert.equal(await current.inputValue(), '••••••••', 'returning from archive never restores revealed plaintext');
          assert.deepEqual(errors, []);
          await page.close(); console.log(`${engineName}/${width}: scoped current client password UI acceptance passed`);
        }
      } finally { await browser.close(); }
    }
    console.log(`Full CSS screenshots: ${output}`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
