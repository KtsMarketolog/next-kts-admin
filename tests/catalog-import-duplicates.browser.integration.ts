/** Real catalogue UI/CSS with synthetic responses only; no application database or customer files. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'sass';

const fixture = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {AdminCatalogSection} from './src/features/admin/catalog/AdminCatalogSection';
import styles from './src/app/admin/admin.module.scss';
window.mode='ok';window.calls=[];
const product={id:17,title:'Исходный товар',category:'A',subcategory:'B',brand:'C',article:'S-17',model:'M',priceGroup:'P',priceEur:'',priceRub:'100',priceCny:'',generalDiscount:'',manualDiscount:'',manualDiscountRop:'',stock:1,isExpected:false,isActive:true,unit:'шт.',stockUpdatedAt:null};
window.fetch=async(url,init={})=>{
 const method=init.method||'GET';window.calls.push({url,method,fileName:init.body instanceof FormData?init.body.get('file')?.name:null});
 if(method==='GET')return Response.json(url.includes('/stock-import/logs')?{logs:[]}:{products:[product],filterOptions:{},stats:{products:1}});
 if(!url.includes('/catalog/import'))throw new Error('Unexpected fixture mutation');
 if(window.mode==='network')throw new TypeError('Synthetic offline');
 if(window.mode==='duplicates')return Response.json({error:'В Excel найдены повторяющиеся артикулы.',code:'CATALOG_DUPLICATE_ARTICLES',duplicates:[{article:'00123',rows:[5,12,108],totalRows:3},{article:'LongArticle_БезПробеловДляПроверкиПереносаНаМобильномЭкране_987654321',rows:[8,24],totalRows:2}],duplicateCount:2,truncated:false},{status:400});
 if(window.mode==='truncated')return Response.json({error:'В Excel найдены повторяющиеся артикулы.',code:'CATALOG_DUPLICATE_ARTICLES',duplicates:[{article:'A-777',rows:Array.from({length:100},(_,i)=>i+20),totalRows:130}],duplicateCount:125,truncated:true},{status:400});
 if(window.mode==='existing')return Response.json({error:'В существующем каталоге найден неоднозначный артикул S-17. Требуется проверить записи товаров.',code:'CATALOG_EXISTING_DUPLICATE_ARTICLES',duplicates:[{article:'S-17',productIds:[17,21],totalProducts:2}],duplicateCount:1,truncated:false},{status:409});
 return Response.json({result:{importedProducts:1,categories:1,subcategories:1,brands:1}});
};
function Fixture(){const[status,setStatus]=useState('');window.clearStatus=()=>setStatus('');const showStatus=React.useCallback(message=>setStatus(message),[]);return <main className={styles.page}><p id="toast">{status}</p><AdminCatalogSection showStatus={showStatus}/></main>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;

async function main() {
  const root = path.resolve('.');
  const runtime = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const output = await mkdtemp(path.join(tmpdir(), 'kts-catalog-duplicates-ui-'));
  let css = '', index = 0;
  const bundle = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'real-css', setup(plugin) {
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        const contents = compile(args.path, { importers: [{ findFileUrl(url) { return url.startsWith('@/') ? pathToFileURL(path.join(root, 'src', url.slice(2))) : null; } }] }).css.replace(/:global\(([^)]+)\)/g, '$1');
        const names = [...new Set([...contents.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]))];
        const prefix = `catalogfixture${index++}_`;
        css += contents.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.${prefix}${name}`);
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, prefix + name])))}`, loader: 'js' };
      });
    } }],
  });
  const globalCss = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/app.js') return void response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    if (url.pathname === '/style.css') return void response.writeHead(200, { 'Content-Type': 'text/css' }).end(globalCss + css);
    if (/^\/fonts\/montserrat\/montserrat-[a-z-]+\.woff2$/.test(url.pathname)) return void response.writeHead(200, { 'Content-Type': 'font/woff2' }).end(await readFile(path.join(root, 'public', url.pathname)));
    return void response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        for (const width of [1440, 390, 320]) {
          const page = await browser.newPage({ viewport: { width, height: 1000 } });
          page.setDefaultTimeout(10_000);
          const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(origin);
          await page.getByRole('button', { name: 'Сохранить', exact: true }).waitFor();
          const file = page.locator('input[type=file]');
          const importButton = page.getByRole('button', { name: 'Загрузить Excel', exact: true });
          const form = page.locator('form').first();
          const choose = async (name: string) => file.setInputFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('synthetic bytes; API responses are fixture-controlled') });
          const catalogReads = () => page.evaluate('window.calls.filter(call=>call.method==="GET"&&call.url.includes("/catalog/products")).length');
          const mutationCount = () => page.evaluate('window.calls.filter(call=>call.method!=="GET").length');

          // Establish a previous successful result, then ensure an error cannot leave that stale success visible.
          await choose('previous-success.xlsx'); await importButton.click();
          await form.getByText(/^Загружено: 1;/).waitFor();
          await page.waitForFunction('!document.querySelector("button:disabled")');
          const draftTitle = page.getByLabel('Наименование', { exact: true }).first();
          const productTitle = page.getByLabel('Наименование', { exact: true }).nth(1);
          await draftTitle.fill('Несохранённый новый товар');
          await productTitle.fill('Несохранённая правка существующего товара');
          const beforeReads = await catalogReads();
          await page.evaluate('window.mode="duplicates"');
          await choose('duplicates.xlsx');
          assert.equal(await form.getByText(/^Загружено:/).count(), 0, 'selecting another file clears the previous success');
          const beforePost = await mutationCount();
          await importButton.evaluate((node: HTMLButtonElement) => { node.click(); node.click(); });
          const alert = page.getByRole('alert');
          await alert.getByRole('heading', { name: 'Импорт остановлен', exact: true }).waitFor();
          await alert.getByText('Строки Excel: 5, 12, 108.', { exact: true }).waitFor();
          await alert.getByText('Строки Excel: 8, 24.', { exact: true }).waitFor();
          assert.match(await alert.innerText(), /Артикул: 00123/);
          assert.match(await alert.innerText(), /Каталог, остатки и прайсы не изменены/);
          assert.equal(await catalogReads(), beforeReads, 'duplicate failure never reloads catalogue or stock');
          assert.equal(await mutationCount(), beforePost + 1, 'same-tick double submit sends one import');
          assert.equal(await draftTitle.inputValue(), 'Несохранённый новый товар');
          assert.equal(await productTitle.inputValue(), 'Несохранённая правка существующего товара');
          assert.equal(await file.evaluate((node: HTMLInputElement) => node.files?.[0]?.name), 'duplicates.xlsx', 'rejected file remains selected');
          assert.equal(await importButton.isEnabled(), true, 'error releases upload button');
          assert.equal(await file.isEnabled(), true, 'error releases file picker');
          await page.evaluate('window.clearStatus()');
          assert.equal(await page.locator('#toast').innerText(), '');
          assert.equal(await alert.isVisible(), true, 'error remains after toast disappears');
          await page.evaluate(() => document.fonts.ready);
          assert.equal(await alert.evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth), true, 'long articles fit the visible alert');
          assert.equal(await form.evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth), true, 'error does not widen upload form');
          await form.screenshot({ path: path.join(output, `${engine}-${width}-duplicates.png`) });

          // A corrected file clears the error; successful retry follows the normal single reload path.
          await page.evaluate('window.mode="ok"');
          await choose('corrected.xlsx');
          assert.equal(await alert.count(), 0, 'new file clears old duplicate diagnostics');
          await importButton.click();
          await form.getByText(/^Загружено: 1;/).waitFor();
          await page.waitForFunction('!document.querySelector("button:disabled")');
          assert.equal(await alert.count(), 0);
          assert.equal(await file.evaluate((node: HTMLInputElement) => node.files?.length), 0, 'successful import clears selected file');
          assert.equal(await catalogReads(), beforeReads + 1, 'corrected retry reloads only after success');

          await page.evaluate('window.mode="truncated"'); await choose('many-duplicates.xlsx'); await importButton.click();
          await alert.getByText(/показано 100 из 130/).waitFor();
          assert.match(await alert.innerText(), /Артикулов с повторами: 125/);
          assert.match(await alert.innerText(), /Показано: 1/);
          assert.match(await alert.innerText(), /Список сокращён/);
          const list = alert.getByRole('list', { name: 'Повторяющиеся артикулы и строки Excel', exact: true });
          await list.focus(); await list.press('ArrowDown');
          assert.equal(await list.evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth), true);
          await form.screenshot({ path: path.join(output, `${engine}-${width}-truncated.png`) });

          await page.evaluate('window.mode="existing"'); await choose('existing-conflict.xlsx'); await importButton.click();
          await alert.getByText(/В существующем каталоге найден неоднозначный артикул/).waitFor();
          assert.match(await alert.innerText(), /Каталог, остатки и прайсы не изменены/);
          assert.doesNotMatch(await alert.innerText(), /Строки Excel/);
          assert.equal(await alert.getByRole('list').count(), 0, 'existing product IDs are not misrepresented as Excel rows');

          await page.evaluate('window.mode="network"'); await choose('network.xlsx'); await importButton.click();
          await alert.getByText(/Изменение могло сохраниться/).waitFor();
          assert.doesNotMatch(await alert.innerText(), /Каталог, остатки и прайсы не изменены/);
          assert.equal(await importButton.isEnabled(), true);
          assert.equal(await file.evaluate((node: HTMLInputElement) => node.files?.[0]?.name), 'network.xlsx');
          assert.equal(await catalogReads(), beforeReads + 1, 'neither conflict nor unknown result reloads edits');
          assert.deepEqual(errors, []);
          await page.close();
          console.log(`${engine}/${width}: exact Excel rows, persistent alert, truncation, retained edits/file, no failure reload, corrected retry and unknown outcome passed`);
        }
      } finally { await browser.close(); }
    }
    console.log(`Screenshots: ${output}`);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
