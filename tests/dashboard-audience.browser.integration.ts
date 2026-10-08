/** Real access components, synthetic data, localhost only; never contacts production. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'sass';

const fixture = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {DashboardAudienceEditor} from './src/features/admin/dashboard-access/DashboardAudienceEditor';
import {AdminUsersDashboardAccessFields} from './src/features/admin/users/AdminUsersDashboardAccessFields';
const options=[{key:'top:7',title:'Общий отчёт'},{key:'currency-rates',title:'Курсы валют'},{key:'manager:development',title:'Дашборды МР'},{key:'manager:support',title:'Дашборды МС'}];
const employees=[
 {id:'admin:1',name:'Администратор',login:'admin',role:'admin',isActive:true,checked:true,locked:true,eligible:true},
 {id:'admin:2',name:'Анна',login:'anna',role:'purchaser',isActive:true,checked:false,locked:false,eligible:true},
 {id:'manager:3',name:'Борис',login:'boris',role:'manager',isActive:true,checked:false,locked:false,eligible:true},
 {id:'manager:4',name:'Неактивный',login:'inactive',role:'manager',isActive:false,checked:false,locked:false,eligible:true},
 {id:'manager:5',name:'Чужая группа',login:'other',role:'support_manager',isActive:true,checked:false,locked:false,eligible:false}
];
window.calls=[];window.conflict=false;window.deferOld=false;window.releaseOld=null;window.audienceMode='individual';
window.fetch=async(url,init={})=>{
 if(init.method==='PUT'){
  const body=JSON.parse(init.body);window.calls.push(body);
  if(window.conflict)return new Response(JSON.stringify({error:'Сотрудники или доступы уже изменены. Обновите список и повторите выбор.'}),{status:409});
  employees.forEach(user=>{if(!user.locked)user.checked=body.userIds.includes(user.id)});
  window.audienceMode=body.mode;
  return new Response(JSON.stringify({users:employees,mode:window.audienceMode,version:'version2'}));
 }
 const key=new URL(url,location.origin).searchParams.get('key');
 const result={users:key==='top:8'?[{...employees[1],name:'Новый отчёт'}]:employees,mode:window.audienceMode,version:'version1'};
 if(window.deferOld&&key==='top:7'){window.deferOld=false;await new Promise(resolve=>window.releaseOld=resolve)}
 return new Response(JSON.stringify(result));
};
function Fields({role,manage=false}){
 const [value,setValue]=useState(['manager:development']);
 return <div data-testid={role}><AdminUsersDashboardAccessFields value={value} onChange={setValue} role={role} canManageTopDashboard={manage} options={options} disabled={false} loading={false} error={null} onRetry={()=>{}}/></div>
}
function App(){const [key,setKey]=useState('top:7');return <main>
 <button onClick={()=>setKey('top:8')}>Другой дашборд</button>
 <div data-testid="audience"><DashboardAudienceEditor dashboardKey={key}/></div>
 <Fields role="manager"/><Fields role="admin"/><Fields role="purchaser"/>
</main>}
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
  const screenshots = await mkdtemp('/private/tmp/kts-dashboard-audience-ui-');
  const styles: string[] = [];
  const bundle = await build({
    stdin: { contents: fixture, resolveDir: root, loader: 'tsx' }, absWorkingDir: root,
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'styles', setup(plugin) {
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        const css = compile(args.path).css;
        const names = [...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]);
        const prefix = `module${styles.length}_`;
        styles.push(css.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.${prefix}${name}`));
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, prefix + name])))};`, loader: 'js' };
      });
    } }],
  });
  const server = createServer((request, response) => {
    if (request.url === '/app.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else if (request.url === '/style.css') response.writeHead(200, { 'Content-Type': 'text/css' }).end(`*{box-sizing:border-box}body{font-family:Arial;margin:16px}main{max-width:1200px;margin:auto}${styles.join('\n')}`);
    else response.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }).end('<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        for (const width of [1440, 390]) {
          const context = await browser.newContext({ viewport: { width, height: 1100 } });
          await context.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          try {
            const page = await context.newPage();
            const errors: string[] = [];
            page.on('pageerror', (error: Error) => errors.push(error.message));
            await page.goto(origin);
            const audience = page.getByTestId('audience');
            await audience.getByRole('checkbox', { name: /Администратор/ }).waitFor();
            assert.equal(await audience.getByRole('heading', { name: 'Кому доступен отчёт', exact: true }).count(), 1);
            assert.equal(await audience.getByRole('checkbox', { name: /Администратор/ }).isDisabled(), true);
            assert.equal(await audience.getByRole('checkbox', { name: /Чужая группа/ }).isDisabled(), true);
            const role = audience.getByRole('combobox', { name: 'Роль сотрудников', exact: true });
            const selectRole = audience.getByRole('button', { name: 'Выбрать сотрудников роли', exact: true });
            const clearRole = audience.getByRole('button', { name: 'Снять выбор роли', exact: true });
            assert.equal(await selectRole.isDisabled(), true, 'all roles is not a persisted wildcard selection');
            await role.selectOption('manager');
            assert.equal(await audience.getByRole('checkbox').count(), 2);
            assert.match(await audience.getByRole('checkbox', { name: /Борис/ }).locator('..').innerText(), /МР — менеджеры по развитию/);
            await audience.getByRole('textbox', { name: 'Поиск сотрудников' }).fill('no-matching-employee');
            assert.equal(await audience.getByRole('checkbox').count(), 0);
            await selectRole.click();
            await audience.getByRole('textbox').fill('');
            assert.equal(await audience.getByRole('checkbox', { name: /Борис/ }).isChecked(), true, 'role bulk selection ignores the search');
            assert.equal(await audience.getByRole('checkbox', { name: /Неактивный/ }).isChecked(), false, 'role selection excludes inactive employees');
            await clearRole.click();
            assert.equal(await audience.getByRole('checkbox', { name: /Борис/ }).isChecked(), false);
            await role.selectOption('support_manager');
            assert.equal(await selectRole.isDisabled(), true, 'private audience ineligibility cannot be bypassed by role selection');
            await role.selectOption('admin');
            assert.equal(await selectRole.isDisabled(), true, 'management rights remain locked');
            assert.equal(await clearRole.isDisabled(), true);
            await role.selectOption('purchaser');
            await selectRole.click();
            assert.equal(await audience.getByRole('checkbox', { name: /Анна/ }).isChecked(), true);
            await audience.getByRole('checkbox', { name: /Анна/ }).uncheck();
            assert.equal(await audience.getByRole('checkbox', { name: /Анна/ }).isChecked(), false, 'individual checkboxes override the bulk draft selection');
            await role.selectOption('top');
            assert.equal(await selectRole.isDisabled(), true, 'an empty role never selects employees from other profiles');
            await role.selectOption('');
            await audience.getByRole('textbox', { name: 'Поиск сотрудников' }).fill('anna');
            assert.equal(await audience.getByRole('checkbox').count(), 1);
            await audience.getByRole('button', { name: 'Выбрать всех', exact: true }).click();
            await audience.getByRole('textbox').fill('');
            assert.equal(await audience.getByRole('checkbox', { name: /Борис/ }).isChecked(), true, 'select all includes active users hidden by search');
            assert.equal(await audience.getByRole('checkbox', { name: /Неактивный/ }).isChecked(), true, 'all mode includes inactive accounts for later activation');
            await audience.getByRole('button', { name: 'Сохранить доступы', exact: true }).click();
            await audience.getByRole('status').filter({ hasText: 'Доступы сохранены' }).waitFor();
            const saved = (await page.evaluate('window.calls'))[0];
            assert.deepEqual(saved.userIds, ['admin:1', 'admin:2', 'manager:3', 'manager:4']);
            assert.equal(saved.mode, 'all', 'only explicit select-all enables future employees');
            assert.deepEqual(Object.keys(saved).sort(), ['key', 'mode', 'userIds', 'version'], 'role bulk selection never persists a role rule');
            await audience.getByRole('button', {name:'Оставить только текущий выбор',exact:true}).click();
            assert.equal(await audience.getByRole('checkbox', {name:/Борис/}).isChecked(),true,'switching to individual preserves current checkboxes');
            await audience.getByRole('button', {name:'Сохранить доступы',exact:true}).click();
            await audience.getByRole('status').filter({hasText:'Доступы сохранены'}).waitFor();
            assert.equal((await page.evaluate('window.calls')).at(-1).mode,'individual');
            await role.selectOption('manager');
            await clearRole.click();
            await role.selectOption('');
            assert.equal(await audience.getByRole('checkbox', { name: /Борис/ }).isChecked(), false);
            assert.equal(await audience.getByRole('checkbox', { name: /Анна/ }).isChecked(), true, 'clear role leaves all other roles untouched');
            await role.selectOption('manager');
            await selectRole.click();
            await role.selectOption('');
            await audience.getByRole('button', { name: 'Снять выбор', exact: true }).click();
            assert.equal(await audience.getByRole('checkbox', { name: /Администратор/ }).isChecked(), true);
            await page.evaluate('window.conflict=true');
            await audience.getByRole('button', { name: 'Сохранить доступы', exact: true }).click();
            await audience.getByRole('status').filter({ hasText: 'Обновите список' }).waitFor();
            assert.equal(await audience.getByRole('checkbox', { name: /Борис/ }).isChecked(), false, 'conflict preserves draft, never silently overwrites');
            await audience.getByRole('button', { name: 'Обновить список', exact: true }).click();
            await audience.getByRole('button', { name: 'Сохранить доступы', exact: true }).waitFor();
            assert.equal(await audience.getByRole('checkbox', { name: /Борис/ }).isChecked(), true);
            const manager = page.getByTestId('manager');
            assert.equal(await manager.getByRole('checkbox', { name: 'Дашборды МР', exact: true }).isChecked(), true);
            assert.equal(await manager.getByRole('checkbox', { name: 'Дашборды МС', exact: true }).isDisabled(), true);
            await manager.getByRole('checkbox', { name: 'Общий отчёт', exact: true }).check();
            assert.equal(await manager.getByRole('checkbox', { name: 'Общий отчёт', exact: true }).isChecked(), true);
            assert.equal(await page.getByTestId('admin').locator('input:disabled:checked').count(), 4);
            assert.equal(await page.getByTestId('purchaser').getByRole('checkbox', { name: 'Дашборды МР', exact: true }).isChecked(), false);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            if (width < 500) assert.ok((await role.boundingBox())!.width > width * .65, 'role names remain readable in the mobile selector');
            assert.ok((await role.boundingBox())!.height >= 40, 'native browser selector stays large enough to use');
            await page.screenshot({ path: path.join(screenshots, `${engine}-${width}.png`), fullPage: true });
            await page.evaluate('window.deferOld=true');
            await audience.getByRole('button', { name: 'Обновить список', exact: true }).click();
            await page.waitForFunction('window.releaseOld !== null');
            await page.getByRole('button', { name: 'Другой дашборд', exact: true }).click();
            await audience.getByRole('checkbox', { name: /Новый отчёт/ }).waitFor();
            await page.evaluate('window.releaseOld()');
            await audience.getByRole('button', { name: 'Сохранить доступы', exact: true }).click();
            await audience.getByRole('status').waitFor();
            assert.equal(await audience.getByRole('checkbox', { name: /Новый отчёт/ }).count(), 1, 'old response cannot replace new dashboard audience');
            assert.equal((await page.evaluate('window.calls')).at(-1).key, 'top:8');
            assert.deepEqual(errors, []);
            console.log(`${engine}/${width}: role bulk selection, employee scopes, search, CAS conflict and stale-response protection passed`);
          } finally { await context.close(); }
        }
      } finally { await browser.close(); }
    }
    console.log(`Screenshots: ${screenshots}`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
