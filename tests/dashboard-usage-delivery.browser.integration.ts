/** Actual provider + hook, synthetic sessions and actions only. No production/database connections. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { DASHBOARD_USAGE_MARKER, type DashboardUsageBatch } from '../src/shared/lib/dashboardUsage';
import { DASHBOARD_USAGE_SESSION_HEADER } from '../src/shared/lib/dashboardUsageDelivery';

async function main() {
  const root = path.resolve('.');
  const runtime = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const bundle = await build({
    absWorkingDir: root, stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React, {useRef,useState} from 'react';import{createRoot}from'react-dom/client';
      import{DashboardUsageDeliveryProvider,useDashboardUsageDelivery}from'./src/features/admin/dashboard-usage/DashboardUsageDeliveryProvider';
      import{useDashboardUsage}from'./src/features/admin/dashboard-usage/useDashboardUsage';
      function Report(){const frame=useRef(null);const record=useDashboardUsage({dashboardKey:'top:4',iframeRef:frame,versionId:7});
        return <><button id="event" onClick={()=>record('filter_changed')}>Change filter</button><iframe title="Synthetic report" ref={frame} src="/report" /></>}
      function App(){const[version,setVersion]=useState(0);const delivery=useDashboardUsageDelivery();window.syntheticUsage=delivery;
        return <><button id="remount" onClick={()=>setVersion(version+1)}>Remount report</button>
          <a id="internal" href="/admin/another" onClick={event=>{event.preventDefault();window.syntheticNavigated='internal'}}>Internal</a>
          <a id="outside" href="/outside" onClick={event=>{event.preventDefault();window.syntheticNavigated='outside'}}>Outside</a>
          <Report key={version}/></>}
      createRoot(document.getElementById('root')).render(<DashboardUsageDeliveryProvider sessionId="scope-a"><App/></DashboardUsageDeliveryProvider>);
    ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' }, alias: { '@': path.join(root, 'src') },
    plugins: [{ name: 'styles', setup(plugin) { plugin.onLoad({ filter: /\.module\.scss$/ }, () => ({ contents: 'export default {notice:"notice"}', loader: 'js' })); } }],
  });
  let currentSession = 'scope-a', loseNextAcknowledgement = false;
  const stored = new Set<string>();
  const requests: Array<{ scope: string | undefined; payload: DashboardUsageBatch; accepted: boolean }> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><html lang="en"><div id="root"></div><script src="/app.js"></script></html>');
    else if (url.pathname === '/app.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else if (url.pathname === '/report') response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<!doctype html><h1>Synthetic report</h1><script>
      window.addEventListener('message',event=>{if(event.source===parent&&event.data?.marker==='${DASHBOARD_USAGE_MARKER}'&&event.data.type==='init'){window.syntheticNonce=event.data.nonce;parent.postMessage({marker:'${DASHBOARD_USAGE_MARKER}',type:'event',nonce:event.data.nonce,action:'report_open'},location.origin)}});
      parent.postMessage({marker:'${DASHBOARD_USAGE_MARKER}',type:'ready'},location.origin);
    </script>`);
    else if (url.pathname === '/api/admin/dashboard-usage') {
      const bytes: Buffer[] = [];
      request.on('data', (chunk: Buffer) => bytes.push(chunk));
      request.on('end', () => {
        const payload = JSON.parse(Buffer.concat(bytes).toString()) as DashboardUsageBatch;
        const scope = request.headers[DASHBOARD_USAGE_SESSION_HEADER.toLowerCase()] as string | undefined;
        const accepted = scope === currentSession;
        requests.push({ scope, payload, accepted });
        if (!accepted) { response.writeHead(409, { 'Content-Type': 'application/json' }).end('{"error":"Session changed"}'); return; }
        for (const entry of payload.events) stored.add(`${scope}:${entry.id}`);
        if (loseNextAcknowledgement) { loseNextAcknowledgement = false; response.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"Synthetic gateway failure after write"}'); return; }
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      });
    } else response.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engineName of ['chromium', 'webkit']) {
      currentSession = 'scope-a'; loseNextAcknowledgement = false; requests.length = 0; stored.clear();
      const browser = await playwright[engineName].launch({ headless: true });
      try {
        const context = await browser.newContext();
        await context.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); const errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.goto(origin);
        await page.waitForFunction(() => (window as unknown as { syntheticUsage: { getSnapshot(): { pending: number } } }).syntheticUsage?.getSnapshot().pending > 0);
        loseNextAcknowledgement = true;
        await page.evaluate(() => (window as unknown as { syntheticUsage: { flush(): Promise<void> } }).syntheticUsage.flush());
        await page.getByRole('status').waitFor();
        const original = requests[0].payload.events[0].id;
        await page.locator('#remount').click();
        await page.waitForFunction(() => (window as unknown as { syntheticUsage: { getSnapshot(): { pending: number } } }).syntheticUsage.getSnapshot().pending === 0);
        assert.ok(requests.filter((entry) => entry.payload.events.some((event) => event.id === original)).length >= 2, 'same ID retried after server stored but ACK lost');
        assert.equal([...stored].filter((id) => id.endsWith(original)).length, 1, 'idempotent storage');
        await context.setOffline(true);
        await page.locator('#event').click();
        await page.evaluate(() => (window as unknown as { syntheticUsage: { flush(): Promise<void> } }).syntheticUsage.flush());
        await page.waitForFunction(() => (window as unknown as { syntheticUsage: { getSnapshot(): { status: string } } }).syntheticUsage.getSnapshot().status === 'offline');
        assert.ok(await page.getByRole('status').isVisible());
        await context.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await page.waitForFunction(() => (window as unknown as { syntheticUsage: { getSnapshot(): { pending: number } } }).syntheticUsage.getSnapshot().pending === 0);
        await page.getByRole('status').waitFor({ state: 'hidden' });
        // Real IntersectionObserver excludes reports hidden/scrolled out of the viewport.
        const viewingEvents = () => requests.filter((request) => request.accepted).flatMap((request) => request.payload.events).filter((event) => event.action === 'viewing_time');
        await page.waitForTimeout(1200);
        await page.evaluate(async () => { const usage = (window as unknown as { syntheticUsage: { viewing: { flush(): void }; flush(): Promise<void> } }).syntheticUsage; usage.viewing.flush(); await usage.flush(); });
        assert.ok(viewingEvents().length > 0);
        await page.waitForFunction(() => (window as unknown as { syntheticUsage: { getSnapshot(): { pending: number } } }).syntheticUsage.getSnapshot().pending === 0);
        const beforeHealthyClosing = viewingEvents().length;
        await page.waitForTimeout(1200);
        const healthyClosing = await page.evaluate(() => {
          const usage = (window as unknown as { syntheticUsage: { getSnapshot(): { pending: number } } }).syntheticUsage;
          const pendingBefore = usage.getSnapshot().pending;
          const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event);
          return { pendingBefore, prevented: event.defaultPrevented, pendingAfter: usage.getSnapshot().pending };
        });
        assert.deepEqual(healthyClosing, { pendingBefore: 0, prevented: false, pendingAfter: 1 }, 'fresh final viewing pulse does not prompt on healthy closing');
        await page.waitForFunction(() => (window as unknown as { syntheticUsage: { getSnapshot(): { pending: number } } }).syntheticUsage.getSnapshot().pending === 0);
        assert.ok(viewingEvents().length > beforeHealthyClosing, 'final viewing pulse is still sent with the normal keepalive delivery');
        await page.locator('iframe').evaluate((frame: HTMLIFrameElement) => { frame.style.display = 'none'; });
        await page.waitForTimeout(100);
        await page.evaluate(() => (window as unknown as { syntheticUsage: { flush(): Promise<void> } }).syntheticUsage.flush());
        const beforeHiddenFrame = viewingEvents().length;
        await page.waitForTimeout(1200);
        await page.evaluate(async () => { const usage = (window as unknown as { syntheticUsage: { viewing: { flush(): void }; flush(): Promise<void> } }).syntheticUsage; usage.viewing.flush(); await usage.flush(); });
        assert.equal(viewingEvents().length, beforeHiddenFrame);
        await page.locator('iframe').evaluate((frame: HTMLIFrameElement) => { frame.style.display = ''; });
        await page.waitForTimeout(1200);
        await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
        await page.waitForFunction(() => (window as unknown as { syntheticUsage: { getSnapshot(): { pending: number } } }).syntheticUsage.getSnapshot().pending === 0);
        const beforeHiddenTab = viewingEvents().length;
        await page.waitForTimeout(1200);
        await page.evaluate(async () => { const usage = (window as unknown as { syntheticUsage: { viewing: { flush(): void }; flush(): Promise<void> } }).syntheticUsage; usage.viewing.flush(); await usage.flush(); });
        assert.equal(viewingEvents().length, beforeHiddenTab, 'hidden document contributes no viewing time');
        await page.evaluate(() => { delete (document as unknown as { hidden?: boolean }).hidden; document.dispatchEvent(new Event('visibilitychange')); });
        await page.waitForTimeout(1200);
        await page.evaluate(async () => { const usage = (window as unknown as { syntheticUsage: { viewing: { flush(): void }; flush(): Promise<void> } }).syntheticUsage; usage.viewing.flush(); await usage.flush(); });
        assert.ok(viewingEvents().length > beforeHiddenTab);
        assert.ok(viewingEvents().at(-1)!.durationSeconds! <= 2, 'resume starts a fresh short segment');
        const reportFrame = page.frames().find((frame: { url(): string }) => frame.url().endsWith('/report')); assert.ok(reportFrame);
        await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
        await reportFrame.evaluate((marker: string) => {
          for (const name of ['first.json', 'second.json']) parent.postMessage({ marker, type: 'event', nonce: (window as unknown as { syntheticNonce: string }).syntheticNonce, action: 'data_loaded', upload: { name, size: 42 } }, location.origin);
        }, DASHBOARD_USAGE_MARKER);
        await page.waitForFunction(() => (window as unknown as { syntheticUsage: { getSnapshot(): { pending: number } } }).syntheticUsage.getSnapshot().pending >= 2);
        await page.evaluate(() => (window as unknown as { syntheticUsage: { flush(): Promise<void> } }).syntheticUsage.flush());
        const uploaded = requests.filter((request) => request.accepted).flatMap((request) => request.payload.events).filter((event) => event.upload);
        assert.deepEqual(uploaded.map((event) => event.upload!.name), ['first.json', 'second.json'], 'two successful files are retained even when processing completes after tab hides');
        await page.evaluate(() => { delete (document as unknown as { hidden?: boolean }).hidden; document.dispatchEvent(new Event('visibilitychange')); });
        // Account B logs in in another tab; the existing rendered report still belongs to A.
        currentSession = 'scope-b';
        await page.waitForTimeout(550); await page.locator('#event').click();
        await page.evaluate(() => (window as unknown as { syntheticUsage: { flush(): Promise<void> } }).syntheticUsage.flush());
        await page.waitForFunction(() => (window as unknown as { syntheticUsage: { getSnapshot(): { status: string } } }).syntheticUsage.getSnapshot().status === 'session');
        assert.equal(requests.at(-1)?.scope, 'scope-a'); assert.equal(requests.at(-1)?.accepted, false);
        assert.ok([...stored].every((id) => id.startsWith('scope-a:')), 'no historical action attributed to B');
        const stoppedCount = requests.length;
        await page.evaluate(() => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
        await page.waitForTimeout(1200); assert.equal(requests.length, stoppedCount, 'stale scope does not retry or refresh identity');
        const pendingClosingPrevented = await page.evaluate(() => {
          const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event);
          return event.defaultPrevented;
        });
        assert.equal(pendingClosingPrevented, true, 'previously unconfirmed events still warn on closing');
        let unexpectedDialog = false;
        const internalDialog = async (dialog: { dismiss(): Promise<void> }) => { unexpectedDialog = true; await dialog.dismiss(); };
        page.on('dialog', internalDialog);
        await page.locator('#internal').click();
        assert.equal(await page.evaluate(() => (window as unknown as { syntheticNavigated: string }).syntheticNavigated), 'internal');
        assert.equal(unexpectedDialog, false, 'pending journal never blocks intra-admin navigation');
        page.off('dialog', internalDialog);
        const cancelDialog = page.waitForEvent('dialog').then(async (dialog: { message(): string; dismiss(): Promise<void> }) => {
          assert.match(dialog.message(), /ОК — уйти, Отмена — остаться/); await dialog.dismiss();
        });
        await page.locator('#outside').click(); await cancelDialog;
        assert.equal(await page.evaluate(() => (window as unknown as { syntheticNavigated: string }).syntheticNavigated), 'internal', 'cancel blocks SPA departure');
        const acceptDialog = page.waitForEvent('dialog').then(async (dialog: { accept(): Promise<void> }) => { await dialog.accept(); });
        await page.locator('#outside').click(); await acceptDialog;
        assert.equal(await page.evaluate(() => (window as unknown as { syntheticNavigated: string }).syntheticNavigated), 'outside', 'explicit approval permits departure');
        assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
        assert.deepEqual(errors, []);
        await context.close();
        console.log(`${engineName}: actual provider/hook retry, remount retention, offline/online status, visible viewport/tab time, file metadata and cross-session rejection passed`);
      } finally { await browser.close(); }
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
