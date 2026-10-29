/**
 * Regression for snapshot delivery before streamed author HTML installs its handlers.
 * node --import tsx tests/top-dashboard-streamed-restore.browser.integration.ts
 * Real adapter, wrapper and CSP; synthetic data, localhost requests only.
 */
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildTopDashboardContentSecurityPolicy,
  buildTopDashboardFrameSecurityPolicy,
  createTopDashboardFrameBridgeScript,
  injectTopDashboardDataAdapter,
} from '../src/shared/lib/topDashboardContentSecurity';
import { encodeTopDashboardMultiFileSnapshot } from '../src/shared/lib/topDashboardMultiFileSnapshot';

const basePath = '/api/admin/top-dashboard/blocks/7';
const framePath = `${basePath}/versions/51/frame`;
const contentPath = `${basePath}/versions/51/content`;
const dataPath = `${basePath}/data`;
const tailMarker = '<!--AUTHOR-HANDLERS-ARRIVE-LATER-->';
const snapshotText = JSON.stringify({ rows: [{ id: 'synthetic', amount: 42 }] });
const genericSnapshot = Buffer.from(encodeTopDashboardMultiFileSnapshot({
  targets: [{
    target: { id: 'fFiles', index: 0 },
    files: [{ name: 'synthetic.ktsp', type: 'application/json', bytes: Buffer.from(snapshotText) }],
  }],
}));

type Fixture = { format: 'generic' | 'legacy'; streamed: boolean; bindOnDomReady: boolean; viewer: boolean };
type RestoreTrace = {
  probes: number;
  starts: number;
  changes: Array<{ readyState: string; fileCount: number }>;
  nativeCalls: number;
  handlerReadyState: string | null;
  restoreId: number | null;
};

