/** Native print integration with synthetic cards only; no production snapshots or credentials. */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPersonalDashboardFrame, buildPersonalDashboardOwnFrame, buildPersonalDashboardReviewFrame, injectPersonalDashboardAdapter, personalHtmlCsp } from '../src/shared/lib/managerDashboardHtml';

const card = `<!doctype html><html><head><title>Карточка Synthetic Client</title><style>body{font:14px Arial;color:#123}h1{color:#271078}@media print{.noprint{display:none}}</style></head><body>
<h1>Карточка клиента</h1><p>Synthetic Client — 42</p><table><tr><th>Продажи</th><td>120 000</td></tr></table>
<script>parent.__printAttack=true</script><img src="https://print-invalid.example.test/leak"><div onclick="parent.__printAttack=true">Safe text</div>
<input type="password" value="PRIVATE_CARD_PASSWORD"><iframe src="https://print-invalid.example.test/frame"></iframe>
</body></html>`;
const source = `<!doctype html><html><head><meta charset="utf-8"><title>Personal synthetic</title></head><body>
<p>OUTSIDE_CARD_SUMMARY</p><input id="fileInp" type="file"><input id="pass" type="password" value="PRIVATE_PASSWORD">
<button id="card">Печать / PDF</button><button id="direct">Печать отчёта</button><button id="oversize">Oversize</button>
<script type="application/json">{"secret":"PRIVATE_SNAPSHOT"}</script>
<script>
let FILE=null;let D=null;const contract='kts-personal';const emailHash='synthetic';
function gate(){} function tryOpen(){} function decryptFile(){}
function cardOf(){return {c:{},ours:{}}} function cardDocHtml(){return ${JSON.stringify(card).replaceAll('<', '\\u003c')}}
function cardPrint(inn){
  const x = cardOf(inn); if (!x) return;
  const w2 = window.open("", "_blank");
  if (!w2){ alert("Всплывающее окно заблокировано — используйте «Скачать карточку»"); return; }
  w2.document.write(cardDocHtml(x.c, x.ours)); w2.document.close();
  setTimeout(() => { try { w2.focus(); w2.print(); } catch (e){} }, 300);
}
document.getElementById('card').addEventListener('click',()=>cardPrint('synthetic'));
document.getElementById('direct').addEventListener('click',()=>window.print());
document.getElementById('oversize').addEventListener('click',()=>{const w=window.open('','_blank');w.document.write('x'.repeat(5*1024*1024+1));w.document.close();w.print()});
</script></body></html>`;

type Proof = { calls: number; beforePrint: number; text: string; title: string; html: string; scripts: number; unsafe: number; attributes: number; sandbox: string; csp: string };
type Route = { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> };

