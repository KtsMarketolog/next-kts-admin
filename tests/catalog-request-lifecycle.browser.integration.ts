/** Real catalogue form, fake HTTP only. No application DB, mail server or customer files. */
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
window.mode='ok';window.calls=[];window.statuses=[];window.aborted=0;window.written=false;
window.confirm=()=>true;
const product={id:17,title:'Synthetic existing',category:'A',subcategory:'B',brand:'C',article:'S-17',model:'M',priceGroup:'P',priceEur:'',priceRub:'100',priceCny:'',generalDiscount:'',manualDiscount:'',manualDiscountRop:'',stock:1,isExpected:false,isActive:true,unit:'шт.',stockUpdatedAt:null};
window.fetch=async(url,init={})=>{
 const method=init.method||'GET';window.calls.push({url,method});
 init.signal?.addEventListener('abort',()=>window.aborted++);
 if(method==='GET'){
  if(window.written&&window.mode==='reload-failure')throw new TypeError('Synthetic refresh failure');
  return Response.json(url.includes('/stock-import/logs')?{logs:[]}:{products:[product],filterOptions:{},stats:{products:1}});
 }
 if(window.mode==='reject')throw new TypeError('Synthetic offline');
 if(window.mode==='headers')return new Promise(()=>{}); // Intentionally ignores abort.
 if(window.mode==='body')return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}}));
 if(window.mode==='http')return Response.json({error:'Synthetic validation failure'},{status:400});
 window.written=true;
 if(url.includes('/check-email'))return Response.json({status:'completed',processed:1,result:{saved:true,status:'success',updatedRows:1,failedRows:0},warnings:[]});
 if(url.includes('/catalog/import'))return Response.json({result:{importedProducts:1,categories:1,subcategories:1,brands:1}});
 if(method==='DELETE')return Response.json({ok:true});
 return Response.json({product:{...product,...JSON.parse(init.body),id:method==='POST'?18:17}});
};
function Fixture(){const[status,setStatus]=useState('');const[visible,setVisible]=useState(true);window.hide=()=>setVisible(false);const showStatus=React.useCallback(message=>{window.statuses.push(message);setStatus(message);},[]);return <><p id="status">{status}</p>{visible&&<AdminCatalogSection showStatus={showStatus}/>}</>}
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
        for (const action of ['create', 'save', 'delete', 'excel', 'mail']) {
          for (const scenario of ['reject', 'headers', 'body', 'http', 'reload-failure', 'unmount']) {
            const page = await browser.newPage();
            await page.clock.install();
            const errors: string[] = [];
            page.on('pageerror', (error: Error) => errors.push(error.message));
            await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
            await page.goto(origin);
            await page.getByRole('button', { name: 'Сохранить', exact: true }).waitFor();
            const createTitle = page.getByLabel('Наименование', { exact: true }).first();
            await createTitle.fill('Synthetic draft retained');
            const labels: Record<string, string> = { create: 'Добавить товар', save: 'Сохранить', delete: 'Удалить', excel: 'Загрузить Excel', mail: 'Проверить почту сейчас' };
            const button = page.getByRole('button', { name: labels[action], exact: true });
            if (action === 'excel') await page.locator('input[type=file]').setInputFiles({ name: 'Synthetic.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from('fake upload bytes') });
            await page.evaluate(`window.mode=${JSON.stringify(scenario === 'unmount' ? 'headers' : scenario)}`);
            // Two clicks within one task must not bypass a pending React state update.
            await button.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
            await page.waitForFunction('window.calls.some(c=>c.method!=="GET")');
            if (scenario === 'unmount') {
              await page.evaluate('window.hide()');
              await page.waitForFunction('window.aborted>0');
              await page.clock.fastForward(300_001);
              assert.deepEqual(await page.evaluate('window.statuses'), [], 'leaving section does not emit a late operation result');
            } else {
              if (scenario === 'headers' || scenario === 'body') {
                assert.ok(await page.locator('button:disabled').count() > 0);
                await page.clock.fastForward(action === 'excel' || action === 'mail' ? 300_001 : 20_001);
              }
              await page.waitForFunction('document.getElementById("status").textContent.length>0');
              await page.waitForFunction('!document.querySelector("button:disabled")');
              const status = await page.locator('#status').innerText();
              if (scenario === 'reload-failure') {
                assert.match(status, /(?:сохранён|добавлен|удалён|загружен|сохранены).*(?:не обновился|не обновился)/i);
              } else if (scenario === 'http') assert.match(status, /Synthetic validation failure/);
              else assert.match(status, /могло сохраниться/);
              if (scenario !== 'reload-failure') assert.equal(await createTitle.inputValue(), 'Synthetic draft retained');
            }
            assert.equal(await page.evaluate('window.calls.filter(c=>c.method!=="GET").length'), 1, 'no automatic retry or same-tick duplicate');
            assert.deepEqual(errors, []);
            await page.close();
            tested++;
            console.log(`${engineName}/${action}/${scenario}: passed`);
          }
        }
      } finally { await browser.close(); }
    }
    assert.ok(tested > 0, 'No installed browser engine was tested');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
