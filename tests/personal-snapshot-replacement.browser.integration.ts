/** Real React controls, synthetic files/API only; no production traffic. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'sass';
import postcss from 'postcss';

const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {PersonalSnapshotReplacement} from './src/features/admin/manager-dashboard/PersonalSnapshotReplacement';
import styles from './src/features/admin/manager-dashboard/ManagerDashboard.module.scss';
const current={id:2,originalName:'текущий.ktsp',fileSize:2048,sha256:'a'.repeat(64),issued:'2026-10-22',expires:'2026-12-01',receivedAt:'2026-10-22T08:00:00Z'};
const previous={...current,id:1,originalName:'предыдущий.ktsp'};
const recipient={source:'admin',id:5,name:'Тестовый руководитель',email:'synthetic@example.test'};
const groups=[{audience:'development',managers:[{...recipient,snapshot:current,previousSnapshot:previous}]}];
window.calls=[];window.failNext=false;
async function mutate(path,init){
  const action=init.body.get('action'); const file=init.body.get('file');
  window.calls.push({path,action,token:init.body.get('token'),confirmed:init.body.get('confirmed'),file:file?.name,source:init.body.get('recipientSource'),id:init.body.get('recipientId')});
  await new Promise(resolve=>setTimeout(resolve,25));
  if(window.failNext){window.failNext=false;return null;}
  if(action.startsWith('prepare'))return {preview:{action:action==='prepare'?'replace':'rollback',token:'signed_confirmation_token',recipient,current,previous,
    incoming:action==='prepare'?{...current,id:undefined,originalName:file.name,fileSize:file.size}:previous}};
  return {results:[{originalName:file?.name??previous.originalName,status:'imported',message:'Подтверждено'}]};
}
createRoot(document.getElementById('app')).render(<div className={styles.dashboardPage}><PersonalSnapshotReplacement groups={groups} busy={false} mutate={mutate}/></div>);`;

async function main() {
  const root = process.cwd();
  const css: string[] = [];
  const bundle = await build({ stdin: { contents: fixture, resolveDir: root, loader: 'tsx' }, bundle: true, write: false,
    platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@': path.join(root, 'src') },
    define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'styles', setup(plugin) {
      plugin.onLoad({ filter: /\.module\.scss$/ }, args => {
        const compiled = compile(args.path).css;
        const names = [...compiled.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(match => match[1]);
        const prefix = path.basename(args.path).replace(/\W/g, '_') + '_';
        const parsed = postcss.parse(compiled);
        parsed.walkRules(rule => { rule.selector = rule.selector.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.${prefix}${name}`); });
        css.push(parsed.toString());
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map(name => [name, prefix + name])))}`, loader: 'js' };
      });
    } }] });
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'application/javascript' : 'text/html; charset=utf-8');
    res.end(req.url === '/app.js' ? bundle.outputFiles[0].text : `<html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:Arial;margin:16px;background:#f4f4f7}*{box-sizing:border-box}${css.join('\n')}</style></head><body><div id="app"></div><script src="/app.js"></script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const modulePath = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const screenshots = await mkdtemp('/private/tmp/kts-snapshot-replacement-ui-');
  try {
    for (const name of ['chromium', 'webkit']) {
      const browser = await playwright[name].launch({ headless: true });
      try {
        for (const width of [1440, 390]) {
          const page = await browser.newPage({ viewport: { width, height: 1000 } });
          const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) =>
            new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
          await page.goto(origin);
          const fileInput = page.getByLabel('Исправленный личный .ktsp · до 8 МБ');
          await fileInput.setInputFiles({ name: 'исправленный.ktsp', mimeType: 'application/octet-stream', buffer: Buffer.from('synthetic-file') });
          await page.getByRole('button', { name: 'Проверить замену', exact: true }).click();
          const confirm = page.getByRole('button', { name: 'Подтвердить замену', exact: true });
          await confirm.waitFor();
          assert.match(await page.getByLabel('Подтверждение изменения личного снимка').innerText(), /Тестовый руководитель/);
          assert.deepEqual(await page.evaluate(() => (window as unknown as { calls: { action: string }[] }).calls.map(call => call.action)), ['prepare']);
          await page.screenshot({ path: `${screenshots}/${name}-${width}.png`, fullPage: true });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'no horizontal page overflow');
          await page.getByRole('button', { name: 'Отмена', exact: true }).click();
          assert.equal(await confirm.count(), 0, 'cancel never submits a replacement');
          await page.getByRole('button', { name: 'Проверить замену', exact: true }).click(); await confirm.waitFor();
          await page.evaluate(() => { (window as unknown as { failNext: boolean }).failNext = true; });
          await confirm.click(); await page.getByRole('alert').waitFor();
          assert.equal(await confirm.isEnabled(), true, 'failed confirmation releases busy state and preserves preview for idempotent retry');
          await confirm.click(); await page.getByRole('heading', { name: 'Результат замены / отката' }).waitFor();
          assert.equal(await fileInput.inputValue(), '');
          await page.getByLabel('Восстановить предыдущий снимок сотрудника').selectOption('admin:5');
          await page.getByRole('button', { name: 'Проверить откат', exact: true }).click();
          await page.getByRole('button', { name: 'Подтвердить откат', exact: true }).click();
          await page.getByRole('heading', { name: 'Результат замены / отката' }).waitFor();
          const calls = await page.evaluate(() => (window as unknown as { calls: Array<Record<string, string>> }).calls);
          assert.deepEqual(calls.map((call: Record<string, string>) => call.action), ['prepare', 'prepare', 'confirm', 'confirm', 'prepare-rollback', 'confirm-rollback']);
          assert.equal(calls[2].token, calls[3].token); assert.equal(calls[3].confirmed, 'true');
          assert.equal(calls[4].source, 'admin'); assert.equal(calls[4].id, '5');
          assert.deepEqual(errors, []);
          await page.close(); console.log(`PASS ${name} ${width}: prepare/cancel/retry/confirm/rollback/layout`);
        }
      } finally { await browser.close(); }
    }
    console.log(`Screenshots: ${screenshots}`);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