function authorHtml(fixture: Fixture) {
  const inputId = fixture.format === 'generic' ? 'fFiles' : 'file';
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<input type="file" id="${inputId}" accept=".ktsp,.json"><pre id="result">EMPTY</pre>
<script>
${fixture.format === 'legacy' ? "const DASH_NAME = 'аналитика_продаж'; const fixtureBundle = {format:'kts-bundle'};" : ''}
window.restoreTrace = {probes:0, starts:0, changes:[], nativeCalls:0, handlerReadyState:null, restoreId:null};
window.addEventListener('message', e => {
  if (e.source === parent && e.data?.type === 'bridge-probe') window.restoreTrace.probes++;
});
window.addEventListener('kts-top-dashboard-restore-start', e => {
  window.restoreTrace.starts++; window.restoreTrace.restoreId = e.detail.restoreId;
});
document.addEventListener('change', e => {
  if (e.target.id === '${inputId}') window.restoreTrace.changes.push({readyState:document.readyState, fileCount:e.target.files.length});
});
</script>
${tailMarker}
<script>
function bindAuthorHandler() {
  window.restoreTrace.handlerReadyState = document.readyState;
  document.addEventListener('change', async e => {
    if (e.target.id !== '${inputId}') return;
    // The reviewed author HTML copies the selection and immediately resets it.
    const files = Array.from(e.target.files); e.target.value = '';
    window.restoreTrace.nativeCalls++;
    document.getElementById('result').textContent = await files[0].text();
    window.dispatchEvent(new CustomEvent('kts-top-dashboard-data-ready', {detail:{restoreId:window.restoreTrace.restoreId}}));
  });
}
${fixture.bindOnDomReady ? "document.addEventListener('DOMContentLoaded', bindAuthorHandler, {once:true});" : 'bindAuthorHandler();'}
</script></body></html>`;
}

async function main() {
  const modulePath = process.env.PLAYWRIGHT_MODULE_PATH
    ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  let fixture: Fixture = { format: 'generic', streamed: false, bindOnDomReady: false, viewer: false };
  let pendingTail: { response: ServerResponse; text: string } | null = null;
  let gets = 0;
  const serverErrors: string[] = [];
  const server = createServer((request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const common = { 'Cache-Control': 'no-store' };
      if (pathname === '/') {
        response.writeHead(200, { ...common, 'Content-Type': 'text/html; charset=utf-8' })
          .end(`<!doctype html><iframe id="outer" sandbox="allow-scripts allow-same-origin" src="${framePath}"></iframe>`);
      } else if (pathname === framePath) {
        const bridge = `${createTopDashboardFrameBridgeScript(7, 51, !fixture.viewer)}
window.readyMessages = [];
window.addEventListener('message', e => {
  if (e.source === document.getElementById('dashboard-frame').contentWindow && e.data?.type === 'adapter-ready') window.readyMessages.push(e.data);
});`;
        response.writeHead(200, {
          ...common, 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': buildTopDashboardFrameSecurityPolicy(bridge),
        }).end(`<!doctype html><iframe id="dashboard-frame" sandbox="allow-scripts allow-popups" src="${contentPath}"></iframe><div id="data-notice" hidden></div><script>${bridge}</script>`);
      } else if (pathname === contentPath) {
        const html = injectTopDashboardDataAdapter(authorHtml(fixture), { readOnly: fixture.viewer });
        response.writeHead(200, {
          ...common, 'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': buildTopDashboardContentSecurityPolicy(html),
        });
        if (!fixture.streamed) response.end(html);
        else {
          const split = html.indexOf(tailMarker);
          assert.ok(split > 0);
          pendingTail = { response, text: html.slice(split) };
          response.write(html.slice(0, split));
        }
      } else if (pathname === dataPath && request.method === 'GET') {
        gets++;
        response.writeHead(200, {
          ...common,
          'Content-Type': fixture.format === 'generic' ? 'application/octet-stream' : 'application/json',
          'X-Top-Dashboard-Data-Version-Id': '190',
          'X-Top-Dashboard-Data-Snapshot-Format': fixture.format === 'generic' ? 'multi-file-v1' : 'kts-bundle-v1',
          'X-Top-Dashboard-Data-Profile': fixture.format === 'generic' ? 'generic' : 'sales-analytics',
          'X-Top-Dashboard-Data-Bound-Html-Version-Id': '51',
          'X-Top-Dashboard-Data-Original-Name': 'synthetic.json',
        }).end(fixture.format === 'generic' ? genericSnapshot : snapshotText);
      } else response.writeHead(404, common).end();
    } catch (error) {
      serverErrors.push(String(error));
      response.destroy();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  let cases = 0;
  let engines = 0;
  try {
    for (const engineName of ['chromium', 'webkit']) {
      const engine = playwright[engineName];
      try { await access(engine.executablePath()); }
      catch { console.log(`SKIP ${engineName}: executable unavailable`); continue; }
      engines++;
      const browser = await engine.launch({ headless: true });
      try {
        for (const viewer of [false, true]) {
          for (const settings of [
            { format: 'generic', streamed: false, bindOnDomReady: false },
            { format: 'generic', streamed: true, bindOnDomReady: false },
            { format: 'generic', streamed: true, bindOnDomReady: true },
            { format: 'legacy', streamed: true, bindOnDomReady: true },
          ] as const) {
            fixture = { ...settings, viewer };
            pendingTail = null;
            gets = 0;
            const label = `${engineName} ${viewer ? 'viewer' : 'manager'} ${fixture.format} ${fixture.streamed ? 'streamed' : 'complete'} ${fixture.bindOnDomReady ? 'DOMContentLoaded' : 'direct'}`;
            const context = await browser.newContext();
            const errors: string[] = [];
            const blocked: string[] = [];
            try {
              await context.route('**/*', async (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => {
                const url = new URL(route.request().url());
                if (url.origin === origin) return route.continue();
                blocked.push(url.href);
                return route.abort();
              });
              const page = await context.newPage();
              page.on('pageerror', (error: Error) => errors.push(error.message));
              await page.goto(origin, { waitUntil: 'commit' });
              const report = page.frameLocator('#outer').frameLocator('#dashboard-frame');
              await report.locator('#result').waitFor();
              const inner = page.frames().find((frame: { url(): string }) => frame.url().endsWith(contentPath));
              const wrapper = page.frames().find((frame: { url(): string }) => frame.url().endsWith(framePath));
              assert.ok(inner && wrapper, label);
              if (fixture.streamed) {
                // Send probes from the trusted wrapper while the author's tail
                // remains unavailable. This also fails before the fix, when the
                // first early ready incorrectly stops the automatic probe timer.
                await wrapper.evaluate((format: string) => {
                  const target = document.querySelector<HTMLIFrameElement>('#dashboard-frame')!.contentWindow!;
                  // Even an accidental early delivery from the trusted parent
                  // must not import, queue or block the later genuine restore.
                  const bytes = new TextEncoder().encode('{"premature":true}');
                  if (format === 'generic') {
                    target.postMessage({
                      marker: 'kts-top-dashboard-multi-file-v1', type: 'restore-files', restoreId: 999,
                      targets: [{ target: { id: 'fFiles', name: null, index: 0 }, files: [{
                        name: 'premature.ktsp', type: 'application/json', lastModified: 1,
                        webkitRelativePath: '', blob: new Blob([bytes], { type: 'application/json' }),
                      }] }],
                    }, '*');
                  } else {
                    target.postMessage({ marker: 'kts-top-dashboard-data-v1', type: 'snapshot-data', name: 'premature.json', buffer: bytes.buffer }, '*');
                  }
                  for (let count = 0; count < 3; count++) target.postMessage({ marker: 'kts-top-dashboard-data-v1', type: 'bridge-probe' }, '*');
                }, fixture.format);
                await inner.waitForFunction(() => (window as unknown as { restoreTrace: RestoreTrace }).restoreTrace?.probes >= 3);
                const before = await inner.evaluate(() => ({
                  readyState: document.readyState,
                  ...((window as unknown as { restoreTrace: RestoreTrace }).restoreTrace),
                }));
                assert.equal(before.readyState, 'loading', label);
                assert.equal(before.nativeCalls, 0, label);
                assert.deepEqual(before.changes, [], `${label}: no selection may be delivered before author handlers`);
                assert.equal(before.starts, 0, `${label}: restoration must not begin while parsing`);
                assert.equal(await wrapper.evaluate(() => (window as unknown as { readyMessages: unknown[] }).readyMessages.length), 0, `${label}: probes cannot announce early readiness`);
                assert.ok(pendingTail, label);
                const tail = pendingTail as { response: ServerResponse; text: string };
                pendingTail = null;
                tail.response.end(tail.text);
              }
              await inner.waitForFunction((text: string) => document.getElementById('result')?.textContent === text, snapshotText);
              await page.waitForLoadState('load');
              // Repeated probes and the adapter's own DOM-ready signal must not
              // replay a successful restore or trigger duplicate author imports.
              await wrapper.evaluate(() => {
                const target = document.querySelector<HTMLIFrameElement>('#dashboard-frame')!.contentWindow!;
                for (let count = 0; count < 5; count++) target.postMessage({ marker: 'kts-top-dashboard-data-v1', type: 'bridge-probe' }, '*');
              });
              await inner.waitForFunction((minimum: number) => (window as unknown as { restoreTrace: RestoreTrace }).restoreTrace.probes >= minimum, fixture.streamed ? 8 : 5);
              const after = await inner.evaluate(() => ({
                ...((window as unknown as { restoreTrace: RestoreTrace }).restoreTrace),
                disabled: document.querySelector<HTMLInputElement>('input[type="file"]')!.disabled,
              }));
              assert.equal(after.nativeCalls, 1, `${label}: exactly one author import`);
              assert.equal(after.starts, 1, `${label}: exactly one restore operation`);
              assert.equal(after.changes.length, 1, label);
              assert.notEqual(after.changes[0].readyState, 'loading', label);
              assert.equal(after.changes[0].fileCount, 1, label);
              assert.equal(after.disabled, viewer, `${label}: access mode is preserved`);
              assert.equal(gets, 1, `${label}: repeated readiness does not refetch`);
              assert.deepEqual(errors, [], label);
              assert.deepEqual(blocked, [], label);
              cases++;
              console.log(`PASS ${label}`);
            } finally {
              const unfinished = pendingTail as { response: ServerResponse; text: string } | null;
              unfinished?.response.destroy();
              pendingTail = null;
              await context.close();
            }
          }
        }
      } finally { await browser.close(); }
    }
    assert.ok(engines > 0, 'At least one browser engine must be installed');
    assert.deepEqual(serverErrors, []);
    console.log(`PASS ${cases} streamed/complete restore cases across ${engines} browser engines`);
  } finally {
    const unfinished = pendingTail as { response: ServerResponse; text: string } | null;
    unfinished?.response.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
