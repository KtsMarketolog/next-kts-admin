/** Real stock controls with synthetic HTTP: never connects to IMAP or the application DB. */
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AdminCatalogSection} from './src/features/admin/catalog/AdminCatalogSection';
window.mode='ok';window.calls=[];window.checked=false;
window.fetch=async(url,init={})=>{
 window.calls.push({url,method:init.method||'GET'});
 if(url.includes('/catalog/products'))return Response.json({products:[],filterOptions:{},stats:{products:0}});
 if(url.includes('/stock-import/logs')){
  if(window.checked&&window.mode==='reload-failure')throw new TypeError('Synthetic reload failure');
  return Response.json({logs:[]});
 }
 if(url.includes('/stock-import/check-email')){
  window.checked=true;
  if(window.mode==='reject')throw new TypeError('Synthetic lost response');
  if(window.mode==='rollback')return Response.json({saved:false,error:'Остатки не сохранены: синтетическая ошибка журнала'},{status:400});
  if(window.mode==='unknown')return Response.json({saved:null,code:'COMMIT_OUTCOME_UNKNOWN',error:'Не удалось подтвердить сохранение. Проверьте журнал импорта.'},{status:503});
  return Response.json({status:'completed',processed:1,result:{saved:true,status:window.mode==='invalid'?'failed':'success',updatedRows:window.mode==='invalid'?0:3,failedRows:window.mode==='invalid'?2:0,alreadyApplied:window.mode==='replay'},warnings:window.mode==='warning'?[{code:'stock_mail_move_failed',message:'Результат импорта сохранён, но письмо не перенесено в архив.'}]:[]});
 }
 throw new Error('Unexpected synthetic URL');
};
function Fixture(){const[status,setStatus]=useState('');return <><p id="status">{status}</p><AdminCatalogSection showStatus={setStatus}/></>}
createRoot(document.getElementById('root')).render(<Fixture/>);
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
    plugins: [{ name: 'synthetic-css', setup(plugin) {
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
        for (const scenario of ['warning', 'reload-failure', 'rollback', 'reject', 'unknown', 'replay', 'invalid']) {
          const page = await browser.newPage();
          const errors: string[] = [];
          page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(origin);
          const button = page.getByRole('button', { name: 'Проверить почту сейчас', exact: true });
          await button.waitFor();
          await page.evaluate(`window.mode=${JSON.stringify(scenario)}`);
          await button.click();
          await page.waitForFunction('document.getElementById("status").textContent.length>0');
          await button.waitFor();
          assert.equal(await button.isEnabled(), true, 'stock button recovers after every outcome');
          const status = await page.locator('#status').innerText();
          if (scenario === 'warning') assert.match(status, /Остатки сохранены.*письмо не перенесено/);
          if (scenario === 'reload-failure') assert.match(status, /Остатки сохранены.*список журнала не обновился/);
          if (scenario === 'rollback') assert.match(status, /Остатки не сохранены.*синтетическая ошибка/);
          if (scenario === 'reject') assert.match(status, /запрос мог завершиться сохранением/);
          if (scenario === 'unknown') assert.match(status, /Не удалось подтвердить сохранение/);
          if (scenario === 'replay') assert.match(status, /уже обработано.*повторно не изменялись/);
          if (scenario === 'invalid') assert.match(status, /Остатки не изменены.*Результат проверки записан/);
          assert.equal(await page.evaluate('window.calls.filter(c=>c.method==="POST").length'), 1, 'no automatic retry after an uncertain outcome');
          assert.deepEqual(errors, []);
          await page.close();
          tested++;
          console.log(`${engineName}/${scenario}: stock result acceptance passed`);
        }
      } finally { await browser.close(); }
    }
    assert.ok(tested > 0, 'No installed browser engine was tested');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
