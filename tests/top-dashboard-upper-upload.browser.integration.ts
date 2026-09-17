/**
 * Isolated acceptance test for the real TOP iframe adapter + management bridge.
 * node --import tsx tests/top-dashboard-upper-upload.browser.integration.ts
 * Uses synthetic reports/data only. All non-local requests are blocked.
 */
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildTopDashboardContentSecurityPolicy,
  buildTopDashboardFrameSecurityPolicy,
  createTopDashboardFrameBridgeScript,
  injectTopDashboardDataAdapter,
} from '../src/shared/lib/topDashboardContentSecurity';
import { decodeTopDashboardMultiFileSnapshot } from '../src/shared/lib/topDashboardMultiFileSnapshot';

const managementMarker = 'kts-top-dashboard-management-v1';
const dataPath = '/api/admin/top-dashboard/blocks/7/data';
const framePath = '/api/admin/top-dashboard/blocks/7/versions/51/frame';
const contentPath = '/api/admin/top-dashboard/blocks/7/versions/51/content';
type Target = { id: string | null; name: string | null; index: number };
type SelectedFile = { name: string; type: string; lastModified: number; webkitRelativePath: string; text: string };
type Selection = { target: Target; files: SelectedFile[] };
type Message = { type: string; requestId?: string; ok?: boolean; targets?: Array<{target: Target; multiple: boolean; directory: boolean}> };
type Fixture = { name: string; markup: string; dynamic?: boolean; count: number; directory?: boolean };
const fixtures: Fixture[] = [
  { name: 'static-multiple', markup: '<label for="source">Продажи и остатки</label><input id="source" name="sources" type="file" multiple accept=".json,.json.gz">', count: 1 },
  { name: 'multiple-targets', markup: '<input id="sales" type="file" accept=".json"><input id="stock" type="file" accept=".json">', count: 2 },
  { name: 'directory', markup: '<input id="folder" type="file" webkitdirectory multiple>', count: 1, directory: true },
  { name: 'dynamic', markup: '', dynamic: true, count: 1 },
];

function reportHtml(fixture: Fixture) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${fixture.markup}<pre id="received">{}</pre><script>
const received = {}; let restore = null;
window.addEventListener('kts-top-dashboard-restore-start', e => {restore=e.detail;});
document.addEventListener('change', async e => {
  if (!(e.target instanceof HTMLInputElement) || e.target.type !== 'file') return;
  received[e.target.id] = await Promise.all(Array.from(e.target.files).map(async f => ({name:f.name,type:f.type,lastModified:f.lastModified,webkitRelativePath:f.webkitRelativePath,text:await f.text()})));
  document.getElementById('received').textContent = JSON.stringify(received);
  if (restore && Object.values(received).reduce((n, files) => n + files.length, 0) === restore.fileCount) {
    window.dispatchEvent(new CustomEvent('kts-top-dashboard-data-ready', {detail:{restoreId:restore.restoreId}}));
  }
});
${fixture.dynamic ? "setTimeout(() => {const input = document.createElement('input'); input.type='file';input.id='runtime';input.multiple=true;input.accept='.json';document.body.appendChild(input);},100);" : ''}
</script></body></html>`;
}

async function main() {
  const modulePath = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  let fixture = fixtures[0];
  let stored: Buffer | null = null;
  let activeVersion: number | null = null;
  let puts = 0;
  let gets = 0;
  let conflict = false;
  const requestErrors: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const viewer = url.searchParams.has('viewer');
      const common = {'Cache-Control': 'no-store'};
      if (url.pathname === '/') {
        response.writeHead(200, {...common, 'Content-Type': 'text/html; charset=utf-8'}).end(`<!doctype html><html><body><iframe id="outer" style="width:100%;height:700px" sandbox="allow-scripts allow-same-origin" src="${framePath}${viewer ? '?viewer=1' : ''}"></iframe><script>
