/** Real React top-level guard above nested sandboxed frames, localhost and synthetic statuses only. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const fixture = `
import React,{useRef,useState} from 'react';import{createRoot}from'react-dom/client';
import{useProfitabilityAuditGuard,requestProfitabilityFrameChange}from'./src/features/admin/dashboard-usage/useProfitabilityAuditGuard';
function App(){const frame=useRef(null),[version,setVersion]=useState(0);useProfitabilityAuditGuard(frame);
return <main><button id="activate">Top page activation</button><button id="refresh" onClick={()=>{if(requestProfitabilityFrameChange(frame.current))setVersion(v=>v+1)}}>Refresh</button>
<button id="automatic" onClick={()=>{if(requestProfitabilityFrameChange(frame.current,false))setVersion(v=>v+1)}}>Automatic refresh</button>
<a id="leave" href="/destination">Leave</a><span id="version">{version}</span>
<iframe id="wrapper" key={version} ref={frame} src={'/wrapper?v='+version} sandbox="allow-scripts allow-same-origin allow-popups" style={{width:700,height:250}}/></main>}
createRoot(document.getElementById('root')).render(<App/>);`;
const marker = 'kts-profitability-audit-v1';
const wrapper = `<!doctype html><html><body><iframe id="inner" sandbox="allow-scripts" src="/inner" style="width:600px;height:180px"></iframe><script>
const inner=document.getElementById('inner');addEventListener('message',e=>{if(e.source!==inner.contentWindow||e.origin!=='null'||e.data?.marker!=='${marker}'||typeof e.data.pending!=='boolean')return;
parent.postMessage({marker:'${marker}',type:'pending-state',pending:e.data.pending},location.origin)});
</script></body></html>`;
const inner = `<!doctype html><html><body><button id="pending">Synthetic pending</button><button id="saved">Synthetic saved</button><script>
document.getElementById('pending').onclick=()=>parent.postMessage({marker:'${marker}',pending:true},'*');
document.getElementById('saved').onclick=()=>parent.postMessage({marker:'${marker}',pending:false},'*');
</script></body></html>`;

async function main() {
  const root = path.resolve('.');
  const bundle = await build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: root }, absWorkingDir: root,
    write: false, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"' } });
  const runtime = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/app.js') res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else if (pathname === '/wrapper') res.writeHead(200, { 'Content-Type': 'text/html' }).end(wrapper);
    else if (pathname === '/inner') res.writeHead(200, { 'Content-Type': 'text/html' }).end(inner);
    else if (pathname === '/destination') res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Destination</h1>');
    else res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
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
        const frame = () => page.frameLocator('#wrapper').frameLocator('#inner');
        await frame().locator('#pending').click();
        await page.locator('#activate').click();
        await page.waitForFunction(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
        let response: 'accept' | 'dismiss' = 'dismiss';
        const dialogs: string[] = [];
        page.on('dialog', async (dialog: { type(): string; accept(): Promise<void>; dismiss(): Promise<void> }) => {
          dialogs.push(dialog.type()); await dialog[response]();
        });
        await page.locator('#automatic').click();
        assert.equal(await page.locator('#version').textContent(), '0');
        assert.equal(dialogs.length, 0);
        await page.locator('#refresh').click();
        assert.equal(await page.locator('#version').textContent(), '0');
        assert.deepEqual(dialogs, ['confirm']);
        await page.locator('#leave').click();
        assert.equal(new URL(page.url()).pathname, '/');
        assert.deepEqual(dialogs, ['confirm', 'confirm']);
        const nativeDialog = page.waitForEvent('dialog');
        const navigation = page.goto(origin + '/destination').catch(() => null);
        await nativeDialog;
        await navigation;
        assert.equal(dialogs.at(-1), 'beforeunload', 'native top-level guard works above the sandbox');
        assert.equal(new URL(page.url()).pathname, '/');
        response = 'accept';
        await page.locator('#refresh').click();
        await page.waitForFunction(() => document.getElementById('version')?.textContent === '1');
        await frame().locator('#pending').click();
        await page.waitForFunction(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
        await frame().locator('#saved').click();
        await page.waitForFunction(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
        // Same-origin status from the wrong source cannot re-arm the guard.
        await page.evaluate((value: string) => window.postMessage({ marker: value, type: 'pending-state', pending: true }, location.origin), marker);
        const previousDialogs = dialogs.length;
        await page.locator('#leave').click();
        await page.waitForURL(origin + '/destination');
        assert.equal(dialogs.length, previousDialogs);
        assert.deepEqual(errors, []);
        console.log(`${name}: sandbox/top beforeunload, pending confirm, automatic refresh block, reload re-arm, ACK clear and wrong-source rejection passed`);
      } finally { await browser.close(); }
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
