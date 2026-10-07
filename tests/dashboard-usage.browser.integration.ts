/** Synthetic browser-only usage protocol test. No credentials, DB or external data. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DASHBOARD_USAGE_MARKER } from '../src/shared/lib/dashboardUsage';
import { dashboardUsageRelayScript, injectDashboardUsageAdapter } from '../src/shared/lib/dashboardUsageBridge';
import { buildTopDashboardContentSecurityPolicy, buildTopDashboardFrameSecurityPolicy } from '../src/shared/lib/topDashboardContentSecurity';

const nonce = '01234567890123456789012345678901';
const report = injectDashboardUsageAdapter(`<!doctype html><html><head><title>Usage fixture</title></head><body>
<button role="tab" id="tab">Other tab</button><label>Filter<select id="filterYear"><option>One</option><option>Two</option></select></label><label>Active<input id="filterActive" type="checkbox" data-kts-usage-filter></label>
<label>Password<input id="password" type="password"></label><button id="calculate">Calculate</button><button id="export">Export</button>
<script>
document.getElementById('calculate').addEventListener('click',()=>{const result=2+2;if(result===4)window.dispatchEvent(new CustomEvent('kts:dashboard-usage',{detail:{action:'calculation_completed'}}));});
document.getElementById('export').addEventListener('click',()=>{const blob=new Blob(['Synthetic report']);if(blob.size)window.__ktsDashboardUsage.record('export_started');});
window.__ktsDashboardUsage.record('data_loaded');
</script></body></html>`);
const wrapperScript = `const frame=document.getElementById('report');${dashboardUsageRelayScript('frame')}`;
const wrapper = `<!doctype html><html><body><iframe id="report" sandbox="allow-scripts" src="/content" style="width:900px;height:500px"></iframe><script>${wrapperScript}</script></body></html>`;
const root = `<!doctype html><html><body><iframe id="wrapper" src="/frame" style="width:1000px;height:600px"></iframe><script>
const frame=document.getElementById('wrapper');window.usage=[];
const probe=()=>frame.contentWindow.postMessage({marker:'${DASHBOARD_USAGE_MARKER}',type:'init',nonce:'${nonce}'},location.origin);
window.addEventListener('message',event=>{const d=event.data;if(event.source!==frame.contentWindow||event.origin!==location.origin||d?.marker!=='${DASHBOARD_USAGE_MARKER}')return;if(d.type==='ready')probe();if(d.type==='event'&&d.nonce==='${nonce}')window.usage.push(d);});
frame.addEventListener('load',probe);
</script></body></html>`;

async function main() {
  const runtime = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (pathname === '/frame') { res.setHeader('Content-Security-Policy', buildTopDashboardFrameSecurityPolicy(wrapperScript)); res.end(wrapper); }
    else if (pathname === '/content') { res.setHeader('Content-Security-Policy', buildTopDashboardContentSecurityPolicy(report)); res.end(report); }
    else res.end(root);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const name of ['chromium', 'webkit']) {
      const browser = await playwright[name].launch({ headless: true });
      try {
        const page = await browser.newPage(); const errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        await page.goto(origin);
        const inner = page.frameLocator('#wrapper').frameLocator('#report');
        await page.waitForFunction(() => (window as unknown as { usage: Array<{action: string}> }).usage.some((entry) => entry.action === 'data_loaded'));
        const content = page.frames().find((frame: { url(): string }) => frame.url().endsWith('/content')); assert.ok(content);
        await content.evaluate(() => (window as unknown as { __ktsDashboardUsage: { record(action: string): void } }).__ktsDashboardUsage.record('calculation_completed'));
        await inner.locator('#password').fill('do-not-log-this');
        await inner.locator('#tab').click();
        await inner.locator('#filterActive').check();
        await inner.locator('#calculate').click();
        await inner.locator('#export').click();
        await page.waitForFunction(() => (window as unknown as { usage: Array<{action: string}> }).usage.some((entry) => entry.action === 'export_started'));
        const usage = await page.evaluate(() => (window as unknown as { usage: Array<{action: string}> }).usage);
        assert.deepEqual(usage.map((entry: {action: string}) => entry.action), ['report_open', 'data_loaded', 'tab_changed', 'filter_changed', 'calculation_completed', 'export_started']);
        assert.ok(usage.every((entry: object) => Object.keys(entry).sort().join(',') === 'action,marker,nonce,type'));
        assert.equal(JSON.stringify(usage).includes('do-not-log-this'), false);
        assert.deepEqual(errors, []);
        console.log(`${name}: opaque usage handshake, semantic actions, automatic-action suppression and no input values passed`);
      } finally { await browser.close(); }
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