window.__messages=[];window.addEventListener('message',e=>{if(e.source===document.getElementById('outer').contentWindow&&e.origin===location.origin&&e.data?.marker==='${managementMarker}')window.__messages.push(e.data);});
</script></body></html>`);
      } else if (url.pathname === framePath) {
        const script = createTopDashboardFrameBridgeScript(7, 51, !viewer);
        response.writeHead(200, {...common, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': buildTopDashboardFrameSecurityPolicy(script)}).end(`<!doctype html><html><body><iframe id="dashboard-frame" style="width:100%;height:650px" sandbox="allow-scripts allow-popups" src="${contentPath}${viewer ? '?viewer=1' : ''}"></iframe><div id="data-notice" hidden></div><script>${script}</script></body></html>`);
      } else if (url.pathname === contentPath) {
        const html = injectTopDashboardDataAdapter(reportHtml(fixture), {readOnly: viewer});
        response.writeHead(200, {...common, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': buildTopDashboardContentSecurityPolicy(html)}).end(html);
      } else if (url.pathname === dataPath && request.method === 'GET') {
        gets += 1;
        if (!stored) response.writeHead(404, common).end();
        else response.writeHead(200, {...common, 'Content-Type': 'application/octet-stream',
          'X-Top-Dashboard-Data-Version-Id': String(activeVersion),
          'X-Top-Dashboard-Data-Snapshot-Format': 'multi-file-v1',
          'X-Top-Dashboard-Data-Profile': 'generic',
          'X-Top-Dashboard-Data-Bound-Html-Version-Id': '51',
        }).end(stored);
      } else if (url.pathname === dataPath && request.method === 'PUT') {
        puts += 1;
        assert.equal(request.headers['x-kts-top-html-version'], '51');
        assert.equal(request.headers['x-kts-top-data-protocol'], 'stream-v1');
        assert.equal(request.headers['x-kts-top-dashboard-multi-file'], '1');
        assert.equal(request.headers['x-kts-top-data-expected-version'], activeVersion === null ? 'none' : String(activeVersion));
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        decodeTopDashboardMultiFileSnapshot(bytes);
        if (conflict) response.writeHead(409, {'Content-Type': 'application/json'}).end(JSON.stringify({error: 'Synthetic concurrent update'}));
        else {
          stored = bytes;
          activeVersion = (activeVersion ?? 100) + 1;
          response.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({state: {activeVersionId: activeVersion}}));
        }
      } else response.writeHead(404, common).end();
    } catch (error) {
      requestErrors.push(String(error));
      response.writeHead(500).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  let engines = 0;
  try {
    for (const engineName of ['chromium', 'webkit']) {
      const engine = playwright[engineName];
      try { await access(engine.executablePath()); } catch { console.log(`SKIP ${engineName}: executable unavailable`); continue; }
      engines += 1;
      const browser = await engine.launch({headless: true});
      try {
        for (const currentFixture of fixtures) {
          fixture = currentFixture;
          stored = null; activeVersion = null; puts = 0; gets = 0; conflict = false;
          const context = await browser.newContext();
          const page = await context.newPage();
          const errors: string[] = [];
          const warnings: string[] = [];
          const blocked: string[] = [];
          page.on('pageerror', (error: Error) => errors.push(error.message));
          page.on('console', (message: {type(): string; text(): string}) => {
            if (message.type() === 'error') warnings.push(message.text());
          });
          await context.route('**/*', async (route: {request(): {url(): string}; continue(): Promise<void>; abort(): Promise<void>}) => {
            const url = new URL(route.request().url());
            if (url.origin === origin) return route.continue();
            blocked.push(url.href); return route.abort();
          });
          const send = async (type: string, extra: Record<string, unknown> = {}) => page.evaluate(
            ({type, extra, marker}: {type: string; extra: Record<string, unknown>; marker: string}) => {
              document.querySelector<HTMLIFrameElement>('#outer')!.contentWindow!.postMessage({marker, type, blockId: 7, htmlVersionId: 51, ...extra}, location.origin);
            }, {type, extra, marker: managementMarker},
          );
          const targets = async () => {
            await send('probe-upload-targets');
            await page.waitForFunction((count: number) => (window as unknown as {__messages: Message[]}).__messages.some(m => m.type === 'upload-targets' && m.targets?.length === count), fixture.count).catch(async (error: unknown) => {
              console.error({engineName, fixture: fixture.name, errors, warnings, gets, puts, messages: await page.evaluate(() => (window as unknown as {__messages: Message[]}).__messages)});
              for (const frame of page.frames()) console.error(await frame.evaluate(() => ({url: location.href, text: document.body?.innerText, inputs: document.querySelectorAll('input[type="file"]').length})));
              throw error;
            });
            return page.evaluate(() => (window as unknown as {__messages: Message[]}).__messages.filter(m => m.type === 'upload-targets' && m.targets?.length).at(-1)!.targets!) as Promise<NonNullable<Message['targets']>>;
          };
          const upload = async (requestId: string, selected: Selection[], expected = activeVersion) => {
            await page.evaluate(({requestId, selected, expected, marker}: {requestId: string; selected: Selection[]; expected: number | null; marker: string}) => {
              const targets = selected.map(entry => ({target: entry.target, files: entry.files.map(({text, ...metadata}) => ({...metadata, blob: new Blob([text], {type: metadata.type})}))}));
              document.querySelector<HTMLIFrameElement>('#outer')!.contentWindow!.postMessage({marker, type: 'upload-files', blockId: 7, htmlVersionId: 51, requestId, expectedActiveDataVersionId: expected, targets}, location.origin);
            }, {requestId, selected, expected, marker: managementMarker});
            await page.waitForFunction((id: string) => (window as unknown as {__messages: Message[]}).__messages.some(m => m.type === 'upload-result' && m.requestId === id), requestId);
            return page.evaluate((id: string) => (window as unknown as {__messages: Message[]}).__messages.find(m => m.type === 'upload-result' && m.requestId === id), requestId) as Promise<Message>;
          };
          const checkStored = (selected: Selection[]) => {
            assert.ok(stored);
            const decoded = decodeTopDashboardMultiFileSnapshot(stored);
            assert.deepEqual(decoded.targets.map(entry => ({target: entry.target, files: entry.files.map(({bytes, ...metadata}) => ({...metadata, text: Buffer.from(bytes).toString('utf8')}))})), selected);
          };
          const checkRestored = async (selected: Selection[]) => {
            const report = page.frameLocator('#outer').frameLocator('#dashboard-frame');
            const expected = Object.fromEntries(selected.map(entry => [entry.target.id, entry.files]));
            await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#outer')?.contentDocument?.querySelector('#data-notice')?.getAttribute('data-kind') === 'success');
            assert.deepEqual(JSON.parse(await report.locator('#received').innerText()), expected, 'Report change callbacks receive every file and directory path after reload');
          };
          await page.goto(origin);
          const descriptors = await targets();
          assert.ok(gets > 0);
          assert.equal(descriptors[0].directory, !!fixture.directory);
          const selected: Selection[] = descriptors.map((descriptor, index) => ({
            target: descriptor.target,
            files: [{name: `${index}-snapshot.json`, type: 'application/json', lastModified: 1788888888888, webkitRelativePath: fixture.directory ? `snapshots/${index}-snapshot.json` : '', text: JSON.stringify({sum: index + 1, source: fixture.name})}],
          }));
          assert.equal((await upload('invalid-target', [{...selected[0], target: {...selected[0].target, index: 30}}])).ok, false);
          assert.equal((await upload('stale-version', selected, 999)).ok, false);
          assert.equal(puts, 0, 'Invalid selections do not reach storage');
          await send('upload-files', {htmlVersionId: 999, requestId: 'wrong-html', expectedActiveDataVersionId: null, targets: []});
          await page.waitForTimeout(100);
          assert.equal(puts, 0);
          assert.equal((await upload('first', selected)).ok, true);
          checkStored(selected);
          const firstStored = Buffer.from(stored!);
          conflict = true;
          assert.equal((await upload('server-conflict', selected)).ok, false);
          assert.deepEqual(stored, firstStored, 'A failed compare-and-swap preserves existing data');
          conflict = false;
          await page.reload();
          await targets();
          await checkRestored(selected);
          if (fixture.name === 'static-multiple') {
            selected[0].files.push({name: 'stock.json.gz', type: 'application/gzip', lastModified: 1, webkitRelativePath: '', text: 'synthetic opaque gzip bytes'});
            assert.equal((await upload('second', selected)).ok, true);
            checkStored(selected);
            await page.reload(); await targets(); await checkRestored(selected);
          }
          const putsBeforeViewer = puts;
          await page.goto(origin + '/?viewer=1');
          await checkRestored(selected);
          await send('probe-upload-targets');
          await send('upload-files', {requestId: 'viewer', expectedActiveDataVersionId: activeVersion, targets: []});
          await page.waitForTimeout(200);
          assert.equal(puts, putsBeforeViewer, 'Read-only viewers cannot upload');
          assert.equal(await page.evaluate(() => (window as unknown as {__messages: Message[]}).__messages.length), 0, 'Management protocol is silent for viewers');
          assert.deepEqual(errors, []);
          assert.deepEqual(blocked, []);
          assert.deepEqual(requestErrors, []);
          console.log(JSON.stringify({engine: engineName, fixture: fixture.name, targets: descriptors.length, puts, result: 'pass'}));
          await context.close();
        }
      } finally { await browser.close(); }
    }
    assert.ok(engines > 0, 'At least one browser engine is required');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

main().catch(error => {console.error(error);process.exitCode = 1;});
