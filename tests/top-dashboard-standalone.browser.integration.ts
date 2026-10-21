/** Local synthetic data only. Optional author fixture is stripped of embedded business data. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';
import { addStandaloneTopDashboardMarker } from '../src/shared/lib/topDashboardStandalone';
import { buildTopDashboardContentSecurityPolicy, buildTopDashboardFrameSecurityPolicy,
  createTopDashboardFrameBridgeScript, detectTopDashboardDataContract, injectTopDashboardDataAdapter } from '../src/shared/lib/topDashboardContentSecurity';

const generic = `<!doctype html><html><head><title>New author application</title></head><body>
<h1>Independent HTML</h1><input id="anyNewInput" type="file"><output id="result"></output>
<button id="newCalculation">Calculate</button><output id="calculation"></output>
<script>
document.querySelector('#anyNewInput').addEventListener('change', async e => {document.querySelector('#result').textContent=await e.target.files[0].text();});
document.querySelector('#newCalculation').addEventListener('click',()=>{document.querySelector('#calculation').textContent=String(21*2);});
</script></body></html>`;

// Author application globals, referenced only by functions serialized into its frame.
declare const S: { invs: { no: string; curDet: string; totalDue: number; manualCalc?: boolean }[] };
declare function newManualCalc(): void;
declare function calcSnapPart(): { invs: Record<string, unknown>[] };
declare function getPdfJs(): Promise<{ getDocument: unknown }>;

async function main() {
  const reports = new Map<string, string>([['generic', addStandaloneTopDashboardMarker(generic)]]);
  const authorPath = process.env.KTS_STANDALONE_HTML_FIXTURE;
  if (authorPath) {
    const original = await readFile(authorPath, 'utf8');
    const sanitized = original.replace(/(<script type="application\/json" id="kts-stock">)[\s\S]*?(<\/script>)/,
      '$1{"mgr":true,"settings":{"vat":20,"inputVat":true},"stockBase":null}$2');
    assert.ok(sanitized.length < original.length / 2, 'never serve embedded business data');
    reports.set('author', sanitized);
  }
  const payloads = new Map([...reports].map(([key, html]) => {
    assert.equal(detectTopDashboardDataContract(html).profile, 'standalone');
    const adapted = injectTopDashboardDataAdapter(html, { readOnly: true, localInvoiceMode: true });
    return [key, { html: adapted, csp: buildTopDashboardContentSecurityPolicy(adapted, { allowBlobModules: true }) }];
  }));
  const bridge = createTopDashboardFrameBridgeScript(7, 51, false, { preview: false, auditEnabled: false });
  const unexpected: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/frame/')) {
      const key = url.pathname.slice('/frame/'.length);
      if (!payloads.has(key)) return void res.writeHead(404).end();
      return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': buildTopDashboardFrameSecurityPolicy(bridge) })
        .end(`<!doctype html><html><style>html,body,iframe{width:100%;height:100%;margin:0;border:0}</style><iframe id="dashboard-frame" sandbox="allow-scripts allow-popups" src="/content/${key}"></iframe><div id="data-notice" hidden></div><script>${bridge}</script></html>`);
    }
    if (url.pathname.startsWith('/content/')) {
      const report = payloads.get(url.pathname.slice('/content/'.length));
      if (report) return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': report.csp }).end(report.html);
    }
    if (url.pathname !== '/favicon.ico') unexpected.push(url.pathname);
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const output = await mkdtemp(path.join(tmpdir(), 'kts-standalone-html-'));
  const runtime = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Счет № SYNTHETIC-NEW от 21.10.2026'], ['Валюта RUB'],
    ['№', 'Наименование', 'Количество', 'Ед.', 'Цена', 'Сумма'],
    [1, 'Synthetic valve', 2, 'шт', 20, 40], ['Итого к оплате', null, null, null, null, 40],
  ]), 'Invoice');
  try {
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => {
          const target = route.request().url();
          if (target.startsWith(origin) || target.startsWith('blob:')) return route.continue();
          return route.abort();
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        for (const key of reports.keys()) {
          await page.goto(`${origin}/frame/${key}`);
          const report = page.frameLocator('#dashboard-frame');
          if (key === 'generic') {
            await report.locator('#anyNewInput').setInputFiles({ name: 'personal.txt', mimeType: 'text/plain', buffer: Buffer.from('PRIVATE-SYNTHETIC-ONLY') });
            await report.getByText('PRIVATE-SYNTHETIC-ONLY', { exact: true }).waitFor();
            await report.getByRole('button', { name: 'Calculate' }).click();
            await report.getByText('42', { exact: true }).waitFor();
            assert.equal(await report.locator('#anyNewInput').isDisabled(), false);
          } else {
            await report.locator('#fInv').waitFor({ state: 'attached' });
            assert.equal(await report.locator('#fInv').isDisabled(), false);
            assert.equal(await report.locator('#fSnap').isDisabled(), false);
            assert.equal(await report.locator('#fSrc').isDisabled(), false);
            await report.locator('#fInv').setInputFiles({ name: 'synthetic.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) });
            const author = page.frames().find((frame: { url(): string }) => frame.url().endsWith('/content/author'));
            assert.ok(author);
            await author.waitForFunction(() => typeof S !== 'undefined' && S.invs.length > 0);
            assert.deepEqual(await author.evaluate(() => ({ no: S.invs[0].no, currency: S.invs[0].curDet, amount: S.invs[0].totalDue })),
              { no: 'SYNTHETIC-NEW', currency: 'RUB', amount: 40 });
            // New manual calculations and both snapshot formats work without pretending to be invoice audit events.
            await author.evaluate(() => newManualCalc());
            assert.equal(await author.evaluate(() => S.invs.some(inv => inv.manualCalc === true)), true);
            const calculation = await author.evaluate(() => {
              const saved = calcSnapPart();
              return { ...saved, invs: saved.invs.filter(inv => inv.manualCalc).map(inv => ({ ...inv, no: 'SYNTHETIC-MANUAL' })) };
            });
            const snapshot = { kind: 'kts-rent-sources', calc: calculation, saved: new Date().toISOString() };
            await report.locator('#fSnap').setInputFiles({ name: 'synthetic-sources.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(snapshot)) });
            await author.waitForFunction(() => S.invs.some(inv => inv.no === 'SYNTHETIC-MANUAL'));
            const regular = { ...calculation, invs: calculation.invs.map((inv: Record<string, unknown>) => ({ ...inv, no: 'SYNTHETIC-REGULAR' })), kind: 'kts-rent-snapshot', v: 4, saved: new Date().toISOString() };
            await report.locator('#fSnap').setInputFiles({ name: 'synthetic-regular.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(regular)) });
            await author.waitForFunction(() => S.invs.some(inv => inv.no === 'SYNTHETIC-REGULAR'));
            assert.equal(await author.evaluate(async () => typeof (await getPdfJs()).getDocument), 'function');
          }
          const child = page.frames().find((frame: { url(): string }) => frame.url().endsWith(`/content/${key}`));
          assert.ok(child);
          assert.equal(await child.evaluate(() => { try { return Boolean(parent.document.body); } catch { return false; } }), false, 'cannot access account document');
          assert.equal(await child.evaluate(async () => { try { await fetch('/api/admin/knowledge-base'); return true; } catch { return false; } }), false, 'cannot access site APIs');
          await page.screenshot({ path: path.join(output, `${engine}-${key}.png`) });
          assert.equal(await page.locator('#profitability-audit-notice').count(), 0);
          assert.deepEqual(unexpected, [], 'no shared file upload/restoration or fabricated audit calls');
        }
        assert.deepEqual(errors, []);
        console.log(`${engine}: ${[...reports.keys()].join(', ')} local inputs, calculations, snapshots and isolation passed`);
        await context.close();
      } finally { await browser.close(); }
    }
    console.log(`Screenshots: ${output}`);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
