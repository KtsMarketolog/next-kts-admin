/** Real public request form with synthetic isolated HTTP; no live submissions or SMTP. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const fixture = `
import React from 'react';import {createRoot} from 'react-dom/client';
import {PriceRequestForm} from './src/app/price/[token]/PriceRequestForm';
window.calls=JSON.parse(localStorage.getItem('fake-api-calls')||'[]');window.mode='lost';window.saved=new Map(JSON.parse(localStorage.getItem('fake-api-saved')||'[]'));window.receipts=window.saved.size;
const originalTimeout=AbortSignal.timeout;AbortSignal.timeout=(ms)=>originalTimeout(ms===45000?80:ms);
window.fetch=async(url,init={})=>{
 if(!url.endsWith('/request'))return Response.json({ok:true});
 const body=JSON.parse(init.body);window.calls.push(body);localStorage.setItem('fake-api-calls',JSON.stringify(window.calls));
 if(window.mode==='hold')await new Promise(resolve=>window.resume=resolve);
 if(window.mode==='timeout')await new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
 if(window.mode==='rollback')return Response.json({error:'SAVE_NOT_CONFIRMED'},{status:503});
 if(!window.saved.has(body.operationId))window.saved.set(body.operationId,String(++window.receipts));
 localStorage.setItem('fake-api-saved',JSON.stringify([...window.saved]));
 if(window.mode==='lost')throw new TypeError('Synthetic response lost after commit');
 if(window.mode==='malformed')return Response.json({ok:true});
 return Response.json({ok:true,saved:true,requestId:window.saved.get(body.operationId)});
};
navigator.sendBeacon=()=>true;
const categories=[{id:1,title:'Synthetic catalogue',products:[{id:3,title:'Synthetic product',model:'Test model',sku:'TEST',description:'',priceGroup:'Test group',imageUrl:null,priceGroupImageUrl:null,stockDisplayMode:'hidden',analogs:[],variants:[{id:7,priceItemId:11,title:'Base',priceEur:'10',priceRub:null,priceCny:null,wholesalePrice:null}]}]}];
createRoot(document.getElementById('root')).render(<PriceRequestForm token='synthetic-price' categories={categories} showRetailPrices={false}/>);
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
  const bundle = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' }, bundle: true,
    write: false, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@': path.join(root, 'src') },
    define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'fixture-css', setup(plugin) {
      plugin.onLoad({ filter: /\.module\.scss$/ }, () => ({ contents: 'export default new Proxy({},{get:(_,name)=>String(name)})', loader: 'js' }));
    } }],
  });
  const server = createServer((request, response) => {
    if (request.url === '/app.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  let tested = 0;
  try {
    for (const engineName of ['chromium', 'webkit']) {
      const browser = await playwright[engineName].launch({ headless: true });
      try {
        for (const scenario of ['lost', 'reload', 'rollback', 'timeout', 'malformed', 'hold']) {
          const page = await browser.newPage(); page.setDefaultTimeout(10_000);
          const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(origin);
          await page.getByRole('button', { name: 'Раскрыть', exact: true }).click();
          const quantity = page.getByRole('spinbutton');
          const comment = page.getByRole('textbox', { name: 'Комментарий к заявке' });
          const submit = page.getByRole('button', { name: 'Отправить заявку', exact: true });
          await quantity.fill('3'); await comment.fill('Synthetic customer note');
          await page.evaluate(`window.mode=${JSON.stringify(scenario === 'reload' ? 'lost' : scenario)}`);
          await submit.click();
          await page.waitForFunction('window.calls.length===1');
          if (scenario === 'hold') {
            assert.equal(await quantity.isDisabled(), true);
            assert.equal(await comment.isDisabled(), true);
            await page.locator('button[type=submit]').evaluate((button: HTMLButtonElement) => button.click());
            assert.equal(await page.evaluate('window.calls.length'), 1);
            await page.evaluate('window.mode="ok";window.resume()');
          } else {
            await page.getByText(/Сохранение заявки пока не подтверждено/).waitFor();
            assert.equal(await quantity.inputValue(), '3');
            assert.equal(await comment.inputValue(), 'Synthetic customer note');
            assert.equal(await submit.isEnabled(), true);
            if (scenario === 'reload') {
              assert.doesNotMatch(await page.evaluate('JSON.stringify({...sessionStorage})'), /customer note|quantity|comment|items/);
              await page.reload();
              await page.getByRole('button', { name: 'Раскрыть', exact: true }).click();
              await quantity.fill('3'); await comment.fill('Synthetic customer note');
            }
            await page.evaluate('window.mode="ok"'); await submit.click();
            await page.waitForFunction('window.calls.length===2');
            assert.equal(await page.evaluate('window.calls[0].operationId===window.calls[1].operationId'), true);
            assert.equal(await page.evaluate('window.receipts'), 1);
          }
          await page.getByText(/Заявка №1 сохранена/).waitFor();
          assert.equal(await page.evaluate('sessionStorage.length'), 0);
          assert.equal(await quantity.inputValue(), '0'); assert.equal(await comment.inputValue(), '');
          await quantity.fill('3'); await submit.click();
          await page.getByText(/Заявка №2 сохранена/).waitFor();
          assert.equal(await page.evaluate('window.calls.at(-1).operationId!==window.calls[0].operationId'), true);
          assert.deepEqual(errors, []);
          await page.close(); tested++; console.log('PASS', engineName, scenario);
        }
      } finally { await browser.close(); }
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  assert.equal(tested, 12);
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
