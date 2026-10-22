/** Real client editor with synthetic compare-and-swap HTTP; no application DB or customer data. */
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
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AdminClientsSection} from './src/features/admin/clients/AdminClientsSection';
import styles from './src/app/admin/admin.module.scss';
window.calls=[];window.revision=1;window.compareMode='ok';window.saved=[];
// PostgreSQL's real updated_at::text format, not an easier ISO fixture token.
const stamp=()=> '2026-10-23 00:00:00.'+String(window.revision).padStart(6,'0')+'+00';
const company=id=>({id,title:'Synthetic company '+id,email:'synthetic'+id+'@example.invalid',phone:'Original phone',note:'Original note',managerId:21,managerName:'Manager',supportManagerId:22,supportManagerName:'Support',requireTwoFactor:false,userCount:1,clientLogin:'synthetic'+id+'@example.invalid',clientUserId:id+20,passwordChangedAt:'2026-10-01T00:00:00Z',chatUnreadCount:0,isActive:true,archivedAt:null,createdAt:'2026-10-01T00:00:00Z',updatedAt:stamp()});
window.companies=[company(13),company(14)];
window.changeCompany=(id,patch)=>{window.revision++;window.companies=window.companies.map(item=>item.id===id?{...item,...patch,updatedAt:stamp()}:item);};
window.EventSource=class {addEventListener(){}close(){}};
window.fetch=async(url,init={})=>{
 const method=init.method||'GET';const body=init.body?JSON.parse(init.body):null;window.calls.push({url,method,body});
 if(url.includes('/wholesale/managers'))return Response.json({managers:[{id:21,name:'Manager',role:'manager',isActive:true},{id:22,name:'Support',role:'support_manager',isActive:true}]});
 if(url.endsWith('/password'))return Response.json({password:'CurrentSynthetic123'});
 if(method==='GET'){
  if(!url.startsWith('/api/admin/clients'))throw Error('Unexpected fixture read '+url);
  const all=url.includes('scope=all');
  if(all&&window.compareMode==='failure')return Response.json({error:'Synthetic comparison read failure'},{status:500});
  if(all&&window.compareMode==='forbidden')return Response.json({error:'Нет доступа к карточке клиента'},{status:403});
  let companies=structuredClone(window.companies);
  if(!all)companies=companies.filter(item=>url.includes('scope=archived')?item.archivedAt:!item.archivedAt);
  if(all&&window.compareMode==='malformed')delete companies[0].updatedAt;
  return Response.json({companies,canPermanentlyDelete:false});
 }
 if(method!=='PUT'||!/^\\/api\\/admin\\/clients\\/\\d+$/.test(url))throw Error('Unexpected fixture write '+method+' '+url);
 const id=Number(url.split('/').pop());const current=window.companies.find(item=>item.id===id);
 if(!current)return Response.json({saved:false,error:'Клиент не найден'},{status:404});
 if(current.archivedAt)return Response.json({saved:false,error:'Клиент перенесён в архив. Обновите данные.'},{status:409});
 if(body.expectedUpdatedAt!==current.updatedAt)return Response.json({saved:false,error:'Данные уже изменены другим пользователем. Обновите карточку.'},{status:409});
 const {password,expectedUpdatedAt,...fields}=body;window.changeCompany(id,fields);
 const saved=window.companies.find(item=>item.id===id);window.saved.push({id,password,expectedUpdatedAt,company:structuredClone(saved)});
 return Response.json({saved:true,company:saved,warnings:[]});
};
createRoot(document.getElementById('root')).render(<main id="fixture" className={styles.page}><AdminClientsSection onBack={()=>{}}/></main>);
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
  const output = await mkdtemp('/private/tmp/kts-client-conflict-ui-');
  const cssModules = new Map<string, string>();
  const bundle = await build({
    absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'fixture-platform', setup(plugin) {
      plugin.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'import React from "react";export default function Link(props){return <a {...props}/>}', loader: 'jsx', resolveDir: root }));
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
  const css = globals + [...cssModules].sort(([left], [right]) => Number(left.endsWith('/admin.module.scss')) - Number(right.endsWith('/admin.module.scss'))).map(([, value]) => value).join('\n')
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
        for (const testCase of ['merge-disabled-note', 'same-field-mine', 'same-field-server', 'discard-local',
          'comparison-failure', 'cancel-comparison', 'second-conflict', 'password', 'archived', 'deleted', 'forbidden', 'malformed', 'mobile-merge-disabled-note']) {
          const scenario = testCase.replace(/^mobile-/, '');
          const width = testCase.startsWith('mobile-') ? 390 : 1440;
          const page = await browser.newPage({ viewport: { width, height: 1200 } });
          page.setDefaultTimeout(10_000);
          const errors: string[] = [];
          page.on('pageerror', (error: Error) => errors.push(error.message));
          page.on('dialog', (dialog: { accept(): Promise<void> }) => void dialog.accept());
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(origin);
          const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Synthetic company 13', exact: true }) });
          const other = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Synthetic company 14', exact: true }) });
          await card.getByRole('button', { name: 'Раскрыть', exact: true }).click();
          await other.getByRole('button', { name: 'Раскрыть', exact: true }).click();
          await card.locator('textarea').fill('Local note to preserve');
          await other.locator('textarea').fill('Unrelated unsaved note');
          if (scenario === 'password') {
            await card.getByRole('button', { name: 'Изменить пароль', exact: true }).click();
            await card.getByPlaceholder('Введите новый пароль').fill('PendingSecretBeforeConflict123');
          }
          await page.evaluate(`window.changeCompany(13,{isActive:false${scenario.startsWith('same-field') ? ',note:"Remote note"' : ''}})`);
          const firstServerToken = await page.evaluate('window.companies[0].updatedAt');
          await card.getByRole('button', { name: 'Сохранить', exact: true }).click();
          await card.getByRole('heading', { name: 'Карточка изменена другим пользователем', exact: true }).waitFor();
          assert.equal(await card.locator('textarea').inputValue(), 'Local note to preserve');
          assert.equal(await page.evaluate('window.calls.filter(call=>call.method==="PUT").length'), 1);
          assert.equal(await page.evaluate('window.saved.length'), 0);
          assert.equal(await card.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(), true);

          if (scenario === 'merge-disabled-note') {
            await page.getByRole('button', { name: 'Обновить список', exact: true }).click();
            await page.getByText('Список обновлён. Несохранённые изменения в формах оставлены.', { exact: true }).waitFor();
            assert.equal(await card.locator('textarea').inputValue(), 'Local note to preserve');
            assert.equal(await card.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(), true);
            assert.equal(await other.locator('textarea').inputValue(), 'Unrelated unsaved note');
          }
          if (scenario === 'archived') await page.evaluate('window.changeCompany(13,{isActive:false,archivedAt:"2026-10-23T00:00:01Z"})');
          if (scenario === 'deleted') await page.evaluate('window.companies=window.companies.filter(company=>company.id!==13)');
          if (scenario === 'forbidden' || scenario === 'malformed') await page.evaluate(`window.compareMode=${JSON.stringify(scenario)}`);
          if (scenario === 'comparison-failure') await page.evaluate('window.compareMode="failure"');
          await card.getByRole('button', { name: 'Загрузить актуальную карточку', exact: true }).click();
          await page.waitForFunction('window.calls.some(call=>call.url.includes("scope=all"))');

          if (['archived', 'deleted', 'forbidden', 'malformed', 'comparison-failure'].includes(scenario)) {
            await card.getByRole('button', { name: 'Загрузить актуальную карточку', exact: true }).waitFor();
            assert.equal(await page.evaluate('window.calls.filter(call=>call.method==="PUT").length'), 1, 'comparison must never write or reactivate a client');
            const apply = card.getByRole('button', { name: 'Применить выбранные правки', exact: true });
            assert.equal(await apply.count() === 0 || await apply.isDisabled(), true);
            if (scenario !== 'comparison-failure') {
              assert.equal(await page.evaluate('window.saved.length'), 0);
              assert.deepEqual(errors, [], `${engineName}/${scenario}`);
              await page.close(); tested++; console.log(`${engineName}/${scenario}: comparison cannot revive unavailable company`);
              continue;
            }
            assert.equal(await card.locator('textarea').inputValue(), 'Local note to preserve');
            await page.evaluate('window.compareMode="ok"');
            await card.getByRole('button', { name: 'Загрузить актуальную карточку', exact: true }).click();
          }

          const noteChoice = card.getByRole('checkbox', { name: 'Перенести: Заметка', exact: true });
          await noteChoice.waitFor();
          assert.equal(await noteChoice.isChecked(), false, 'current server field wins until the administrator explicitly selects the draft');
          assert.equal(await page.evaluate('window.calls.filter(call=>call.method==="PUT").length'), 1, 'loading a comparison performs no write');
          assert.equal(await other.locator('textarea').inputValue(), 'Unrelated unsaved note');
          if (scenario === 'merge-disabled-note') {
            await page.evaluate('document.fonts.ready');
            assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true, `${engineName}/${width}: comparison must not overflow horizontally`);
            const checkbox = await noteChoice.boundingBox();
            assert.ok(checkbox && checkbox.width > 0 && checkbox.width <= 24 && checkbox.height > 0 && checkbox.height <= 24,
              `${engineName}/${width}: comparison checkbox must not inherit the full-width form-input dimensions`);
            const comparison = card.getByRole('region', { name: 'Карточка изменена другим пользователем', exact: true });
            for (const button of await comparison.getByRole('button').all()) {
              const bounds = await button.boundingBox();
              assert.ok(bounds && bounds.height >= 44,
                `${engineName}/${width}: comparison buttons must retain usable touch targets despite the shared admin cascade`);
            }
            await comparison.screenshot({ path: path.join(output, `${engineName}-${width}.png`) });
          }
          if (scenario === 'cancel-comparison') {
            await noteChoice.check();
            await card.getByRole('button', { name: 'Закрыть сравнение', exact: true }).click();
            assert.equal(await card.locator('textarea').inputValue(), 'Local note to preserve');
            assert.equal(await card.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(), true);
            assert.equal(await page.evaluate('window.calls.filter(call=>call.method==="PUT").length'), 1);
            await card.getByRole('button', { name: 'Загрузить актуальную карточку', exact: true }).click();
            await noteChoice.waitFor();
            assert.equal(await noteChoice.isChecked(), false, 'reopening comparison must not silently reuse earlier selections');
          }
          if (scenario === 'password') {
            assert.doesNotMatch(await card.innerText(), /PendingSecretBeforeConflict123/, 'comparison must not reveal or offer the pending password');
            assert.equal(await card.getByRole('checkbox', { name: /Перенести:.*пароль/i }).count(), 0);
          }
          const keepMine = scenario !== 'same-field-server' && scenario !== 'discard-local';
          if (keepMine) await noteChoice.check();
          await card.getByRole('button', { name: keepMine ? 'Применить выбранные правки' : 'Загрузить без моих правок', exact: true }).click();
          await card.getByRole('button', { name: 'Сохранить', exact: true }).waitFor({ state: 'visible' });
          assert.equal(await card.getByRole('button', { name: 'Сохранить', exact: true }).isEnabled(), true);
          const expectedNote = keepMine ? 'Local note to preserve' : scenario === 'same-field-server' ? 'Remote note' : 'Original note';
          assert.equal(await card.locator('textarea').inputValue(), expectedNote);
          assert.equal(await card.getByRole('checkbox', { name: 'Активна', exact: true }).isChecked(), false, 'resolving a note must not undo another administrator disabling access');
          assert.equal(await other.locator('textarea').inputValue(), 'Unrelated unsaved note');
          assert.equal(await page.evaluate('window.calls.filter(call=>call.method==="PUT").length'), 1, 'apply only prepares a draft, never autosaves');
          if (scenario === 'password') {
            assert.equal(await card.getByPlaceholder('Введите новый пароль').count(), 0, 'pending password must be cleared after explicit reconciliation');
            await card.getByRole('button', { name: 'Изменить пароль', exact: true }).click();
            await card.getByPlaceholder('Введите новый пароль').fill('ReenteredSynthetic123');
          }
          if (scenario === 'second-conflict') await page.evaluate('window.changeCompany(13,{phone:"Newest remote phone"})');
          await card.getByRole('button', { name: 'Сохранить', exact: true }).click();
          await page.waitForFunction('window.calls.filter(call=>call.method==="PUT").length===2');
          assert.equal(await page.evaluate('window.calls.filter(call=>call.method==="PUT")[1].body.expectedUpdatedAt'), firstServerToken, 'resolution must bind the next write to the fetched exact revision');
          if (scenario === 'second-conflict') {
            await card.getByRole('heading', { name: 'Карточка изменена другим пользователем', exact: true }).waitFor();
            assert.equal(await page.evaluate('window.saved.length'), 0);
            assert.equal(await page.evaluate('window.companies[0].phone'), 'Newest remote phone');
            assert.equal(await page.evaluate('window.companies[0].note'), 'Original note');
          } else {
            await page.waitForFunction('window.saved.length===1');
            assert.equal(await page.evaluate('window.saved[0].company.note'), expectedNote);
            assert.equal(await page.evaluate('window.saved[0].company.isActive'), false);
            assert.equal(await page.evaluate('window.saved[0].password'), scenario === 'password' ? 'ReenteredSynthetic123' : '');
          }
          assert.equal(await other.locator('textarea').inputValue(), 'Unrelated unsaved note');
          assert.equal(await page.evaluate('window.calls.filter(call=>call.method==="PUT").length'), 2, 'no implicit retries');
          assert.deepEqual(errors, [], `${engineName}/${scenario} has no unhandled browser rejection`);
          await page.close(); tested++; console.log(`${engineName}/${width}/${scenario}: conflict recovery acceptance passed`);
        }
      } finally { await browser.close(); }
    }
    assert.ok(tested > 0, 'No installed browser engine was tested');
    console.log(`Full CSS screenshots: ${output}`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
