/**
 * Isolated browser acceptance check. No production connection or private fixtures in Git.
 * node --import tsx tests/support-shared-route-planner.browser.integration.ts
 * Optional real fixtures: KTS_ROUTE_PLANNER_HTML_DIR and KTS_ROUTE_PLANNER_JSON.
 * All non-local requests are blocked; map tiles are synthetic image responses.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildSupportSharedRoutePlannerFrame,
  detectSupportSharedHtmlFormat,
  injectSupportSharedRoutePlannerAdapter,
  supportSharedRoutePlannerCsp,
} from '../src/shared/lib/supportSharedRoutePlannerHtml';

const syntheticHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic route planner</title></head><body>
<input type="file" id="snapIn"><p id="rows">0</p><button id="change" onclick="document.getElementById('rows').dataset.clicked='yes'">Synthetic action</button>
<button id="print" onclick="UI.print()">Print</button><script>
const S = {}; const revive = value => value; const descriptor = {app:'компоновщик'};
function loadSnapshot(j) { S.orders = revive(j.orders); document.getElementById('rows').textContent = S.orders.length; }
function handleFiles(list) { return list; }
window.UI = {openSnapshot() {}, print() {const w=window.open('','_blank');w.document.write('<html><body><table><tr><td>Synthetic print</td></tr></table><script>window.parent.__unsafePrint=true<\\/script><img src="https://blocked.example.test/print"><form action="https://blocked.example.test/"></form></body></html>');w.document.close();setTimeout(()=>w.print(),300);}};
</script></body></html>`;
const syntheticJson = Buffer.from(JSON.stringify({snapshot: true, app: 'компоновщик', savedAt: '2026-09-17T05:28:47.226Z', orders: [{id: 1}, {id: 2}]}));
const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64');

async function main() {
  const modulePath = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const realDir = process.env.KTS_ROUTE_PLANNER_HTML_DIR;
  const realJsonPath = process.env.KTS_ROUTE_PLANNER_JSON;
  const fixtures: Array<{name: string; html: string; json: Buffer; jsonPath?: string; rows: number}> = [{name: 'synthetic', html: syntheticHtml, json: syntheticJson, rows: 2}];
  if (realDir && realJsonPath) {
    const name = (await readdir(realDir)).find(name => name.endsWith('.html'));
    assert.ok(name, 'The real fixture directory has an HTML file');
    const json = await readFile(realJsonPath);
    const parsed = JSON.parse(json.toString('utf8'));
    assert.equal(parsed.snapshot, true);
    fixtures.push({name: 'real', html: await readFile(path.join(realDir, name), 'utf8'), json, jsonPath: realJsonPath, rows: parsed.orders.length});
  }
  let active = fixtures[0];
  let dataRequests = 0;
  let lastDataQuery = new URLSearchParams();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const common = {'Cache-Control': 'no-store'};
    if (url.pathname === '/') {
      const preview = (url.searchParams.has('preview') ? '&preview=1' : '')
        + (url.searchParams.has('empty') ? '&empty=1' : '');
      response.writeHead(200, {...common, 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'fixture-auth=secret; SameSite=Strict'}).end(`<!doctype html><html><body><iframe id="outer" sandbox="allow-scripts allow-same-origin allow-modals" style="width:100%;height:950px" src="/api/admin/manager-dashboard/shared/frame?version=7${preview}"></iframe><script>
window.addEventListener('message',e=>{if(e.source!==document.getElementById('outer').contentWindow||e.origin!==location.origin||e.data?.type!=='download-request')return;const a=document.createElement('a');a.href=URL.createObjectURL(e.data.blob);a.download=e.data.name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});</script></body></html>`);
    } else if (url.pathname.endsWith('/frame')) {
      const frame = buildSupportSharedRoutePlannerFrame({versionId: 7, snapshotId: url.searchParams.has('empty') ? undefined : 9, preview: url.searchParams.has('preview')});
      response.writeHead(200, {...common, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': frame.csp}).end(frame.html);
    } else if (url.pathname.endsWith('/content')) {
      const content = injectSupportSharedRoutePlannerAdapter(active.html);
      response.writeHead(200, {...common, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': supportSharedRoutePlannerCsp(content)}).end(content);
    } else if (url.pathname.endsWith('/json')) {
      dataRequests += 1;
      lastDataQuery = url.searchParams;
      response.writeHead(200, {...common, 'Content-Type': 'application/json', 'Content-Length': active.json.length, 'X-KTS-Shared-Version': '7', 'X-KTS-Shared-Snapshot': '9', 'X-KTS-Shared-Sha256': createHash('sha256').update(active.json).digest('hex')});
      if (active.jsonPath) createReadStream(active.jsonPath).pipe(response); else response.end(active.json);
    } else response.writeHead(404, common).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  let engines = 0;
  try {
    for (const engineName of ['chromium', 'webkit']) {
      const engine = playwright[engineName];
      try { await access(engine.executablePath()); } catch { console.log(`SKIP ${engineName}: executable unavailable`); continue; }
      engines += 1;
      const browser = await engine.launch({headless: true});
      try {
        for (const fixture of fixtures) {
          active = fixture;
          assert.equal(detectSupportSharedHtmlFormat(active.html), 'route-planner-v1');
          const context = await browser.newContext({viewport: {width: 1440, height: 1100}, timezoneId: 'Europe/Moscow', acceptDownloads: true});
          const page = await context.newPage();
          let tiles = 0;
          let printCalls = 0;
          const blocked: string[] = [];
          const errors: string[] = [];
          const browserWarnings: string[] = [];
          await context.exposeBinding('__fixturePrinted', () => { printCalls += 1; });
          await context.addInitScript(() => {
            window.print = () => { (window as unknown as {__fixturePrinted(): void}).__fixturePrinted(); };
            (window as unknown as {__fixtureMessages: unknown[]}).__fixtureMessages = [];
            window.addEventListener('message', event => {
              const data = event.data;
              (window as unknown as {__fixtureMessages: unknown[]}).__fixtureMessages.push({type: data?.type, marker: data?.marker, bytes: data?.blob?.size});
            });
          });
          await context.route('**/*', async (route: {request(): {url(): string}; continue(): Promise<void>; fulfill(value: unknown): Promise<void>; abort(): Promise<void>}) => {
            const url = new URL(route.request().url());
            if (url.protocol === 'blob:' || url.protocol === 'data:') return route.continue();
            if (url.origin === origin) return route.continue();
            if (url.hostname === 'tile.openstreetmap.org' && /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)) {
              tiles += 1; return route.fulfill({status: 200, contentType: 'image/png', headers: {'Access-Control-Allow-Origin': '*'}, body: tile});
            }
            blocked.push(url.origin); return route.abort();
          });
          page.on('pageerror', (error: Error) => errors.push(error.message));
          page.on('console', (message: {type(): string; text(): string}) => {
            if (message.type() === 'error') browserWarnings.push(message.text().slice(0, 300));
          });
          const started = Date.now();
          await page.goto(origin);
          const wrapper = page.frameLocator('#outer');
          const report = wrapper.frameLocator('#report');
          await wrapper.locator('#status').waitFor({state: 'hidden', timeout: 30000}).catch(async (error: unknown) => {
            console.error(JSON.stringify({engine: engineName, fixture: fixture.name, status: await wrapper.locator('#status').innerText(), runtimeErrors: errors, warnings: browserWarnings, requests: dataRequests}));
            for (const frame of page.frames()) console.error(JSON.stringify(await frame.evaluate(() => ({url: location.pathname, ready: document.readyState, scripts: document.scripts.length, ui: !!(window as unknown as {UI: unknown}).UI, messages: (window as unknown as {__fixtureMessages: unknown[]}).__fixtureMessages, resources: performance.getEntriesByType('resource').map(entry => ({name: new URL(entry.name).pathname, duration: entry.duration, bytes: (entry as PerformanceResourceTiming).decodedBodySize}))}))));
            throw error;
          });
          const loadMs = Date.now() - started;
          assert.equal(lastDataQuery.has('preview'), false, 'Manager view uses the manager-only JSON path');
          assert.equal(await report.locator('input[type="password"],input[type="email"]').count(), 0);
          const reportFrame = page.frames().find((frame: {url(): string}) => frame.url().includes('/content?'));
          assert.ok(reportFrame);
          const reportedHeapBytes = await reportFrame.evaluate(() => (performance as unknown as {memory?: {usedJSHeapSize: number}}).memory?.usedJSHeapSize ?? null);
          const isolation = await reportFrame.evaluate(async () => {
            let parentBlocked = false, cookiesBlocked = false, fetchBlocked = false;
            try { void window.parent.document.body; } catch { parentBlocked = true; }
            try { void document.cookie; } catch { cookiesBlocked = true; }
            try { await fetch('/api/admin/manager-dashboard/shared/json?version=7'); } catch { fetchBlocked = true; }
            return {parentBlocked, cookiesBlocked, fetchBlocked};
          });
          assert.deepEqual(isolation, {parentBlocked: true, cookiesBlocked: true, fetchBlocked: true});
          if (fixture.name === 'synthetic') {
            assert.equal(await report.locator('#rows').innerText(), '2');
            await report.locator('#change').click();
            assert.equal(await report.locator('#rows').getAttribute('data-clicked'), 'yes');
            await report.locator('#print').click();
          } else {
            await report.locator('[onclick^="UI.go(\'data\')"]').click();
            const expectedRows = new Intl.NumberFormat('ru-RU').format(fixture.rows).replace(/\s/g, '');
            assert.ok((await report.locator('#body').innerText()).replace(/\s/g, '').includes(expectedRows), 'Loaded row count is displayed');
            await report.locator('[onclick^="UI.go(\'map\')"]').click();
            await report.locator('#mapbox .leaflet-tile').first().waitFor({state: 'attached', timeout: 10000});
            assert.ok(tiles > 0, 'The map requests only mocked map tiles');
            const downloadEvent = page.waitForEvent('download', {timeout: 60000});
            await report.locator('[onclick="UI.xls()"]') .click();
            const download = await downloadEvent;
            assert.ok(download.suggestedFilename().endsWith('.xlsx'));
            const saved = await download.path();
            assert.ok(saved);
            const exported = await readFile(saved);
            assert.equal(exported.subarray(0, 2).toString(), 'PK');
            await report.locator('[onclick^="UI.go(\'routes\')"]').click();
            await report.locator('[onclick^="UI.print("]').first().click();
          }
          await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#outer')?.contentDocument?.querySelector('#print-report'), {timeout: 10000});
          const printFrame = wrapper.frameLocator('#print-report');
          assert.equal(await printFrame.locator('script,img,form').count(), 0);
          assert.equal(await page.evaluate(() => !!(window as unknown as {__unsafePrint?: boolean}).__unsafePrint), false);
          await page.waitForTimeout(200);
          assert.ok(printCalls > 0, 'Print reached the browser print boundary');
          assert.deepEqual(errors, [], 'No report runtime errors');
          assert.deepEqual(blocked, [], 'No unexpected external network requests');
          const beforePreview = dataRequests;
          await page.goto(origin + '/?preview=1');
          await wrapper.locator('#status').waitFor({state: 'hidden', timeout: 30000});
          assert.equal(dataRequests, beforePreview + 1, 'Administrator preview fetches its bound shared snapshot exactly once');
          assert.equal(lastDataQuery.get('preview'), '1');
          assert.equal(lastDataQuery.get('version'), '7');
          assert.equal(lastDataQuery.get('snapshot'), '9');
          if (fixture.name === 'synthetic') {
            assert.equal(await report.locator('#rows').innerText(), '2', 'Admin preview displays the snapshot data');
          } else {
            await report.locator('[onclick^="UI.go(\'data\')"]').click();
            const expectedRows = new Intl.NumberFormat('ru-RU').format(fixture.rows).replace(/\s/g, '');
            assert.ok((await report.locator('#body').innerText()).replace(/\s/g, '').includes(expectedRows), 'Admin preview displays the real snapshot row count');
            const tilesBeforePreviewMap = tiles;
            await report.locator('[onclick^="UI.go(\'map\')"]').click();
            await report.locator('#mapbox .leaflet-tile').first().waitFor({state: 'attached', timeout: 10000});
            assert.ok(tiles > tilesBeforePreviewMap, 'Preview map uses the same restricted tile bridge as the manager report');
          }
          const beforeEmptyPreview = dataRequests;
          await page.goto(origin + '/?preview=1&empty=1');
          await report.locator('body').waitFor();
          assert.equal(await wrapper.locator('#status').innerText(), 'Для этой версии HTML общий JSON ещё не опубликован.');
          await page.waitForTimeout(300);
          assert.equal(dataRequests, beforeEmptyPreview, 'Preview without its own JSON never fetches another version’s data');
          assert.deepEqual(errors, [], 'Manager and administrator preview have no report runtime errors');
          assert.deepEqual(blocked, [], 'Preview also makes no unexpected external requests');
          console.log(JSON.stringify({engine: engineName, fixture: fixture.name, bytes: fixture.json.length, rows: fixture.rows, loadMs, reportedHeapBytes, tiles, printCalls, previewWithData: 'pass', emptyPreview: 'pass', result: 'pass'}));
          await context.close();
        }
      } finally { await browser.close(); }
    }
    assert.ok(engines > 0, 'At least one browser engine must be installed');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
