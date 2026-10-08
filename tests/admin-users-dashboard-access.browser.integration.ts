/** Isolated users UI acceptance: synthetic fetch responses, no production requests or mutations. */
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
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AdminUsersSection} from './src/features/admin/users/AdminUsersSection';
import styles from './src/app/admin/admin.module.scss';
const user = {id:'admin:42', source:'admin', numericId:42, name:'Тестовый закупщик', login:'buyer', email:'buyer@example.test', role:'purchaser', isActive:true, canManageTopDashboard:false, dashboardAccess:['top:7','top:999'], dashboardAccessVersion:'a'.repeat(64), accesses:[], priceListCount:0, supportManagerId:null, supportManagerName:'', isCurrent:false, displayPassword:''};
const delegated = new URLSearchParams(location.search).has('delegated');
window.fixtureOptions = [{key:'top:7',title:'Стратегический обзор',href:'/admin/top/7',defaultGranted:delegated},{key:'top:8',title:'Другой обзор',href:'/admin/top/8'},{key:'route-planner',title:'Компоновщик рейсов',description:'Общий отчёт с данными',href:'/admin/top/route-planner'}];
window.fixtureCalls = [];
window.fixtureVersion = 'b'.repeat(64);
window.fixtureConflict = false;
window.fixtureMissing = new URLSearchParams(location.search).has('missing');
window.fetch = async (url, init = {}) => {
  if (url === '/api/admin/users' && !init.method) return new Response(JSON.stringify({users:[user,...(delegated ? [
    {...user,id:'admin:1',numericId:1,role:'admin',name:'Protected site admin',login:'protected-admin'},
    {...user,id:'admin:2',numericId:2,role:'top',name:'Тестовый TOP',login:'test-top',displayPassword:'UnexpectedServerPassword123'},
    {...user,id:'manager:3',numericId:3,source:'manager',role:'manager',name:'Тестовый МР',login:'test-mr'},
    {...user,id:'manager:4',numericId:4,source:'manager',role:'support_manager',name:'Тестовый МС',login:'test-ms'},
  ] : [])], ...(window.fixtureMissing ? {} : {dashboardOptions:window.fixtureOptions,dashboardOptionsVersion:window.fixtureVersion})}), {status:200});
  const payload = JSON.parse(init.body);
  window.fixtureCalls.push({url, method:init.method, payload});
  if(window.fixtureConflict) return new Response(JSON.stringify({error:'Общие доступы изменились. Обновите список.'}),{status:409});
  return new Response(JSON.stringify({user:{...user,...payload,id:init.method === 'POST' ? 'admin:43' : user.id}}), {status:200});
};
localStorage.setItem('kts-admin-users-active-tab','purchaser');
localStorage.setItem('kts-admin-users-passwords-v1',JSON.stringify({'admin:1':'ProtectedAdminPassword123','admin:42':'CachedPurchaserPassword123'}));
function Fixture() {const [message,setMessage]=useState(''); return <main className={styles.page} id="fixture"><AdminUsersSection showStatus={setMessage} canManageSiteAdmins={!delegated}/><p role="status">{message}</p></main>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
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
  const output = await mkdtemp('/private/tmp/kts-purchaser-users-ui-');
  const styles = new Map<string, string>();
  const bundle = await build({
    absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' }, alias: { '@': path.join(root, 'src') },
    plugins: [{ name: 'test-scss', setup(plugin) {
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        const css = compile(args.path, { importers: [{ findFileUrl(url) {
          return url.startsWith('@/') ? pathToFileURL(path.join(root, 'src', url.slice(2))) : null;
        } }] }).css;
        const prefix = args.path.endsWith('/admin.module.scss') ? 'admin_' : 'access_';
        const names = [...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]);
        const parsed = postcss.parse(css);
        parsed.walkRules((rule) => { rule.selector = rule.selector.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.${prefix}${name}`); });
        styles.set(args.path, parsed.toString());
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, prefix + name])))};`, loader: 'js' };
      });
    } }],
  });
  const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const fonts = new Map<string, Buffer>();
  for (const match of globals.matchAll(/url\("(\/fonts\/[^"?]+)"\)/g)) fonts.set(match[1], await readFile(path.join(root, 'public', match[1])));
  // Load the old global administration cascade last to test selector precedence.
  const css = globals + [...styles].sort(([left], [right]) => Number(left.endsWith('/admin.module.scss')) - Number(right.endsWith('/admin.module.scss'))).map(([, value]) => value).join('\n')
    + '\n#fixture{max-width:1500px;padding:16px;margin:auto}html,body{overflow-x:visible}';
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/') response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script></html>');
    else if (url.pathname === '/app.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else if (url.pathname === '/style.css') response.writeHead(200, { 'Content-Type': 'text/css' }).end(css);
    else if (fonts.has(url.pathname)) response.writeHead(200, { 'Content-Type': 'font/woff2' }).end(fonts.get(url.pathname));
    else response.writeHead(404).end();
  });
  let tested = 0;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engineName of ['chromium', 'webkit']) {
      const engine = playwright[engineName];
      try { await access(engine.executablePath()); } catch { continue; }
      const browser = await engine.launch({ headless: true });
      try {
        for (const width of [1440, 390]) {
          const context = await browser.newContext({ viewport: { width, height: 1100 } });
          await context.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          try {
            const page = await context.newPage();
            const errors: string[] = [];
            page.on('pageerror', (error: Error) => errors.push(error.message));
            await page.goto(origin);
            const existing = page.locator('article').first();
            await existing.getByLabel('Стратегический обзор', { exact: true }).waitFor();
            assert.equal(await existing.getByLabel('Стратегический обзор', { exact: true }).isChecked(), true);
            assert.equal(await existing.getByLabel('Другой обзор', { exact: true }).isChecked(), false);
            assert.equal(await page.getByRole('button', { name: 'Закупщик', exact: true }).getAttribute('aria-pressed'), 'true');
            const create = page.locator('.admin_userCreateCard');
            for (const card of [existing, create]) {
              assert.equal(await card.locator('fieldset input[type="checkbox"]').count(), 3, 'one checkbox per individual TOP report and the route planner');
              assert.equal(await card.getByRole('checkbox', { name: 'Стратегический обзор', exact: true }).count(), 1);
              assert.equal(await card.getByRole('checkbox', { name: 'Другой обзор', exact: true }).count(), 1);
              assert.equal(await card.getByRole('checkbox', { name: 'Компоновщик рейсов', exact: false }).count(), 1);
              assert.equal(await card.getByRole('checkbox', { name: /Дашборды МР|Дашборды МС|менеджер.*(развити|сопровождени)/i }).count(), 0, 'personal manager dashboard groups are not purchaser grants');
              assert.equal(await card.getByText('Доступные дашборды — только просмотр', { exact: true }).count(), 1);
            }
            assert.equal(await create.locator('fieldset input:checked').count(), 0, 'new purchaser starts with no dashboard access');
            assert.equal(await existing.getByLabel('Имя', {exact:true}).isEditable(),true,'site admin retains existing profile editing');
            assert.equal(await existing.getByLabel('Логин', {exact:true}).isEditable(),true);
            assert.equal(await existing.getByLabel('Email', {exact:true}).isEditable(),true);
            assert.equal(await existing.getByRole('checkbox',{name:'Активен',exact:true}).isEnabled(),true);
            assert.equal(await existing.getByRole('button',{name:'Удалить',exact:true}).isEnabled(),true);
            await existing.getByRole('button',{name:'Изменить пароль',exact:true}).click();
            assert.equal(await existing.getByPlaceholder('Введите новый пароль').isEditable(),true,'site admin retains password change');
            await existing.getByRole('button',{name:'Отменить пароль',exact:true}).click();
            await existing.getByLabel('Другой обзор', { exact: true }).check();
            await existing.getByLabel('Стратегический обзор', { exact: true }).uncheck();
            await existing.getByRole('button', { name: 'Сохранить', exact: true }).click();
            await page.waitForFunction(() => (window as unknown as {fixtureCalls: unknown[]}).fixtureCalls.length === 1);
            const saved = (await page.evaluate('window.fixtureCalls'))[0];
            assert.equal(saved.method, 'PUT');
            assert.deepEqual(saved.payload.dashboardAccess, ['top:999', 'top:8'], 'unlisted current grant is preserved');
            await create.getByLabel('Имя', { exact: true }).fill('Новый закупщик');
            await create.getByLabel('Логин', { exact: true }).fill('new-buyer');
            await create.locator('input[name="new-purchaser-password"]').fill('SyntheticBuyer572');
            await create.getByLabel('Компоновщик рейсов', { exact: false }).check();
            await create.getByRole('button', { name: 'Добавить закупщика', exact: true }).click();
            await page.waitForFunction(() => (window as unknown as {fixtureCalls: unknown[]}).fixtureCalls.length === 2);
            const created = (await page.evaluate('window.fixtureCalls'))[1];
            assert.equal(created.payload.role, 'purchaser');
            assert.equal(created.payload.canManageTopDashboard, false);
            assert.deepEqual(created.payload.dashboardAccess, ['route-planner']);
            assert.equal(created.payload.dashboardOptionsVersion, 'b'.repeat(64));
            await create.getByRole('button', { name: 'Сохранено', exact: true }).waitFor();
            assert.equal(await create.locator('fieldset input:checked').count(), 0, 'successful creation resets new-user grants');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${engineName}/${width}: no horizontal overflow`);
            assert.equal(await create.evaluate((element: HTMLElement) => {
              const fieldset = element.querySelector('fieldset')!.getBoundingClientRect();
              const button = element.querySelector(':scope > button:last-child')!.getBoundingClientRect();
              return button.top >= fieldset.bottom && fieldset.width >= element.getBoundingClientRect().width * .8;
            }), true, 'full-width checkbox section precedes the add button');
            await page.screenshot({ path: path.join(output, `${engineName}-${width}.png`), fullPage: true });

            await page.goto(`${origin}/?missing=1`);
            await existing.getByRole('alert').waitFor();
            assert.equal(await existing.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(), true);
            assert.equal(await create.getByRole('button', { name: 'Добавить закупщика', exact: true }).isDisabled(), true);
            await existing.getByLabel('Имя', { exact: true }).fill('Несохранённое изменение');
            await page.evaluate('window.fixtureMissing = false');
            await existing.getByRole('button', { name: 'Повторить загрузку дашбордов', exact: true }).click();
            await existing.getByLabel('Стратегический обзор', { exact: true }).waitFor();
            assert.equal(await existing.getByLabel('Имя', { exact: true }).inputValue(), 'Несохранённое изменение', 'retry preserves unsaved edits');
            assert.equal(await existing.getByLabel('Стратегический обзор', { exact: true }).isChecked(), true, 'retry preserves existing grants');
            await existing.getByRole('button', { name: 'Сохранить', exact: true }).click();
            await page.waitForFunction(() => (window as unknown as {fixtureCalls: unknown[]}).fixtureCalls.length === 1);
            assert.deepEqual((await page.evaluate('window.fixtureCalls'))[0].payload.dashboardAccess, ['top:7', 'top:999']);

            await page.goto(`${origin}/?delegated=1`);
            await existing.getByLabel('Стратегический обзор', { exact: true }).waitFor();
            const assertGrantsOnly = async () => {
              for (const label of ['Имя','Логин','Email']) assert.equal(await existing.getByLabel(label,{exact:true}).isEditable(),false,`Admin TOP cannot edit existing ${label}`);
              assert.equal(await existing.locator('select').count(),1);
              assert.equal(await existing.locator('select').isDisabled(),true);
              assert.equal(await existing.getByRole('checkbox',{name:'Активен',exact:true}).isDisabled(),true);
              assert.equal(await existing.getByRole('button',{name:/Изменить пароль|Скопировать|Удалить/}).count(),0);
              assert.equal(await existing.getByPlaceholder('Пароль не сохранён').count(),0);
              assert.equal(await existing.locator('input[type="password"]').count(),0);
              assert.equal(await existing.getByRole('checkbox',{name:'Другой обзор',exact:true}).isEnabled(),true);
            };
            await assertGrantsOnly();
            assert.equal(await page.locator('input[value="CachedPurchaserPassword123"]').count(),0,'delegated mode never attaches local cached existing passwords');
            await existing.getByLabel('Другой обзор',{exact:true}).check();
            await existing.getByLabel('Стратегический обзор',{exact:true}).uncheck();
            await existing.getByRole('button',{name:'Сохранить',exact:true}).click();
            await page.waitForFunction(() => (window as unknown as {fixtureCalls:unknown[]}).fixtureCalls.length===1);
            const delegatedSave=(await page.evaluate('window.fixtureCalls'))[0];
            assert.equal(delegatedSave.url,'/api/admin/users/admin%3A42');
            assert.equal(delegatedSave.method,'PUT');
            assert.deepEqual(Object.keys(delegatedSave.payload).sort(),['canManageTopDashboard','dashboardAccess','dashboardAccessVersion','email','isActive','login','name','role','supportManagerId'],'delegated save has only existing metadata for server comparison and grants, never password fields');
            assert.deepEqual({name:delegatedSave.payload.name,login:delegatedSave.payload.login,email:delegatedSave.payload.email,role:delegatedSave.payload.role,isActive:delegatedSave.payload.isActive,canManageTopDashboard:delegatedSave.payload.canManageTopDashboard,supportManagerId:delegatedSave.payload.supportManagerId},
              {name:'Тестовый закупщик',login:'buyer',email:'buyer@example.test',role:'purchaser',isActive:true,canManageTopDashboard:false,supportManagerId:null},'delegated update preserves all existing metadata');
            assert.deepEqual(delegatedSave.payload.dashboardAccess,['top:999','top:8']);
            assert.equal(delegatedSave.payload.dashboardAccessVersion,'a'.repeat(64));
            await page.evaluate('window.fixtureCalls=[]');
            await page.getByRole('button', {name:'Админ прайсов',exact:true}).click();
            assert.equal(await page.locator('article').count(), 0, 'protected admin profile omitted even from a malicious response');
            assert.equal(await create.locator('select option[value="admin"]').count(), 0, 'delegated UI cannot offer site-admin role');
            assert.equal(await page.locator('input[value="ProtectedAdminPassword123"]').count(), 0, 'protected cached password never attached');
            for (const label of ['TOP','Админ TOP','МР','МС']) {
              await page.getByRole('button', {name:label,exact:true}).click();
              assert.equal(await create.locator('select option[value="admin"]').count(), 0);
              if(label!=='Админ TOP') await assertGrantsOnly();
              if(label==='TOP') {
                assert.equal(await existing.getByRole('checkbox',{name:'Админ TOP',exact:true}).isDisabled(),true,'existing management flag cannot be changed');
                assert.equal(await page.locator('input[value="UnexpectedServerPassword123"]').count(),0,'even unexpected server password cannot render in delegated mode');
              }
            }
            assert.equal(await page.locator('input[value="UnexpectedServerPassword123"]').count(),0,'even unexpected server password cannot render in delegated mode');
            await page.getByRole('button', {name:'Закупщик',exact:true}).click();
            assert.equal(await create.getByLabel('Стратегический обзор', {exact:true}).isChecked(), true, 'new employee inherits all-mode report by default');
            await create.getByLabel('Имя', {exact:true}).fill('Наследует доступы');
            await create.getByLabel('Логин', {exact:true}).fill('inherits-defaults');
            await create.locator('input[name="new-purchaser-password"]').fill('SyntheticBuyer572');
            await create.getByRole('button', {name:'Добавить закупщика',exact:true}).click();
            await page.waitForFunction(() => (window as unknown as {fixtureCalls: unknown[]}).fixtureCalls.length === 1);
            const inheritedPayload = (await page.evaluate('window.fixtureCalls'))[0].payload;
            assert.equal('dashboardAccess' in inheritedPayload, false, 'untouched creation uses current server defaults instead of stale empty grants');
            await create.getByRole('button', {name:'Сохранено',exact:true}).waitFor();
            await create.getByLabel('Имя', {exact:true}).fill('Конфликт выбора');
            await create.getByLabel('Логин', {exact:true}).fill('explicit-defaults');
            await create.locator('input[name="new-purchaser-password"]').fill('SyntheticBuyer572');
            await create.getByLabel('Стратегический обзор', {exact:true}).uncheck();
            await page.evaluate('window.fixtureConflict=true');
            await create.getByRole('button', {name:'Добавить закупщика',exact:true}).click();
            await create.getByRole('alert').waitFor();
            assert.equal(await create.getByLabel('Имя', {exact:true}).inputValue(),'Конфликт выбора');
            assert.equal(await create.getByRole('button',{name:'Добавить закупщика',exact:true}).isDisabled(),true);
            await page.evaluate("window.fixtureConflict=false;window.fixtureVersion='c'.repeat(64)");
            await create.getByRole('button',{name:'Повторить загрузку дашбордов',exact:true}).click();
            await create.getByLabel('Стратегический обзор', {exact:true}).waitFor();
            assert.equal(await create.getByLabel('Стратегический обзор', {exact:true}).isChecked(),false,'explicit uncheck survives refresh for review');
            await create.getByRole('button',{name:'Добавить закупщика',exact:true}).click();
            await page.waitForFunction(() => (window as unknown as {fixtureCalls: unknown[]}).fixtureCalls.length === 3);
            const retriedPayload = (await page.evaluate('window.fixtureCalls'))[2].payload;
            assert.deepEqual(retriedPayload.dashboardAccess,[]);
            assert.equal(retriedPayload.dashboardOptionsVersion,'c'.repeat(64));
            await page.screenshot({path:path.join(output,`${engineName}-${width}-admin-top.png`),fullPage:true});
            assert.deepEqual(errors, []);
            tested++;
            console.log(`${engineName}/${width}: grants, Admin TOP protected profiles/roles, inherited defaults, stale-list CAS retry and layout passed`);
          } finally { await context.close(); }
        }
      } finally { await browser.close(); }
    }
    assert.ok(tested > 0, 'at least one browser must be available');
    console.log(`Screenshots: ${output}`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
