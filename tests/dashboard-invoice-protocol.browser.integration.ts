/** Synthetic author application only, localhost and the real CSP/SDK/transport. */
import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { injectProfitabilityAuditAdapter } from '../src/shared/lib/dashboardProfitabilityHtml';
import { dashboardProfitabilityBridgeScript } from '../src/shared/lib/dashboardProfitabilityBridge';
import { parseProfitabilityAuditRequest } from '../src/shared/lib/dashboardProfitabilityAudit';
import { buildTopDashboardContentSecurityPolicy, buildTopDashboardFrameSecurityPolicy } from '../src/shared/lib/topDashboardContentSecurity';

const invoice = { schemaVersion: 1, documentType: 'invoice', invoiceNumber: 'SYNTHETIC-999', currency: 'USD',
  dealAmount: 12.5, amountSource: 'document', lines: [{ nomenclature: 'Original synthetic position', quantity: 2 }] };
const source = `<!doctype html><html><head><meta name="kts-dashboard-audit" content="invoice-v1"></head><body>
<input type="file" id="new-author-input"><p id="result">Waiting</p><button id="duplicate">Duplicate success hook</button>
<script>
const invoice=${JSON.stringify(invoice)};let selected=null;
window.automaticReceipt=window.KTSDashboardAudit.recordInvoice(invoice,new File(['not selected'],'restored.txt'));
document.getElementById('new-author-input').addEventListener('change',async event=>{
  selected=event.target.files[0];const content=await selected.text();
  if(content==='synthetic-success'){window.receipt=window.KTSDashboardAudit.recordInvoice(invoice,selected);document.getElementById('result').textContent='Imported';}
  else document.getElementById('result').textContent='Import failed';
});
document.getElementById('duplicate').onclick=()=>{window.duplicateReceipt=window.KTSDashboardAudit.recordInvoice(invoice,selected)};
</script></body></html>`;

async function main() {
  const content = injectProfitabilityAuditAdapter(source);
  const bridge = `const frame=document.getElementById('report');${dashboardProfitabilityBridgeScript('frame', { dashboardKey: 'top:999', versionId: 999, preview: false })}`;
  const wrapper = `<!doctype html><html><body><iframe id="report" src="/content" sandbox="allow-scripts" style="width:900px;height:600px"></iframe><script>${bridge}</script></body></html>`;
  const requests: ReturnType<typeof parseProfitabilityAuditRequest>[] = [];
  const persisted = new Map<string, string>();
  const server = createServer(async (req, res) => {
    if (req.url === '/') return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': buildTopDashboardFrameSecurityPolicy(bridge) }).end(wrapper);
    if (req.url === '/content') return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': buildTopDashboardContentSecurityPolicy(content) }).end(content);
    if (req.url === '/api/admin/dashboard-usage/profitability' && req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const input = parseProfitabilityAuditRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      requests.push(input);
      const first = !persisted.has(input.eventId);
      if (first) persisted.set(input.eventId, JSON.stringify(input));
      else assert.equal(persisted.get(input.eventId), JSON.stringify(input));
      // Simulate persistence followed by a missing acknowledgement, then an idempotent retry.
      res.writeHead(first ? 503 : 200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(first ? { error: 'Synthetic acknowledgement unavailable' } : { ok: true, eventId: input.eventId }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const modulePath = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const directory = await mkdtemp(path.join(tmpdir(), 'invoice-protocol-synthetic-'));
  const success = path.join(directory, 'invoice.txt'), failure = path.join(directory, 'failed.txt');
  await writeFile(success, 'synthetic-success'); await writeFile(failure, 'synthetic-failure');
  try {
    for (const name of ['chromium', 'webkit']) {
      requests.length = 0; persisted.clear();
      const browser = await playwright[name].launch({ headless: true });
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) =>
          new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await page.goto(origin);
        const frame = page.frames().find((candidate: { url(): string }) => candidate.url() === origin + '/content');
        assert.ok(frame);
        assert.equal(await frame.evaluate(() => (window as unknown as { automaticReceipt: unknown }).automaticReceipt), null);
        assert.equal(requests.length, 0, 'automatic restore is not logged');
        await frame.locator('#new-author-input').setInputFiles(failure);
        await frame.waitForFunction(() => document.getElementById('result')?.textContent === 'Import failed');
        assert.equal(requests.length, 0, 'choosing a file and a failed parse are not success');
        await frame.locator('#new-author-input').setInputFiles(success);
        await frame.waitForFunction(() => document.getElementById('result')?.textContent === 'Imported');
        await frame.locator('#duplicate').click();
        await frame.waitForFunction(() => document.getElementById('kts-profitability-audit-notice')?.textContent?.includes('записана в журнал: 1'), null, { timeout: 10000 }).catch(async (error: Error) => {
          console.error({ name, requests: requests.length, errors,
            inner: await frame.locator('#kts-profitability-audit-notice').textContent(),
            outer: await page.locator('#profitability-audit-notice').textContent(),
            receipt: await frame.evaluate(() => (window as unknown as { receipt: unknown }).receipt) });
          throw error;
        });
        assert.equal(requests.length, 2);
        assert.equal(persisted.size, 1);
        assert.equal(requests[0].eventId, requests[1].eventId);
        assert.deepEqual(requests[0].invoice, invoice);
        assert.deepEqual(requests[0].upload, { name: 'invoice.txt', size: 17 });
        assert.equal(await frame.evaluate(() => {
          try { void window.parent.document.body; return false; } catch { return true; }
        }), true, 'opaque frame cannot read the authenticated wrapper');
        assert.deepEqual(errors, []);
        console.log(`${name}: optional SDK, trusted arbitrary file input, no auto/failed import, duplicate/lost ACK, canonical invoice and opaque CSP passed`);
      } finally { await browser.close(); }
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(success); await unlink(failure); await rmdir(directory);
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
