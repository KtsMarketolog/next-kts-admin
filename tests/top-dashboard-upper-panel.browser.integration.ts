/**
 * Actual TOP management uploader in isolated Chromium/WebKit with synthetic
 * API and preview frames only. Never sends requests to the production site.
 * node --import tsx tests/top-dashboard-upper-panel.browser.integration.ts
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { compile } from 'sass';

const fixtureEntry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AdminTopDashboardSection} from './src/features/admin/top-dashboard/AdminTopDashboardSection';
import {decodeTopDashboardMultiFileSnapshot} from './src/shared/lib/topDashboardMultiFileSnapshot';
import styles from './src/app/admin/admin.module.scss';
const date='2026-09-17T06:00:00Z';
const scenario=new URLSearchParams(location.search).get('case')||'multiple';
const target=(id,index,multiple=false)=>({target:{id,name:null,index},multiple,directory:false,accept:'.json,.json.gz',label:id==='sales'?'Продажи':'Остатки'});
const targets=scenario==='multiple'?[target('sales',0,true)]:[target('sales',0),target('inventory',1,true)];
const version=(id,status)=>({id,status,originalName:'synthetic-'+id+'.html',fileSize:1000,sha256:'a'.repeat(64),uploadedByName:'Тест',firstPublishedByName:'Тест',firstPublishedAt:date,createdAt:date});
const snapshot=id=>({id,originalName:'synthetic-'+id+'.ktsmf',fileSize:1000,uncompressedSize:900,sha256:'b'.repeat(64),snapshotFormat:'multi-file-v1',boundHtmlVersionId:10,status:'active',uploadedByName:'Тест',createdAt:date});
window.fixtureOverview={block:{id:7,title:'Синтетический обзор',createdAt:date},activeVersionId:10,previousVersionId:null,updatedAt:date,versions:[version(10,'active'),version(11,'draft')],data:{activeVersionId:200,previousVersionId:199,updatedAt:date,versions:[snapshot(200),{...snapshot(199),status:'previous'}]},activeDataContract:{htmlVersionId:10,mode:'generic',snapshotFormat:'multi-file-v1',profile:'generic',directUploadTarget:null,uploadTargets:scenario==='runtime'?[]:targets}};
window.fixtureRuntimeTargets=scenario==='runtime'?targets:null;
window.fixtureUploads=[];window.fixtureRuntimeUploads=[];window.fixtureStatuses=[];window.fixtureConfirms=[];window.fixtureConfirmAllowed=true;window.fixtureFail=false;window.fixtureConflict=false;window.fixtureOverviewLoads=0;
window.confirm=message=>{window.fixtureConfirms.push(message);return window.fixtureConfirmAllowed};
window.fixtureCommit=()=>{const o=window.fixtureOverview;const id=o.data.activeVersionId+1;o.data={...o.data,previousVersionId:o.data.activeVersionId,activeVersionId:id,versions:[snapshot(id),...o.data.versions.map(v=>({...v,status:'previous'}))]};};
window.fixtureChangeVersion=()=>{const o=window.fixtureOverview;o.activeVersionId=11;o.activeDataContract={...o.activeDataContract,htmlVersionId:11};o.versions=o.versions.map(v=>({...v,status:v.id===11?'active':'archived'}));};
const originalFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 if(input==='/api/admin/top-dashboard/blocks/7'&&(!init?.method||init.method==='GET')){window.fixtureOverviewLoads++;return Response.json(window.fixtureOverview);}
 if(input==='/api/admin/top-dashboard/blocks/7/data'&&init?.method==='PUT'){
  const decoded=decodeTopDashboardMultiFileSnapshot(await init.body.arrayBuffer());
  window.fixtureUploads.push({headers:init.headers,targets:decoded.targets.map(t=>({target:t.target,files:t.files.map(f=>({name:f.name,type:f.type,path:f.webkitRelativePath,text:new TextDecoder().decode(f.bytes)}))}))});
  if(window.fixtureConflict){window.fixtureChangeVersion();return Response.json({error:'HTML изменился'}, {status:409});}
  if(window.fixtureFail)return Response.json({error:'Синтетическая ошибка сохранения'},{status:500});
  window.fixtureCommit();return Response.json({ok:true});
 }
 return originalFetch(input,init);
};
createRoot(document.getElementById('root')).render(<main className={styles.page}><AdminTopDashboardSection blockId={7} showStatus={message=>{window.fixtureStatuses.push(message)}}/></main>);
`;

const frameHtml = `<!doctype html><meta charset="utf-8"><p>Синтетический предпросмотр</p><script>
addEventListener('message',async event=>{
 if(event.source!==parent||event.origin!==location.origin||event.data?.marker!=='kts-top-dashboard-management-v1')return;
 const d=event.data;
 if(d.type==='probe-upload-targets'&&parent.fixtureRuntimeTargets){parent.postMessage({marker:d.marker,type:'upload-targets',blockId:7,htmlVersionId:d.htmlVersionId,targets:parent.fixtureRuntimeTargets},location.origin);}
 if(d.type==='upload-files'){
  const targets=[];for(const entry of d.targets){const files=[];for(const file of entry.files)files.push({name:file.name,path:file.webkitRelativePath,text:await file.blob.text()});targets.push({target:entry.target,files});}
  parent.fixtureRuntimeUploads.push({blockId:d.blockId,htmlVersionId:d.htmlVersionId,expectedActiveDataVersionId:d.expectedActiveDataVersionId,targets});
  parent.fixtureCommit();parent.postMessage({marker:d.marker,type:'upload-result',blockId:d.blockId,htmlVersionId:d.htmlVersionId,requestId:d.requestId,ok:true},location.origin);
 }
});</script>`;

async function main() {
  const root = path.resolve('.');
  const require = createRequire(path.join(root, 'package.json'));
  let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!modulePath) {
    try { modulePath = path.dirname(require.resolve('playwright/package.json')); }
    catch { modulePath = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  let css = '';
  const bundle = await build({
    absWorkingDir: root, stdin: { contents: fixtureEntry, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' }, alias: { '@': path.join(root, 'src') },
    plugins: [{ name: 'isolated-components', setup(plugin) {
      plugin.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'next/navigation', namespace: 'mock-next' }));
      plugin.onLoad({ filter: /.*/, namespace: 'mock-next' }, () => ({ contents: 'const router={replace(){},push(){}};export const useRouter=()=>router;', loader: 'js' }));
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        css += compile(args.path, { importers: [{ findFileUrl(url) {
          return url.startsWith('@/') ? pathToFileURL(path.join(root, 'src', url.slice(2))) : null;
        } }] }).css;
        const names = [...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]);
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map(name => [name, name])))};`, loader: 'js' };
      });
    } }],
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    else if (url.pathname === '/fixture.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else if (url.pathname === '/fixture.css') response.writeHead(200, { 'Content-Type': 'text/css' }).end(css);
    else if (/^\/api\/admin\/top-dashboard\/blocks\/7\/versions\/\d+\/frame$/.test(url.pathname)) response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(frameHtml);
    else response.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.route('**/*', async (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => {
          if (route.request().url().startsWith(origin + '/')) await route.continue();
          else await route.abort();
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        const json = (name: string, value: number) => ({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ value })) });
        await page.goto(`${origin}/?case=multiple`);
        const sales = page.getByLabel('Выбрать данные: Продажи', { exact: true });
        await sales.setInputFiles([json('sales.json', 1), json('inventory.json', 2)]);
        const assertHistoryBelowReport = async () => {
          assert.deepEqual(await page.evaluate(() => {
            const preview = document.querySelector('.topDashboardPreviewCard');
            const data = document.getElementById('top-dashboard-data-history');
            const html = document.getElementById('top-dashboard-html-history');
            return [Boolean(preview && data && (preview.compareDocumentPosition(data) & Node.DOCUMENT_POSITION_FOLLOWING)),
              Boolean(data && html && (data.compareDocumentPosition(html) & Node.DOCUMENT_POSITION_FOLLOWING))];
          }), [true, true], 'both histories follow the report, in desktop and mobile layouts');
        };
        await assertHistoryBelowReport();
        await page.setViewportSize({ width: 390, height: 844 });
        await assertHistoryBelowReport();
        await page.setViewportSize({ width: 1440, height: 1000 });
        assert.equal(await sales.getAttribute('multiple'), '');
        await page.getByRole('button', { name: 'Заменить для всех', exact: true }).click();
        await page.waitForFunction(() => (window as any).fixtureStatuses.includes('Данные обновлены для всех пользователей'));
        const uploaded = await page.evaluate(() => (window as any).fixtureUploads[0]);
        assert.equal(uploaded.headers['X-KTS-Top-Dashboard-Direct-Files'], '1');
        assert.equal(uploaded.headers['X-KTS-Top-Data-Expected-Version'], '200');
        assert.equal(uploaded.headers['X-KTS-Top-HTML-Version'], '10');
        assert.deepEqual(uploaded.targets[0].files.map((file: { name: string }) => file.name), ['sales.json', 'inventory.json']);
        assert.equal(uploaded.targets[0].files[1].text, '{"value":2}');
        assert.match(await page.evaluate(() => (window as any).fixtureConfirms[0]), /Выбрано файлов: 2[\s\S]*Поля: Продажи/);
        assert.equal(await page.getByRole('button', { name: 'Заменить для всех', exact: true }).isDisabled(), true);
        assert.ok(await page.evaluate(() => (window as any).fixtureOverviewLoads >= 2));

        await page.goto(`${origin}/?case=targets`);
        await page.getByLabel('Выбрать данные: Продажи', { exact: true }).setInputFiles(json('sales.json', 3));
        await page.getByLabel('Выбрать данные: Остатки', { exact: true }).setInputFiles([json('stock-a.json', 4), json('stock-b.json', 5)]);
        await page.evaluate(() => { (window as any).fixtureConfirmAllowed = false; });
        await page.getByRole('button', { name: 'Заменить для всех', exact: true }).click();
        assert.equal(await page.evaluate(() => (window as any).fixtureUploads.length), 0);
        await page.evaluate(() => { (window as any).fixtureConfirmAllowed = true; });
        await page.getByRole('button', { name: 'Заменить для всех', exact: true }).click();
        await page.waitForFunction(() => (window as any).fixtureStatuses.includes('Данные обновлены для всех пользователей'));
        const targets = await page.evaluate(() => (window as any).fixtureUploads[0].targets);
        assert.deepEqual(targets.map((entry: { target: { id: string }; files: unknown[] }) => [entry.target.id, entry.files.length]), [['sales', 1], ['inventory', 2]]);

        await page.getByLabel('Выбрать данные: Продажи', { exact: true }).setInputFiles(json('stale.json', 6));
        await page.evaluate(() => { (window as any).fixtureConflict = true; });
        await page.getByRole('button', { name: 'Заменить для всех', exact: true }).click();
        await page.waitForFunction(() => (window as any).fixtureStatuses.includes('HTML изменился'));
        await page.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'Заменить для всех')?.disabled);
        assert.equal(await page.getByRole('button', { name: 'Заменить для всех', exact: true }).isDisabled(), true);
        assert.equal(await page.evaluate(() => (window as any).fixtureOverview.data.activeVersionId), 201);

        await page.goto(`${origin}/?case=runtime`);
        await page.getByLabel('Выбрать данные: Продажи', { exact: true }).setInputFiles(json('runtime-sales.json', 7));
        await page.getByLabel('Выбрать данные: Остатки', { exact: true }).setInputFiles([json('runtime-stock.json', 8), json('runtime-stock-2.json', 9)]);
        await page.getByRole('button', { name: 'Заменить для всех', exact: true }).click();
        await page.waitForFunction(() => (window as any).fixtureStatuses.includes('Данные обновлены для всех пользователей'));
        assert.equal(await page.evaluate(() => (window as any).fixtureUploads.length), 0, 'runtime targets never bypass frame validation through direct API');
        const runtime = await page.evaluate(() => (window as any).fixtureRuntimeUploads[0]);
        assert.equal(runtime.expectedActiveDataVersionId, 200);
        assert.equal(runtime.htmlVersionId, 10);
        assert.equal(runtime.targets[1].files[1].text, '{"value":9}');
        assert.equal(await page.getByRole('button', { name: 'Заменить для всех', exact: true }).isDisabled(), true);
        assert.deepEqual(errors, []);
        await context.close();
        console.log(`${engine}: static multi-file/multi-input envelopes, confirmation, CAS reset and runtime bridge passed`);
      } finally { await browser.close(); }
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
