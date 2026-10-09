/** Real reviewed V19 application/libraries, with all embedded business data replaced by a synthetic empty dataset. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, unlink, rmdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';
import { injectProfitabilityAuditAdapter, isSupportedProfitabilityHtml } from '../src/shared/lib/dashboardProfitabilityHtml';
import { parseProfitabilityAuditRequest } from '../src/shared/lib/dashboardProfitabilityAudit';
import { buildTopDashboardContentSecurityPolicy, buildTopDashboardFrameSecurityPolicy,
  createTopDashboardFrameBridgeScript, injectTopDashboardDataAdapter } from '../src/shared/lib/topDashboardContentSecurity';

const require = createRequire(import.meta.url);
const framePath = '/api/admin/top-dashboard/blocks/7/versions/51/frame';
const contentPath = '/api/admin/top-dashboard/blocks/7/versions/51/content';
const auditPath = '/api/admin/dashboard-usage/profitability';
const fixturePath = process.env.KTS_PROFITABILITY_HTML_FIXTURE;
if (!fixturePath) throw new Error('Set KTS_PROFITABILITY_HTML_FIXTURE to the locally supplied V19 HTML. It is never uploaded.');

function workbook() {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Счет № SYNTHETIC-XLSX от 09.10.2026'], ['Валюта USD'],
    ['№', 'Наименование', 'Количество', 'Ед.', 'Цена', 'Сумма'],
    [1, 'Synthetic valve', 2, 'шт', 20, 40], ['Итого к оплате', null, null, null, null, 40],
  ]), 'Invoice');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function pdfInvoice() {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 30 });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
  });
  doc.font(process.env.KTS_TEST_CYRILLIC_FONT ?? '/System/Library/Fonts/Supplemental/Arial.ttf').fontSize(10);
  doc.text('Счет № SYNTHETIC-PDF от 09.10.2026', 30, 30);
  doc.text('Валюта RUB', 30, 52);
  const xs = [30, 70, 300, 390, 460];
  ['№', 'Наименование', 'Количество', 'Цена', 'Сумма'].forEach((s, i) => doc.text(s, xs[i], 80, { lineBreak: false }));
  ['1', 'Synthetic fitting', '3', '25', '75'].forEach((s, i) => doc.text(s, xs[i], 105, { lineBreak: false }));
  doc.text('Итого к оплате', 30, 130, { lineBreak: false }); doc.text('75', 460, 130, { lineBreak: false });
  doc.end(); return done;
}

async function main() {
  const original = await readFile(fixturePath!, 'utf8');
  assert.ok(isSupportedProfitabilityHtml(original));
  // Preserve reviewed application code and PDF/XLSX libraries, but never serve actual business datasets even locally.
  const sanitized = original.replace(/(<script type="application\/json" id="kts-stock">)[\s\S]*?(<\/script>)/,
    '$1{"mgr":true,"settings":{"vat":20,"inputVat":true},"stockBase":null}$2');
  assert.ok(sanitized.length < original.length / 2);
  assert.ok(isSupportedProfitabilityHtml(sanitized));
  const app = injectProfitabilityAuditAdapter(injectTopDashboardDataAdapter(sanitized, { readOnly: true, localInvoiceMode: true }));
  const csp = buildTopDashboardContentSecurityPolicy(app, { allowBlobModules: true });
  assert.match(csp, /script-src blob:/); assert.match(csp, /connect-src 'none'/); assert.doesNotMatch(csp, /unsafe-eval/);
  const bridge = createTopDashboardFrameBridgeScript(7, 51, false, { preview: false });
  const frames = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}body{overflow:hidden}</style></head><body><iframe id="dashboard-frame" sandbox="allow-scripts allow-popups" src="${contentPath}"></iframe><div id="data-notice" hidden></div><script>${bridge}</script></body></html>`;
  const accepted: ReturnType<typeof parseProfitabilityAuditRequest>[] = [];
  const requestBodies: string[] = [];
  const forbidden: string[] = [];
  let respond = 503;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === framePath) return void response.writeHead(200, { 'Content-Type':'text/html; charset=utf-8',
      'Content-Security-Policy':buildTopDashboardFrameSecurityPolicy(bridge) }).end(frames);
    if (url.pathname === contentPath) return void response.writeHead(200, { 'Content-Type':'text/html; charset=utf-8', 'Content-Security-Policy':csp }).end(app);
    if (url.pathname === auditPath && request.method === 'POST') {
      const parts: Buffer[] = []; for await (const chunk of request) parts.push(Buffer.from(chunk));
      const body = Buffer.concat(parts).toString('utf8'); requestBodies.push(body);
      const parsed = parseProfitabilityAuditRequest(JSON.parse(body)); assert.ok(parsed);
      if (respond === 200) accepted.push(parsed);
      response.writeHead(respond, { 'Content-Type':'application/json' }).end(JSON.stringify(respond === 200 ? {ok:true,eventId:parsed.eventId} : {error:'Synthetic unavailable'}));
      return;
    }
    if (url.pathname !== '/favicon.ico') forbidden.push(url.pathname);
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const modulePath = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const pdf = await pdfInvoice();
  const temporary = await mkdtemp(path.join(tmpdir(), 'profitability-synthetic-'));
  const xlsxPath=path.join(temporary,'synthetic.xlsx'), pdfPath=path.join(temporary,'synthetic.pdf'), snapshotPath=path.join(temporary,'synthetic.json');
  await writeFile(xlsxPath, workbook()); await writeFile(pdfPath, pdf);
  await writeFile(snapshotPath, JSON.stringify({kind:'kts-rent-snapshot',saved:new Date().toISOString(),invs:[{docType:'Счёт',no:'SYNTHETIC-SNAPSHOT',date:'2026-10-09',warns:[],cur:'USD',curDet:'USD',totalDue:40,extras:[],
    lines:[{name:'Synthetic valve',qty:2,gross:40,net:33.33,vat:6.67,rate:20,art:'',unit:'шт',mcost:null,mprice:null}]}]}));
  try {
    for (const {engine,mobile} of [{engine:'chromium',mobile:false},{engine:'webkit',mobile:false},{engine:'webkit',mobile:true}]) {
      const browser = await playwright[engine].launch({ headless:true });
      try {
        const context = await browser.newContext({ viewport:mobile?{width:390,height:844}:{width:1440,height:1000} });
        await context.route('**/*', (route: any) => route.request().url().startsWith(origin) || route.request().url().startsWith('blob:') ? route.continue() : route.abort());
        const page = await context.newPage();
        const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.goto(origin + framePath);
        const inner = await page.waitForFunction(() => document.querySelector('#dashboard-frame'));
        await inner.dispose();
        const report = page.frames().find((frame: any) => frame.url().includes(contentPath)); assert.ok(report);
        await report.waitForSelector('#fInv', {state:'attached'});
        assert.equal(await report.locator('#fInv').isDisabled(), false, 'viewer can import local invoices');
        assert.equal(await report.locator('#fSnap').isDisabled(), false);
        assert.equal(await report.evaluate(() => typeof (window as any).getPdfJs), 'function');
        assert.equal(await report.evaluate(async () => typeof (await (window as any).getPdfJs()).getDocument), 'function', 'embedded PDF blob modules load under scoped CSP');
        const before = accepted.length; const requestsBefore = requestBodies.length;
        respond = 503;
        await report.locator('#fInv').setInputFiles(xlsxPath);
        await page.waitForFunction(() => document.querySelector('#profitability-audit-notice')?.textContent?.includes('Повторяем'), null, {timeout:10000}).catch(async (error: Error) => {
          console.error({engine,errors,requests:requestBodies.length,wrapper:await page.locator('#profitability-audit-notice').textContent(),
            inner:await report.locator('#kts-profitability-audit-notice').textContent(),
            syntheticLog:await report.evaluate('JSON.stringify(S.log)')});
          throw error;
        });
        assert.equal(accepted.length, before, 'no fake success on temporary API error');
        respond = 200;
        await page.waitForFunction(() => document.querySelector('#profitability-audit-notice')?.getAttribute('data-kind') === 'success');
        assert.equal(accepted.length, before + 1);
        assert.equal(requestBodies[requestsBefore], requestBodies[requestsBefore+1], 'retry preserves same event ID and body');
        assert.equal(accepted.at(-1)!.invoice.invoiceNumber, 'SYNTHETIC-XLSX');
        assert.equal(accepted.at(-1)!.invoice.lines[0].quantity, 2);
        await report.locator('#fInv').setInputFiles(pdfPath);
        await page.waitForFunction(() => document.querySelector('#profitability-audit-notice')?.textContent?.includes('сохранена'));
        await new Promise<void>((resolve, reject) => {
          const start = Date.now(); const poll = () => accepted.length >= before + 2 ? resolve() : Date.now()-start>15000 ? reject(new Error('Synthetic PDF audit not received')) : setTimeout(poll,100); poll();
        });
        assert.equal(accepted.at(-1)!.invoice.invoiceNumber, 'SYNTHETIC-PDF');
        assert.equal(accepted.at(-1)!.invoice.lines[0].quantity, 3);
        assert.equal(accepted.at(-1)!.invoice.dealAmount, 75);
        await report.locator('#fSnap').setInputFiles(snapshotPath);
        await new Promise<void>((resolve, reject) => {
          const start=Date.now(); const poll=()=>accepted.length>=before+3?resolve():Date.now()-start>10000?reject(new Error('Synthetic snapshot audit not received')):setTimeout(poll,100);poll();
        });
        assert.equal(accepted.at(-1)!.invoice.invoiceNumber, 'SYNTHETIC-SNAPSHOT');
        assert.equal(accepted.at(-1)!.invoice.currency, 'USD');
        await report.waitForFunction(()=>document.querySelector('#kts-profitability-audit-notice')?.textContent?.includes('записана в журнал: 3'));
        const screenshotDir=process.env.KTS_PROFITABILITY_QA_DIR;
        if(screenshotDir){await mkdir(screenshotDir,{recursive:true});await page.screenshot({path:path.join(screenshotDir,`${engine}-${mobile?'mobile':'desktop'}-success.png`)});}
        respond=409;
        await report.locator('#fSnap').setInputFiles([]);
        await report.locator('#fSnap').setInputFiles(snapshotPath);
        await page.waitForFunction(()=>document.querySelector('#profitability-audit-notice')?.getAttribute('data-kind')==='error');
        await report.waitForFunction(()=>document.querySelector('#kts-profitability-audit-notice')?.textContent?.includes('Запись не подтверждена'));
        assert.equal(accepted.length,before+3,'permanent failure is not presented as a durable save');
        if(screenshotDir)await page.screenshot({path:path.join(screenshotDir,`${engine}-${mobile?'mobile':'desktop'}-error.png`)});
        assert.deepEqual(forbidden, [], 'no raw invoice shared upload, shared snapshot restore, or other API request');
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({engine,mobile,result:'pass',imports:['XLSX','PDF','snapshot'],temporaryFailureRecovered:true,permanentFailureVisible:true,rawSharedRequests:0}));
        await context.close();
      } finally { await browser.close(); }
    }
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await Promise.all([xlsxPath,pdfPath,snapshotPath].map(file=>unlink(file))); await rmdir(temporary);
  }
}

main().catch(error => { console.error(error); process.exitCode=1; });
