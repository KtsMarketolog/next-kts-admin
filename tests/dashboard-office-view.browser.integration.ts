/**
 * Office mode through the production adapters, trusted bridge and both CSPs.
 * Synthetic local reports and snapshots only; no credentials or external requests.
 * Run: node --import tsx tests/dashboard-office-view.browser.integration.ts
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { injectSalesOfficeView } from '../src/shared/lib/dashboardOfficeView';
import {
  buildTopDashboardContentSecurityPolicy,
  buildTopDashboardFrameSecurityPolicy,
  createTopDashboardFrameBridgeScript,
  detectTopDashboardDataContract,
  injectTopDashboardDataAdapter,
} from '../src/shared/lib/topDashboardContentSecurity';
import { prepareInteractiveDashboardHtml } from '../src/shared/lib/topDashboardContentSecurity/preparedHtml';
import { instrumentSalesRestoreReadySource, type SalesRestoreBodyRange } from '../src/shared/lib/topDashboardContentSecurity/salesRestoreReady';
import { encodeTopDashboardMultiFileSnapshot } from '../src/shared/lib/topDashboardMultiFileSnapshot';

type Fixture = 'legacy-async' | 'legacy-slow' | 'legacy-failure' | 'legacy-change'
  | 'legacy-render-failure' | 'legacy-capture-failure' | 'legacy-promise-unconfirmed' | 'legacy-unconfirmed'
  | 'generic-unconfirmed' | 'generic-ready' | 'generic-load-state' | 'unsupported';
type ReadyRecord = { loaded: boolean; revision: number; restoreId: number; finalized: boolean; renderCalls: number };
type ReportState = {
  started: number;
  waiting: boolean;
  loaded: boolean;
  revision: number;
  officeOpens: number;
  ready: ReadyRecord[];
  errors: number[];
  release(): void;
};
type ReportWindow = Window & { officeTest: ReportState };
type FrameWindow = Window & { messages: Array<{ type: string; code?: string; confirmation?: string }> };
const dataPath = '/api/admin/top-dashboard/blocks/7/data';
const framePath = '/api/admin/top-dashboard/blocks/7/versions/51/frame';
const contentPath = '/api/admin/top-dashboard/blocks/7/versions/51/content';
const fixtures: Fixture[] = ['legacy-async', 'legacy-slow', 'legacy-failure', 'legacy-change',
  'legacy-render-failure', 'legacy-capture-failure', 'legacy-promise-unconfirmed', 'legacy-unconfirmed',
  'generic-unconfirmed', 'generic-ready', 'generic-load-state'];
const snapshot = Buffer.from(JSON.stringify({ format: 'kts-bundle', revision: 1 }));

function instrumentSyntheticSales(html: string) {
  const start = html.indexOf('<script>') + '<script>'.length;
  const end = html.indexOf('</script>', start);
  const source = html.slice(start, end);
  const parsed = ts.createSourceFile('synthetic-sales.js', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  const bodies = new Map<string, SalesRestoreBodyRange>();
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      bodies.set(statement.name.text, { bodyStart: statement.body.getStart(parsed), bodyEnd: statement.body.end });
    }
  }
  const acceptBundle = bodies.get('acceptBundle');
  const render = bodies.get('render');
  const k3Capture = bodies.get('k3Capture');
  assert.ok(acceptBundle && render && k3Capture);
  // Exercise the production body transformation on synthetic functions. Public
  // HTML recognition still requires the exact reviewed author-script fingerprint.
  const instrumented = instrumentSalesRestoreReadySource(source, { acceptBundle, render, k3Capture });
  assert.ok(instrumented);
  return html.slice(0, start) + instrumented + html.slice(end);
}

function reportHtml(fixture: Fixture) {
  if (fixture === 'unsupported') return '<!doctype html><html><head></head><body><main>Другой отчёт</main></body></html>';
  const legacy = fixture.startsWith('legacy-');
  const native = legacy && !fixture.endsWith('-unconfirmed');
  const directHandler = legacy && fixture !== 'legacy-unconfirmed' && fixture !== 'legacy-change';
  const strategic = fixture === 'generic-load-state';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Аналитика продаж</title></head><body>
<nav>Обычная навигация</nav><main>${strategic ? 'СТРАТЕГИЧЕСКИЙ ОБЗОР ГРУППЫ' : 'Полный отчёт'}
<input type="file" id="file" accept=".json"><span id="result">Данные не загружены</span></main><div id="tvbox" hidden></div><script>
${legacy ? 'const DASH_NAME="аналитика_продаж"; const spec={format:"kts-bundle"};' : ''}
window.officeTest={started:0,waiting:false,loaded:false,revision:0,officeOpens:0,finalized:false,renderCalls:0,ready:[],errors:[],release(){}};
let restore=null;
window.addEventListener('kts-top-dashboard-restore-start',event=>{restore=event.detail;});
window.addEventListener('kts-top-dashboard-data-ready',event=>{officeTest.ready.push({loaded:officeTest.loaded,revision:officeTest.revision,restoreId:event.detail&&event.detail.restoreId,finalized:officeTest.finalized,renderCalls:officeTest.renderCalls});});
window.addEventListener('kts-top-dashboard-data-error',event=>{officeTest.errors.push(event.detail&&event.detail.restoreId);});
function render(){try {officeTest.renderCalls++;${fixture === 'legacy-render-failure' ? "if(officeTest.renderCalls===2)throw new Error('Synthetic caught render failure');" : ''}${native ? 'k3Capture();' : 'officeTest.revision++;'}officeTest.loaded=true;document.getElementById('result').textContent='Данные загружены: '+officeTest.revision;} catch (err){document.getElementById('result').textContent='Ошибка построения отчёта';}}
function tvEsc(event){if(event.key==='Escape')document.getElementById('tvbox').hidden=true;}
function renderTv(){document.getElementById('tv-body').textContent='Рейтинг сотрудников — снимок '+officeTest.revision;}
function openTv(){officeTest.officeOpens++;if(!officeTest.loaded)return;const box=document.getElementById('tvbox');box.innerHTML='<div class="${fixture === 'legacy-slow' ? 'tvbar' : 'tv-bar'}"><button>Закрыть</button></div><div id="tv-body"></div>';box.hidden=false;renderTv();document.addEventListener('keydown',tvEsc);}
// Экран для офиса
async function waitForProcessing(files){officeTest.started++;await files[0].text();await new Promise(resolve=>{officeTest.waiting=true;officeTest.release=()=>{officeTest.waiting=false;resolve();};});${fixture === 'legacy-failure' ? "throw new Error('Synthetic processing failure');" : ''}}
${native ? `function k3Capture(){try {${fixture === 'legacy-capture-failure' ? "throw new Error('Synthetic caught capture failure');" : 'return true;'}} catch (e){document.getElementById('result').textContent='Ошибка подготовки данных';}}
function applyBundle(){officeTest.loaded=false;officeTest.finalized=false;officeTest.revision++;}
function rebuildFromBundle(){render();}
function onMulti(){render();}
function scopeLock(){officeTest.finalized=true;}
function setStatus(){}
function acceptBundle(u,source){applyBundle(u);rebuildFromBundle(u);onMulti();scopeLock();setStatus();}` : ''}
${strategic ? 'function loadState(value){window.syntheticState=value;render();} function openFile(value){loadState(value);}' : ''}
${directHandler ? `async function handleFiles(files){await waitForProcessing(files);${native ? 'acceptBundle({},files[0].name);' : 'render();'}}` : `document.getElementById('file').addEventListener('change',async event=>{await waitForProcessing(event.target.files);${native ? "acceptBundle({},event.target.files[0].name);" : strategic ? 'openFile({});' : 'render();'}${fixture === 'generic-ready' ? "window.dispatchEvent(new CustomEvent('kts-top-dashboard-data-ready',{detail:{restoreId:restore.restoreId}}));" : ''}});`}
</script></body></html>`;
  return native ? instrumentSyntheticSales(html) : html;
}

async function main() {
  const runtime = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  let fixture: Fixture = fixtures[0];
  let gets = 0;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const common = { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' };
    if (pathname === '/') {
      response.writeHead(200, common).end(`<!doctype html><html><body><iframe id="outer" title="Офис" sandbox="allow-scripts allow-same-origin allow-popups allow-modals" src="${framePath}?view=sales-office" style="width:100%;height:700px"></iframe></body></html>`);
    } else if (pathname === framePath) {
      const script = `window.messages=[];window.addEventListener('message',event=>{if(event.source===document.getElementById('dashboard-frame').contentWindow&&event.origin==='null'&&event.data&&typeof event.data.type==='string')window.messages.push({type:event.data.type,code:event.data.code,confirmation:event.data.confirmation});});${createTopDashboardFrameBridgeScript(7, 51, false)}`;
      response.writeHead(200, { ...common, 'Content-Security-Policy': buildTopDashboardFrameSecurityPolicy(script) }).end(`<!doctype html><html><body><iframe id="dashboard-frame" title="HTML-дашборд" sandbox="allow-scripts allow-popups" src="${contentPath}?view=sales-office" style="width:100%;height:650px"></iframe><div id="data-notice" hidden></div><script>${script}</script></body></html>`);
    } else if (pathname === contentPath) {
      const html = prepareInteractiveDashboardHtml(injectSalesOfficeView(injectTopDashboardDataAdapter(reportHtml(fixture), { readOnly: true, localInvoiceMode: false })));
      response.writeHead(200, { ...common, 'Content-Security-Policy': buildTopDashboardContentSecurityPolicy(html) }).end(html);
    } else if (pathname === dataPath && request.method === 'GET') {
      gets++;
      if (fixture === 'unsupported') { response.writeHead(404).end(); return; }
      const legacy = fixture.startsWith('legacy-');
      const bytes = legacy ? snapshot : Buffer.from(encodeTopDashboardMultiFileSnapshot({ targets: [{
        target: { id: 'file', index: 0 }, files: [{ name: 'synthetic.json', type: 'application/json', bytes: snapshot }],
      }] }));
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
        'X-Top-Dashboard-Data-Version-Id': '101',
        'X-Top-Dashboard-Data-Snapshot-Format': legacy ? 'kts-bundle-v1' : 'multi-file-v1',
        'X-Top-Dashboard-Data-Profile': legacy ? 'sales-analytics' : 'generic',
        'X-Top-Dashboard-Data-Bound-Html-Version-Id': '51',
        'X-Top-Dashboard-Data-Original-Name': 'synthetic.json',
      }).end(bytes);
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        for (fixture of [...fixtures, 'unsupported'] as Fixture[]) {
          gets = 0;
          const page = await browser.newPage();
          const errors: string[] = [];
          const policyErrors: string[] = [];
          let popups = 0;
          page.on('pageerror', (error: Error) => errors.push(error.message));
          page.on('console', (message: { type(): string; text(): string }) => {
            if (message.type() === 'error' && /content security policy|refused to|violates.*directive/i.test(message.text())) policyErrors.push(message.text());
          });
          page.on('popup', () => popups++);
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
          await page.goto(origin);
          const inner = page.frameLocator('#outer').frameLocator('#dashboard-frame');
          if (fixture === 'unsupported') {
            await inner.getByText('Эта версия HTML не поддерживает встроенный «Экран для офиса». Обновите HTML аналитики продаж.').waitFor();
            assert.equal(await inner.locator('main').isVisible(), false);
            assert.deepEqual(errors, []);
            assert.deepEqual(policyErrors, []);
            await page.close();
            continue;
          }
          const content = page.frames().find((frame: { url(): string }) => frame.url().includes(contentPath));
          const frame = page.frames().find((value: { url(): string }) => value.url().includes(framePath));
          assert.ok(content && frame);
          const legacy = fixture.startsWith('legacy-');
          assert.equal(detectTopDashboardDataContract(reportHtml(fixture)).mode, legacy ? 'legacy' : 'generic');
          await content.waitForFunction(() => (window as unknown as ReportWindow).officeTest.started === 1 && (window as unknown as ReportWindow).officeTest.waiting);
          await inner.getByText('Загружаем сохранённые данные для экрана офиса…').waitFor();
          assert.equal(await inner.locator('main').isVisible(), false);
          if (fixture === 'legacy-slow' || fixture === 'legacy-change' || fixture === 'legacy-unconfirmed') await page.waitForTimeout(1100);
          assert.deepEqual(await content.evaluate(() => ({
            loaded: (window as unknown as ReportWindow).officeTest.loaded,
            ready: (window as unknown as ReportWindow).officeTest.ready,
            opens: (window as unknown as ReportWindow).officeTest.officeOpens,
          })), { loaded: false, ready: [], opens: 0 }, `${engine} ${fixture}: no readiness before processing finishes`);
          await content.evaluate(() => (window as unknown as ReportWindow).officeTest.release());

          if (fixture.endsWith('-failure')) {
            if (fixture === 'legacy-failure') await frame.waitForFunction(() => (window as unknown as FrameWindow).messages.some(message => message.type === 'adapter-error' && message.code === 'SNAPSHOT_INSTALL_FAILED'));
            await inner.getByText('Не удалось загрузить данные для экрана офиса. Проверьте текущий снимок в «Аналитике продаж».').waitFor();
            assert.deepEqual(await content.evaluate(() => (window as unknown as ReportWindow).officeTest.ready), []);
            assert.deepEqual(await content.evaluate(() => (window as unknown as ReportWindow).officeTest.errors), [1], 'One failure signal per restore, including caught native failures');
            assert.equal(await inner.locator('#tvbox').isVisible(), false);
            if (fixture === 'legacy-failure') assert.equal(await content.evaluate(() => (window as unknown as ReportWindow).officeTest.loaded), false);
          } else if (fixture.endsWith('-unconfirmed')) {
            await content.waitForFunction(() => (window as unknown as ReportWindow).officeTest.loaded);
            await page.waitForTimeout(1100);
            assert.deepEqual(await content.evaluate(() => (window as unknown as ReportWindow).officeTest.ready), []);
            assert.equal(await inner.locator('#tvbox').isVisible(), false);
          } else {
            await inner.getByText('Рейтинг сотрудников — снимок 1').waitFor({ timeout: 10000 });
            assert.equal(await inner.locator('#kts-office-notice').isVisible(), false);
            assert.equal(await inner.getByRole('button', { name: 'Закрыть' }).isVisible(), false);
            await content.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
            assert.equal(await inner.locator('#tvbox').isVisible(), true);
            const ready = await content.evaluate(() => (window as unknown as ReportWindow).officeTest.ready);
            assert.equal(ready.length, 1, `${engine} ${fixture}: one readiness event per restore`);
            assert.equal(ready[0].loaded, true);
            assert.equal(ready[0].revision, 1);
            assert.ok(Number.isSafeInteger(ready[0].restoreId) && ready[0].restoreId > 0);
            if (legacy) {
              assert.equal(ready[0].finalized, true, 'Native readiness follows preset filters and scope locking');
              assert.equal(ready[0].renderCalls, 2, 'Native readiness follows every render in acceptBundle');
            }
            await frame.waitForFunction((isLegacy: boolean) => (window as unknown as FrameWindow).messages.some(message => isLegacy ? message.type === 'snapshot-installed' : message.type === 'files-installed' && message.confirmation === 'event'), legacy);

            if (fixture === 'legacy-async') {
              // A second real snapshot message must refresh the office without
              // the test or the author fixture manufacturing a ready event.
              await frame.evaluate(() => {
                const buffer = new TextEncoder().encode('{"format":"kts-bundle","revision":2}').buffer;
                (document.getElementById('dashboard-frame') as HTMLIFrameElement).contentWindow!.postMessage({ marker: 'kts-top-dashboard-data-v1', type: 'snapshot-data', name: 'second.json', buffer }, '*', [buffer]);
              });
              await content.waitForFunction(() => (window as unknown as ReportWindow).officeTest.started === 2 && (window as unknown as ReportWindow).officeTest.waiting);
              assert.equal(await content.evaluate(() => (window as unknown as ReportWindow).officeTest.ready.length), 1);
              assert.equal(await inner.locator('#tvbox').isVisible(), false, 'Old office content is hidden during the next restore');
              await inner.getByText('Загружаем сохранённые данные для экрана офиса…').waitFor();
              await content.evaluate(() => (window as unknown as ReportWindow).officeTest.release());
              await inner.getByText('Рейтинг сотрудников — снимок 2').waitFor();
              const repeated = await content.evaluate(() => (window as unknown as ReportWindow).officeTest.ready);
              assert.equal(repeated.length, 2);
              assert.equal(repeated[1].revision, 2);
              assert.ok(repeated[1].restoreId > repeated[0].restoreId);
            }
          }
          assert.equal(gets, 1, `${engine} ${fixture}: exactly one snapshot GET`);
          assert.equal(popups, 0);
          assert.deepEqual(errors, []);
          assert.deepEqual(policyErrors, []);
          console.log(`${engine}: ${fixture} passed with real adapters and CSP`);
          await page.close();
        }
      } finally { await browser.close(); }
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