async function main() {
  const require = createRequire(path.resolve('package.json'));
  let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!modulePath) {
    try { modulePath = path.dirname(require.resolve('playwright/package.json')); }
    catch { modulePath = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const screenshots = await mkdtemp(path.join(tmpdir(), 'kts-personal-print-'));
  const adapted = injectPersonalDashboardAdapter(source);
  const frames = {
    development: buildPersonalDashboardFrame({ versionId: 1, preview: false, audience: 'development', emptyState: 'no_snapshot' }),
    support: buildPersonalDashboardFrame({ versionId: 1, preview: false, audience: 'support', emptyState: 'no_snapshot' }),
    own: buildPersonalDashboardOwnFrame({ versionId: 1, emptyState: 'no_snapshot' }),
    review: buildPersonalDashboardReviewFrame({ versionId: 1, managerId: 7, emptyState: 'no_snapshot' }),
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname.endsWith('/content')) {
      response.setHeader('Content-Security-Policy', personalHtmlCsp(adapted)); response.end(adapted); return;
    }
    if (url.pathname === '/frame') {
      const frame = frames[url.searchParams.get('mode') as keyof typeof frames] ?? frames.development;
      response.setHeader('Content-Security-Policy', frame.csp); response.end(frame.html); return;
    }
    if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    response.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><div hidden>PRIVATE_PARENT</div><iframe id="shell" style="width:100%;height:90vh" sandbox="allow-scripts allow-same-origin allow-modals" src="/frame?mode=${url.searchParams.get('mode') ?? 'development'}"></iframe></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const engineName of ['chromium', 'webkit']) {
      const browser = await playwright[engineName].launch({ headless: true });
      try {
        for (const mode of Object.keys(frames)) {
          const context = await browser.newContext(); const page = await context.newPage();
          const unexpected: string[] = []; let popups = 0;
          context.on('page', () => { popups += 1; });
          await context.route('**/*', async (route: Route) => {
            if (!route.request().url().startsWith(origin)) { unexpected.push(route.request().url()); await route.abort(); }
            else await route.continue();
          });
          await page.goto(`${origin}/?mode=${mode}`);
          const wrapper = page.frames().find((frame: { url(): string }) => frame.url().includes('/frame?'))!;
          const report = page.frameLocator('#shell').frameLocator('#personal');
          await report.locator('#card').waitFor();
          await wrapper.evaluate(() => {
            const target = window as unknown as { proof: Proof };
            target.proof = { calls: 0, beforePrint: 0, text: '', title: '', html: '', scripts: -1, unsafe: -1, attributes: -1, sandbox: '', csp: '' };
            new MutationObserver(() => {
              const frame = document.querySelector<HTMLIFrameElement>('#dashboard-print-frame');
              if (!frame || frame.dataset.observed) return;
              frame.dataset.observed = '1';
              frame.addEventListener('load', () => {
                const printWindow = frame.contentWindow!; const doc = frame.contentDocument!;
                Object.assign(target.proof, { text: doc.body.textContent ?? '', title: doc.title, html: doc.documentElement.outerHTML,
                  scripts: doc.querySelectorAll('script').length, unsafe: doc.querySelectorAll('script,iframe,form,object,embed,link,base,input,textarea,select').length,
                  attributes: Array.from(doc.querySelectorAll('*')).filter(node => node.getAttributeNames().some(name => /^on/i.test(name))).length,
                  sandbox: frame.getAttribute('sandbox') ?? '', csp: doc.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')?.content ?? '' });
                printWindow.addEventListener('beforeprint', () => { target.proof.beforePrint += 1; });
                printWindow.print = new Proxy(printWindow.print, { apply(nativePrint, thisArg, args) {
                  target.proof.calls += 1; return Reflect.apply(nativePrint, thisArg, args);
                } });
              });
            }).observe(document.body, { childList: true });
          });
          await report.locator('#card').click();
          await wrapper.waitForFunction(() => (window as unknown as { proof: Proof }).proof.calls === 1);
          const proof: Proof = await wrapper.evaluate(() => (window as unknown as { proof: Proof }).proof);
          if (engineName === 'chromium') assert.ok(proof.beforePrint > 0, 'native Chromium print lifecycle');
          assert.match(proof.text, /Synthetic Client — 42/); assert.match(proof.text, /120 000/);
          assert.equal(proof.title, 'Карточка Synthetic Client');
          assert.doesNotMatch(proof.html, /OUTSIDE_CARD_SUMMARY|PRIVATE_|https:\/\/print-invalid/);
          assert.match(proof.html, /font:14px Arial/);
          assert.equal(proof.scripts, 0); assert.equal(proof.unsafe, 0); assert.equal(proof.attributes, 0);
          assert.equal(proof.sandbox, 'allow-same-origin allow-modals'); assert.match(proof.csp, /script-src 'none'/);
          assert.equal(await page.frameLocator('#shell').locator('#personal').getAttribute('sandbox'), 'allow-scripts');
          assert.equal(popups, 0); assert.deepEqual(unexpected, []);
          await page.waitForTimeout(1200);
          await report.locator('#card').click();
          await wrapper.waitForFunction(() => (window as unknown as { proof: Proof }).proof.calls === 2);
          await page.waitForTimeout(1200);
          await report.locator('#direct').click();
          await wrapper.waitForFunction(() => (window as unknown as { proof: Proof }).proof.calls === 3);
          const direct: Proof = await wrapper.evaluate(() => (window as unknown as { proof: Proof }).proof);
          assert.match(direct.text, /OUTSIDE_CARD_SUMMARY/); assert.doesNotMatch(direct.html, /PRIVATE_PASSWORD|PRIVATE_SNAPSHOT/);
          await page.waitForTimeout(1200);
          await report.locator('#oversize').click();
          await page.frameLocator('#shell').locator('#print-notice').waitFor({ state: 'visible' });
          assert.match(await page.frameLocator('#shell').locator('#print-notice').textContent(), /Не удалось подготовить/);
          assert.equal(await wrapper.evaluate(() => (window as unknown as { proof: Proof }).proof.calls), 3);
          // An unrelated sender is rejected even while user activation is fresh.
          await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#shell')!.contentWindow!.postMessage({ marker:'kts-top-dashboard-print-v1',type:'print-request',requestId:'forged',html:'FORGED',styles:[] }, location.origin));
          await page.waitForTimeout(100);
          assert.equal(await wrapper.evaluate(() => (window as unknown as { proof: Proof }).proof.calls), 3);
          await page.screenshot({ path: path.join(screenshots, `${engineName}-${mode}.png`) });
          // A fresh document has no user activation; code cannot open printing itself.
          const noActivationPage = await context.newPage();
          await noActivationPage.addInitScript(() => {
            window.addEventListener('load', () => {
              if (location.pathname.endsWith('/content')) window.setTimeout(() => {
                (window as unknown as { noGestureBlocked: boolean }).noGestureBlocked = window.open('', '_blank') === null;
              }, 50);
            });
          });
          await noActivationPage.goto(`${origin}/?mode=${mode}`);
          // evaluate() itself grants a synthetic gesture in Playwright; let the
          // page's own load timer run before inspecting its result.
          await noActivationPage.waitForTimeout(250);
          const freshReport = noActivationPage.frames().find((frame: { url(): string }) => frame.url().includes('/content?'))!;
          await freshReport.waitForSelector('#card');
          assert.equal(await freshReport.evaluate(() => (window as unknown as { noGestureBlocked: boolean }).noGestureBlocked), true);
          await noActivationPage.frameLocator('#shell').locator('#print-notice').waitFor({ state: 'visible' });
          assert.match(await noActivationPage.frameLocator('#shell').locator('#print-notice').textContent(), /нажмите кнопку печати/);
          assert.equal(await noActivationPage.frameLocator('#shell').locator('#dashboard-print-frame').count(), 0);
          await context.close();
          console.log(JSON.stringify({ engine: engineName, mode, nativeCardPrint: 'pass', repeat: 'pass', direct: 'pass', isolation: 'pass', bounds: 'pass' }));
        }
      } finally { await browser.close(); }
    }
    console.log(`Screenshots: ${screenshots}`);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
