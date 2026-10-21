/** Actual IndexedDB + delivery class, two tabs/reloads; synthetic data only, no production/database. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import type { DashboardUsageBatch } from '../src/shared/lib/dashboardUsage';
import { DASHBOARD_USAGE_SESSION_HEADER } from '../src/shared/lib/dashboardUsageDelivery';

async function main() {
  const root = path.resolve('.');
  const runtime = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'ts', contents: `
    import {DashboardUsageDelivery} from './src/shared/lib/dashboardUsageDelivery';
    import {createDashboardUsageOutbox,DASHBOARD_USAGE_OUTBOX_DATABASE,DASHBOARD_USAGE_OUTBOX_LIMIT,DASHBOARD_USAGE_OUTBOX_MAX_BYTES,DASHBOARD_USAGE_OUTBOX_MAX_AGE_MS,dashboardUsageEntryBytes} from './src/shared/lib/dashboardUsageOutbox';
    const query=new URL(location.href).searchParams;
    window.syntheticOffline=query.get('offline')==='1';
    window.syntheticUsage=new DashboardUsageDelivery(query.get('scope')||'scope-a',{online:()=>!window.syntheticOffline});
    window.syntheticOutbox=createDashboardUsageOutbox;
    window.syntheticLimits={database:DASHBOARD_USAGE_OUTBOX_DATABASE,count:DASHBOARD_USAGE_OUTBOX_LIMIT,bytes:DASHBOARD_USAGE_OUTBOX_MAX_BYTES,age:DASHBOARD_USAGE_OUTBOX_MAX_AGE_MS};
    window.syntheticBytes=dashboardUsageEntryBytes;
    window.syntheticUsage.resume();
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022' });
  let currentSession = 'scope-a';
  const rejected = new Map<string, number>();
  const requests: Array<{ scope: string; payload: DashboardUsageBatch; status: number }> = [];
  const stored = new Map<string, DashboardUsageBatch['events'][number]>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end('<!doctype html><title>Usage outbox fixture</title><script src="/app.js"></script>');
    else if (url.pathname === '/app.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else if (url.pathname === '/api/admin/dashboard-usage') {
      const bytes: Buffer[] = [];
      request.on('data', (chunk: Buffer) => bytes.push(chunk));
      request.on('end', () => {
        const payload = JSON.parse(Buffer.concat(bytes).toString()) as DashboardUsageBatch;
        const scope = String(request.headers[DASHBOARD_USAGE_SESSION_HEADER.toLowerCase()] ?? '');
        const status = scope !== currentSession ? 409 : rejected.get(payload.dashboardKey) ?? 200;
        requests.push({ scope, payload, status });
        if (status === 200) for (const event of payload.events) stored.set(`${scope}:${event.id}`, event);
        response.writeHead(status, { 'Content-Type': 'application/json' }).end(status === 200 ? '{"ok":true}' : '{"error":"Synthetic rejection"}');
      });
    } else response.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engineName of ['chromium', 'webkit']) {
      const browser = await playwright[engineName].launch({ headless: true });
      try {
        currentSession = 'scope-a'; rejected.clear(); requests.length = 0; stored.clear();
        const context = await browser.newContext();
        await context.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.goto(`${origin}/?scope=scope-a&offline=1`);
        await page.waitForFunction(() => (window as unknown as TestWindow).syntheticUsage?.getSnapshot().storage === 'ready');
        const original = await page.evaluate(async () => {
          const w = window as unknown as TestWindow;
          for (let i = 0; i < 1205; i++) w.syntheticUsage.enqueue({ dashboardKey: 'top:4', preview: false, versionId: 7 }, { id: `persisted_event_${String(i).padStart(8, '0')}`, action: 'filter_changed' });
          await w.syntheticUsage.persistPending(); await w.syntheticUsage.flush();
          return { state: w.syntheticUsage.getSnapshot(), entries: (await w.syntheticOutbox('scope-a').load(Date.now())).entries };
        });
        assert.equal(original.state.pending, 1205); assert.equal(original.state.unsaved, 0);
        assert.equal(requests.length, 0);
        await page.reload();
        await page.waitForFunction(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().pending === 1205);
        assert.equal(await page.evaluate(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().unsaved), 0);
        await page.evaluate(async () => { const w = window as unknown as TestWindow; w.syntheticOffline = false; await w.syntheticUsage.flush(); });
        await page.waitForFunction(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().pending === 0);
        assert.equal(stored.size, 1205);
        assert.deepEqual(stored.get(`scope-a:${original.entries[0].event.id}`), original.entries[0].event, 'original captured time and ID survive a real reload');
        assert.equal(await page.evaluate(async () => (await (window as unknown as TestWindow).syntheticOutbox('scope-a').load(Date.now())).entries.length), 0);

        rejected.set('top:4', 403);
        await page.evaluate(async () => {
          const w = window as unknown as TestWindow;
          w.syntheticUsage.enqueue({ dashboardKey: 'top:4', preview: false, versionId: 7 }, { id: 'quarantined_event_0001', action: 'report_open' });
          w.syntheticUsage.enqueue({ dashboardKey: 'currency-rates', preview: false, versionId: null }, { id: 'allowed_event_00000001', action: 'report_open' });
          await w.syntheticUsage.flush();
        });
        await page.waitForFunction(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().pending === 0);
        assert.equal(await page.evaluate(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().quarantined), 1);
        assert.ok(stored.has('scope-a:allowed_event_00000001'));
        await page.reload();
        await page.waitForFunction(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().quarantined === 1);
        const rejectedCalls = requests.filter((request) => request.status === 403).length;
        await page.evaluate(async () => (window as unknown as TestWindow).syntheticUsage.flush());
        assert.equal(requests.filter((request) => request.status === 403).length, rejectedCalls, 'quarantined event is not retried after reload');
        rejected.clear();

        await page.evaluate(async () => {
          const w = window as unknown as TestWindow; w.syntheticOffline = true;
          w.syntheticUsage.enqueue({ dashboardKey: 'currency-rates', preview: false, versionId: null }, { id: 'old_account_event_0001', action: 'data_loaded', upload: { name: 'Private-A.json', size: 123 } });
          await w.syntheticUsage.persistPending();
        });
        currentSession = 'scope-b';
        const other = await context.newPage();
        await other.goto(`${origin}/?scope=scope-b&offline=1`);
        await other.waitForFunction(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().storage === 'ready');
        assert.equal(await other.evaluate(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().pending), 0, 'different session cannot load another employee queue');
        assert.equal(await other.evaluate(async () => (await (window as unknown as TestWindow).syntheticOutbox('scope-b').load(Date.now())).entries.length), 0);
        await other.evaluate(async () => {
          const w = window as unknown as TestWindow; w.syntheticOffline = false;
          w.syntheticUsage.enqueue({ dashboardKey: 'currency-rates', preview: false, versionId: null }, { id: 'new_account_event_0001', action: 'report_open' }); await w.syntheticUsage.flush();
        });
        assert.ok(stored.has('scope-b:new_account_event_0001'));
        assert.ok(!stored.has('scope-b:old_account_event_0001'));
        await page.evaluate(async () => { const w = window as unknown as TestWindow; w.syntheticOffline = false; await w.syntheticUsage.flush(); });
        assert.equal(await page.evaluate(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().status), 'session');
        assert.equal(requests.at(-1)?.scope, 'scope-a'); assert.equal(requests.at(-1)?.status, 409);
        await page.close(); await other.close();

        // Two same-session tabs never overwrite one another's IDs. Both may resend a recovered ID;
        // the API's idempotency key, not a fragile browser leader election, removes duplicates.
        currentSession = 'scope-c';
        const left = await context.newPage(); const right = await context.newPage();
        await Promise.all([left.goto(`${origin}/?scope=scope-c&offline=1`), right.goto(`${origin}/?scope=scope-c&offline=1`)]);
        for (const tab of [left, right]) await tab.waitForFunction(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().storage === 'ready');
        await Promise.all([left, right].map((tab, index) => tab.evaluate(async (prefix: string) => {
          const w = window as unknown as TestWindow;
          for (let i = 0; i < 25; i++) w.syntheticUsage.enqueue({ dashboardKey: 'top:5', preview: false, versionId: 8 }, { id: `${prefix}_parallel_event_${i}`, action: 'filter_changed' });
          await w.syntheticUsage.persistPending();
        }, index === 0 ? 'left' : 'right')));
        assert.equal(await left.evaluate(async () => (await (window as unknown as TestWindow).syntheticOutbox('scope-c').load(Date.now())).entries.length), 50);
        await Promise.all([left.reload(), right.reload()]);
        for (const tab of [left, right]) await tab.waitForFunction(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().pending === 50);
        await Promise.all([left, right].map((tab) => tab.evaluate(async () => { const w = window as unknown as TestWindow; w.syntheticOffline = false; await w.syntheticUsage.flush(); })));
        for (const tab of [left, right]) await tab.waitForFunction(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().pending === 0);
        assert.equal([...stored.keys()].filter((key) => key.startsWith('scope-c:')).length, 50);
        assert.equal(await left.evaluate(async () => (await (window as unknown as TestWindow).syntheticOutbox('scope-c').load(Date.now())).entries.length), 0);

        const storageChecks = await left.evaluate(async () => {
          const w = window as unknown as TestWindow;
          const store = w.syntheticOutbox('scope-c');
          const now = Date.now();
          const sample = { context: { dashboardKey: 'top:5', preview: false, versionId: 8 }, event: { id: 'expired_event_0000001', action: 'filter_changed' as const, capturedAt: new Date(now - w.syntheticLimits.age - 1).toISOString() }, queuedAt: now - w.syntheticLimits.age - 1 };
          await store.put(sample);
          const expired = await store.load(now);
          const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(w.syntheticLimits.database); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
          const rows = await new Promise<Array<{ scope: string; key: string }>>((resolve) => { const request = db.transaction('events').objectStore('events').getAll(); request.onsuccess = () => resolve(request.result); });
          db.close();
          return { expired: expired.expired, persisted: rows, webStorage: localStorage.length + sessionStorage.length };
        });
        assert.equal(storageChecks.expired, 1);
        assert.ok(storageChecks.persisted.every((row: { scope: string; key: string }) => /^[a-f0-9]{64}$/.test(row.scope) && row.key.startsWith(`${row.scope}:`)));
        assert.ok(!JSON.stringify(storageChecks.persisted).includes('scope-a'), 'raw session ID is not persisted');
        assert.equal(storageChecks.webStorage, 0);
        await left.evaluate(async () => { const w = window as unknown as TestWindow; await w.syntheticOutbox('scope-c').recordLoss('overflow', 7, Date.now()); });
        await left.reload();
        await left.waitForFunction(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().skipped === 7);
        assert.equal(await left.evaluate(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().expired), 1, 'expiration warning also survives reload');
        await left.close(); await right.close(); await context.close();
        assert.deepEqual(errors, []);
        const quotaContext = await browser.newContext();
        const quotaPage = await quotaContext.newPage();
        await quotaPage.goto(`${origin}/?scope=quota-scope&offline=1`);
        await quotaPage.waitForFunction(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().storage === 'ready');
        const quotaResult = await quotaPage.evaluate(async () => {
          const w = window as unknown as TestWindow;
          const store = w.syntheticOutbox('quota-scope'); const now = Date.now();
          const sample = { context: { dashboardKey: 'top:5', preview: false, versionId: 8 }, event: { id: 'quota_seed_event_0000', action: 'filter_changed' as const, capturedAt: new Date(now).toISOString() }, queuedAt: now };
          await store.put(sample);
          const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(w.syntheticLimits.database); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
          const first = await new Promise<{ scope: string }>((resolve) => { const request = db.transaction('events').objectStore('events').getAll(); request.onsuccess = () => resolve(request.result[0]); });
          // Seed the finite upper-bound fixture in one transaction, avoiding 20k test-only fsyncs.
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(['events', 'metadata'], 'readwrite'); const events = tx.objectStore('events');
            events.clear(); let bytes = 0;
            for (let i = 0; i < w.syntheticLimits.count - 1; i++) {
              const entry = { ...sample, event: { ...sample.event, id: `quota_event_${String(i).padStart(8, '0')}` } };
              const size = w.syntheticBytes(entry); bytes += size;
              events.add({ ...entry, key: `${first.scope}:${entry.event.id}`, scope: first.scope, bytes: size });
            }
            tx.objectStore('metadata').put({ key: 'quota', count: w.syntheticLimits.count - 1, bytes });
            tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
          });
          const concurrent = await Promise.all([
            store.put({ ...sample, event: { ...sample.event, id: 'quota_last_event_00001' } }),
            w.syntheticOutbox('quota-scope').put({ ...sample, event: { ...sample.event, id: 'quota_last_event_00002' } }),
          ]);
          const started = performance.now(); const full = await store.load(now);
          await store.recordLoss('overflow', 1, now);
          db.close();
          return { concurrent, entries: full.entries.length, loadMs: Math.round(performance.now() - started) };
        });
        assert.deepEqual(quotaResult.concurrent.sort(), ['full', 'stored'], 'concurrent writers cannot exceed the global count quota');
        assert.equal(quotaResult.entries, 20_000);
        await quotaPage.reload();
        await quotaPage.waitForFunction(() => (window as unknown as TestWindow).syntheticUsage.getSnapshot().pending === 20_000 && (window as unknown as TestWindow).syntheticUsage.getSnapshot().skipped === 1);
        await quotaContext.close();
        console.log(`${engineName}: IndexedDB 1205-event reload/ACK, timestamp retention, persistent per-report quarantine, account isolation, two-tab merge/ACK and expiry passed`);
        console.log(`${engineName}: 20k durable quota atomic under concurrent writers; full bounded reload ${quotaResult.loadMs} ms; durable overflow warning passed`);
      } finally { await browser.close(); }
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

type TestWindow = {
  syntheticOffline: boolean;
  syntheticUsage: import('../src/shared/lib/dashboardUsageDelivery').DashboardUsageDelivery;
  syntheticOutbox: typeof import('../src/shared/lib/dashboardUsageOutbox').createDashboardUsageOutbox;
  syntheticLimits: { database: string; count: number; bytes: number; age: number };
  syntheticBytes: typeof import('../src/shared/lib/dashboardUsageOutbox').dashboardUsageEntryBytes;
};
void main().catch((error) => { console.error(error); process.exitCode = 1; });
