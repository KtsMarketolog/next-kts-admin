/** Synthetic-only UI regressions; no real API or database is used. Run with node --import tsx. */
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
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AdminUsersSection} from './src/features/admin/users/AdminUsersSection';
import {useWholesaleManagers} from './src/features/admin/wholesale/useWholesaleManagers';
import {WholesaleManagerManagement} from './src/features/admin/wholesale/WholesaleManagerManagement';
import styles from './src/app/admin/admin.module.scss';
const wholesale=new URLSearchParams(location.search).has('wholesale');
const delegated=new URLSearchParams(location.search).has('delegated');
window.mode='ok';window.password='CurrentSynthetic123';window.calls=[];window.pending=[];window.copied=[];
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>window.copied.push(value)}});
const users=[1,2].map(id=>({id:'manager:'+id,numericId:id,source:'manager',name:'Synthetic '+id,login:'synthetic-'+id,email:'',phone:'',role:'manager',isActive:true,canAccessTopDashboard:false,canManageTopDashboard:false,dashboardAccess:[],dashboardAccessVersion:'a'.repeat(64),accesses:[],priceListCount:0,supportManagerId:null,supportManagerName:'',isCurrent:false,displayPassword:'UnexpectedServerCopy123'}));
window.fetch=async(url,init={})=>{
  window.calls.push({url,method:init.method||'GET',cache:init.cache,payload:init.body?JSON.parse(init.body):null});
  if(!init.method)return Response.json(url.includes('/wholesale/')?{managers:users.map(u=>({...u,id:u.numericId}))}:{users,dashboardOptions:[],dashboardOptionsVersion:'b'.repeat(64)});
  if(window.mode==='reject')throw new TypeError('Synthetic network rejection');
  const finish=()=>{
    if(url.endsWith('/password')){
      const body=JSON.parse(init.body);
      if(window.password===null&&body.legacyPassword&&body.legacyPassword===window.acceptLegacy)window.password=body.legacyPassword;
      return Response.json({password:window.password});
    }
    if(init.method==='DELETE')return Response.json({ok:true});
    const body=JSON.parse(init.body);if(body.password)window.password=body.password;
    const numeric=Number(decodeURIComponent(url).split(':').pop())||Number(url.split('/').pop())||3;
    return Response.json(url.includes('/wholesale/')?{ok:true,id:3}:{user:{...users.find(u=>u.numericId===numeric)||users[0],...body,id:init.method==='POST'?'manager:3':'manager:'+numeric}});
  };
  if(window.mode==='hold'||window.mode==='timeout')return new Promise(resolve=>window.pending.push(()=>resolve(finish())));
  return finish();
};
localStorage.setItem('kts-admin-users-active-tab','manager');
localStorage.setItem('kts-admin-users-passwords-v1',JSON.stringify({'manager:1':'StaleBrowserCopy123'}));
localStorage.setItem('kts-admin-wholesale-manager-passwords-v1',JSON.stringify({'1':'StaleBrowserCopy123'}));
localStorage.setItem('kts-admin-client-company-passwords-v1','client-data-preserved');
function Wholesale(){const [message,setMessage]=useState('');const m=useWholesaleManagers({showStatus:setMessage});useEffect(()=>{void m.loadManagers();},[m.loadManagers]);return <><WholesaleManagerManagement {...m} busy={m.managerBusy} requestError={m.managerRequestError} reloadManagers={m.loadManagers} router={{push(){}}}/><p role="status">{message}</p></>;}
function Users(){const[message,setMessage]=useState('');return <><AdminUsersSection canManageSiteAdmins={!delegated} showStatus={setMessage}/><p role="status">{message}</p></>;}
createRoot(document.getElementById('root')).render(<main id="fixture" className={styles.page}>{wholesale?<Wholesale/>:<Users/>}</main>);
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
  const output = await mkdtemp('/private/tmp/kts-employee-password-ui-');
  const styles = new Map<string, string>();
  const bundle = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@': path.join(root, 'src') },
    define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'styles', setup(plugin) {
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        const css = compile(args.path, { importers: [{ findFileUrl(url) { return url.startsWith('@/') ? pathToFileURL(path.join(root, 'src', url.slice(2))) : null; } }] }).css;
        const names = [...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]);
        const parsed = postcss.parse(css);
        parsed.walkRules((rule) => { rule.selector = rule.selector.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.fixture_${name}`); });
        styles.set(args.path, parsed.toString());
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, 'fixture_' + name])))};`, loader: 'js' };
      });
    } }],
  });
  const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const css = globals + [...styles].sort(([left], [right]) => Number(left.endsWith('/admin.module.scss')) - Number(right.endsWith('/admin.module.scss'))).map(([, value]) => value).join('\n')
    + '\n#fixture{max-width:1500px;padding:16px;margin:auto}html,body{overflow-x:visible}';
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
        for (const wholesale of [false, true]) for (const width of [1440, 390]) {
          const page = await browser.newPage({ viewport: { width, height: 1100 } });
          const errors: string[] = [];
          page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(origin + (wholesale ? '/?wholesale' : '/'));
          const rows = page.locator('article');
          const first = rows.first();
          await first.getByRole('button', { name: 'Показать пароль', exact: true }).waitFor();
          await page.clock.install();
          assert.equal(await first.getByLabel('Текущий пароль', { exact: true }).inputValue(), '••••••••');
          assert.equal(await page.locator('input[value="StaleBrowserCopy123"],input[value="UnexpectedServerCopy123"]').count(), 0);
          assert.deepEqual(await page.evaluate('[JSON.parse(localStorage.getItem("kts-admin-users-passwords-v1"))["manager:1"],JSON.parse(localStorage.getItem("kts-admin-wholesale-manager-passwords-v1"))["1"],localStorage.getItem("kts-admin-client-company-passwords-v1")]'), ['StaleBrowserCopy123', 'StaleBrowserCopy123', 'client-data-preserved'], 'mount does not discard recoverable legacy copies');
          assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true, 'no horizontal overflow');
          assert.equal(await first.getByRole('button', { name: 'Скопировать пароль', exact: true }).evaluate((button: HTMLButtonElement) => button.getBoundingClientRect().right <= button.closest('article')!.getBoundingClientRect().right + 1), true, 'password actions fit the card');
          await page.screenshot({ path: path.join(output, `${engineName}-${wholesale ? 'wholesale' : 'users'}-${width}.png`), fullPage: true });

          await page.evaluate('window.mode="reject"');
          await first.getByRole('button', { name: 'Показать пароль', exact: true }).click();
          await first.getByText(/Не удалось получить ответ сервера/).waitFor();
          assert.equal(await page.evaluate('JSON.parse(localStorage.getItem("kts-admin-users-passwords-v1"))["manager:1"]'), 'StaleBrowserCopy123', 'failed recovery preserves legacy copy');
          assert.equal(await first.getByLabel('Текущий пароль', { exact: true }).inputValue(), '••••••••');
          await page.evaluate('window.mode="ok"');

          await first.getByRole('button', { name: 'Показать пароль', exact: true }).click();
          await page.waitForFunction(() => document.querySelector<HTMLInputElement>('article input[aria-label="Текущий пароль"]')?.value === 'CurrentSynthetic123');
          await page.evaluate('window.password="ChangedElsewhere123"');
          await first.getByRole('button', { name: 'Скопировать пароль', exact: true }).click();
          await page.waitForFunction('window.copied.length===1');
          assert.deepEqual(await page.evaluate('window.copied'), ['ChangedElsewhere123']);
          assert.equal(await first.getByLabel('Текущий пароль', { exact: true }).inputValue(), '••••••••', 'copy discards previously revealed plaintext');
          const revealCalls = await page.evaluate('window.calls.filter(c=>c.url.endsWith("/password"))');
          assert.equal(revealCalls.length, 3);
          assert.ok(revealCalls.every((call: { cache: string; method: string }) => call.cache === 'no-store' && call.method === 'POST'));
          assert.deepEqual(revealCalls.map((call: { payload: object }) => call.payload), [{ legacyPassword: 'StaleBrowserCopy123' }, { legacyPassword: 'StaleBrowserCopy123' }, {}]);
          assert.equal(await page.evaluate('localStorage.getItem("kts-admin-users-passwords-v1")'), null, 'server-confirmed result retires this old copy');

          await page.evaluate('window.password=null;window.acceptLegacy="ValidRecovery123";localStorage.setItem("kts-admin-users-passwords-v1",JSON.stringify({"manager:1":"StaleRecovery123"}));localStorage.setItem("kts-admin-wholesale-manager-passwords-v1",JSON.stringify({"1":"ValidRecovery123"}))');
          await first.getByRole('button', { name: 'Показать пароль', exact: true }).click();
          await page.waitForFunction(() => document.querySelector<HTMLInputElement>('article input[aria-label="Текущий пароль"]')?.value === 'ValidRecovery123');
          assert.equal(await page.evaluate('localStorage.getItem("kts-admin-users-passwords-v1")'), null);
          assert.equal(await page.evaluate('localStorage.getItem("kts-admin-wholesale-manager-passwords-v1")'), null);

          await page.evaluate('window.password=null');
          await first.getByRole('button', { name: 'Показать пароль', exact: true }).click();
          await first.getByText(/только для проверки входа/).waitFor();
          assert.equal(await first.getByLabel('Текущий пароль', { exact: true }).inputValue(), '••••••••');

          await page.evaluate('window.password="AfterNull123";window.mode="hold"');
          await first.getByRole('button', { name: 'Показать пароль', exact: true }).click();
          await page.evaluate('window.dispatchEvent(new Event("blur"));window.pending.shift()()');
          await page.waitForTimeout(20);
          assert.equal(await first.getByLabel('Текущий пароль', { exact: true }).inputValue(), '••••••••', 'late reveal after blur is discarded');
          await page.evaluate('window.mode="ok"');
          await first.getByRole('button', { name: 'Показать пароль', exact: true }).click();
          await page.waitForFunction(() => document.querySelector<HTMLInputElement>('article input[aria-label="Текущий пароль"]')?.value === 'AfterNull123');
          await page.clock.fastForward(30_001);
          assert.equal(await first.getByLabel('Текущий пароль', { exact: true }).inputValue(), '••••••••', 'reveal expires after 30 seconds');

          await first.getByRole('button', { name: 'Показать пароль', exact: true }).click();
          await page.waitForFunction(() => document.querySelector<HTMLInputElement>('article input[aria-label="Текущий пароль"]')?.value === 'AfterNull123');
          await page.evaluate('Object.defineProperty(document,"hidden",{configurable:true,value:true});document.dispatchEvent(new Event("visibilitychange"));delete document.hidden');
          assert.equal(await first.getByLabel('Текущий пароль', { exact: true }).inputValue(), '••••••••', 'hidden tab clears revealed plaintext');
          await first.getByRole('button', { name: 'Показать пароль', exact: true }).click();
          await page.waitForFunction(() => document.querySelector<HTMLInputElement>('article input[aria-label="Текущий пароль"]')?.value === 'AfterNull123');

          await first.getByRole('button', { name: 'Изменить пароль', exact: true }).click();
          assert.equal(await first.getByLabel('Текущий пароль', { exact: true }).inputValue(), '••••••••', 'editing hides the current password');
          await first.getByPlaceholder('Введите новый пароль').fill('UpdatedSynthetic572');
          await page.evaluate('window.mode="hold"');
          await first.getByRole('button', { name: 'Сохранить', exact: true }).click();
          assert.equal(await first.getByPlaceholder('Введите новый пароль').isDisabled(), true);
          assert.equal(await rows.nth(1).getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(), true);
          assert.equal(await rows.nth(1).getByLabel('Логин', { exact: true }).isDisabled(), true);
          const writesBefore = await page.evaluate('window.calls.filter(c=>c.method==="PUT").length');
          await rows.nth(1).getByRole('button', { name: 'Сохранить', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
          assert.equal(await page.evaluate('window.calls.filter(c=>c.method==="PUT").length'), writesBefore, 'overlapping row write blocked');
          await page.evaluate('window.mode="ok";window.pending.shift()()');
          await first.getByRole('button', { name: 'Изменить пароль', exact: true }).waitFor();
          assert.equal(await first.getByLabel('Текущий пароль', { exact: true }).inputValue(), '••••••••', 'successful save never reveals its password');
          const write = await page.evaluate('window.calls.filter(c=>c.method==="PUT").at(-1)');
          assert.equal(write.payload.password, 'UpdatedSynthetic572');
          assert.equal('displayPassword' in write.payload, false);

          await page.clock.fastForward(3_000);
          await page.evaluate('window.mode="reject"');
          await first.getByRole('button', { name: 'Сохранить', exact: true }).click();
          await page.getByRole('alert').getByText(/Изменение могло сохраниться/).waitFor();
          assert.equal(await first.getByRole('button', { name: 'Сохранить', exact: true }).isEnabled(), true);

          await page.evaluate('window.mode="timeout"');
          await first.getByRole('button', { name: 'Сохранить', exact: true }).click();
          await page.clock.fastForward(20_001);
          await page.getByRole('alert').getByText(/Изменение могло сохраниться/).waitFor();
          assert.equal(await first.getByRole('button', { name: 'Сохранить', exact: true }).isEnabled(), true, 'timeout releases button even if fetch ignores abort');
          await page.evaluate('window.mode="ok";window.pending.shift()()');
          assert.equal(await page.locator('input[value="UpdatedSynthetic572"]').count(), 0, 'late response cannot show plaintext');
          assert.equal(await page.evaluate('localStorage.getItem("kts-admin-users-passwords-v1")'), null);

          await page.evaluate('window.mode="reject"');
          const create = page.locator('.fixture_userCreateCard');
          await create.getByLabel('Имя', { exact: true }).fill('Synthetic new');
          await create.getByLabel('Логин', { exact: true }).fill('synthetic-new');
          await create.locator('input[type="password"]').last().fill('SyntheticCreation572');
          const createButton = create.getByRole('button', { name: 'Добавить менеджера по развитию', exact: true });
          await createButton.click();
          await page.getByRole('alert').getByText(/Изменение могло сохраниться/).waitFor();
          assert.equal(await createButton.isEnabled(), true, 'create releases the lock on network failure');
          page.once('dialog', (dialog: { accept(): Promise<void> }) => void dialog.accept());
          await first.getByRole('button', { name: 'Удалить', exact: true }).click();
          await page.getByRole('alert').getByText(/Изменение могло сохраниться/).waitFor();
          assert.equal(await first.getByRole('button', { name: 'Удалить', exact: true }).isEnabled(), true, 'delete releases the lock on network failure');
          assert.deepEqual(errors, []);
          await page.close();
          tested += 1;
          console.log(`${engineName}/${width}: ${wholesale ? 'wholesale' : 'users'} employee password and save regressions passed`);
        }
        const delegated = await browser.newPage();
        await delegated.goto(origin + '/?delegated');
        await delegated.locator('article').first().waitFor();
        assert.equal(await delegated.getByRole('button', { name: 'Показать пароль', exact: true }).count(), 0);
        assert.equal(await delegated.getByRole('button', { name: 'Изменить пароль', exact: true }).count(), 0);
        await delegated.close();
      } finally { await browser.close(); }
    }
    assert.ok(tested > 0, 'no installed browser engine was tested');
    console.log(`Full CSS screenshots: ${output}`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
