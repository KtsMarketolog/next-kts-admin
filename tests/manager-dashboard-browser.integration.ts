/**
 * Optional browser integration; never uses real snapshots, credentials, email or production.
 * INPUT_PERSONAL_HTML=/path/to/v12.html PLAYWRIGHT_MODULE_PATH=/path/to/node_modules/playwright \
 *   node --import tsx tests/manager-dashboard-browser.integration.ts
 * The input HTML is read only, served in memory, and never copied into the repository.
 */
import assert from 'node:assert/strict';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import {
  buildPersonalDashboardFrame,
  injectPersonalDashboardAdapter,
  personalHtmlCsp,
} from '../src/shared/lib/managerDashboardHtml';
import { PERSONAL_PRIVATE_HEADERS } from '../src/shared/lib/managerDashboardSecurity';

const EMAIL = 'synthetic.manager@example.test';
const PASSWORD = 'synthetic-fixture-password-2026';
const FILENAME = 'synthetic_manager.ktsp';
const DOWNLOAD_MARKER = 'kts-top-dashboard-download-v1';
const FRAME_PATH = '/api/admin/manager-dashboard/frame';
const CONTENT_PATH = '/api/admin/manager-dashboard/content';
const SNAPSHOT_PATH = '/api/admin/manager-dashboard/snapshots';
const EMPTY_STATES = ['missing_email', 'ambiguous_email', 'no_snapshot', 'expired'] as const;
type EmptyState = typeof EMPTY_STATES[number];

// Declarations for variables in the provided browser document, used only in Playwright callbacks.
declare const D: { rows: unknown[] } | null;
declare const FILE: File | null;

function syntheticSnapshot() {
  const issued = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const expires = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const year = issued.slice(0, 4);
  const previousYear = String(Number(year) - 1);
  const rows: Array<Record<string, unknown>> = [
    { kind: 'fact', mk: `${year}-01`, dt: `${year}-01-15`, rev: 100, revV: 122, cost: 60, gp: 40, qty: 2, partner: 'Synthetic Client A', reg: 'SYNTH-1', discM: 5, dir: 'Synthetic direction', org: 'Synthetic org', nom: 'Synthetic product', tm: 'Synthetic brand', grp: 'Synthetic group' },
    { kind: 'fact', mk: `${year}-09`, dt: `${year}-09-05`, rev: 200, revV: 244, cost: 150, gp: 50, qty: 4, partner: 'Synthetic Client B', reg: 'SYNTH-2', discA: 10, dir: 'Synthetic direction', org: 'Synthetic org', nom: 'Synthetic product', tm: 'Synthetic brand', grp: 'Synthetic group' },
    { kind: 'fact', mk: `${previousYear}-09`, dt: `${previousYear}-09-05`, rev: 80, revV: 96, cost: 50, gp: 30, qty: 1, partner: 'Synthetic Client A', reg: 'SYNTH-PREV', dir: 'Synthetic direction' },
    { kind: 'lost', mk: `${year}-09`, dt: `${year}-09-06`, rev: 50, revV: 61, cost: 30, gp: 20, qty: 1, partner: 'Synthetic Client B', reason: 'Synthetic reason', dir: 'Synthetic direction' },
    { kind: 'quote', mk: `${year}-09`, dt: `${year}-09-04`, rev: 150, revV: 183, cost: 100, gp: 50, qty: 1, partner: 'Synthetic Client A', isQuote: true, qOrd: true, qSold: false, quote: 'SYNTH-QUOTE', dir: 'Synthetic direction' },
  ];
  const cols = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const payload = {
    email: EMAIL, name: 'Synthetic Manager', role: 'manager', roleLabel: 'Synthetic development manager',
    issued, expires, cols, rows: rows.map((row) => cols.map((column) => row[column] ?? null)),
    control: { [year]: 300, [previousYear]: 80 },
    plan: [{ mk: `${year}-01`, rev: 125 }, { mk: `${year}-09`, rev: 250 }],
  };
  const salt = Buffer.alloc(16, 17);
  const iv = Buffer.alloc(12, 29);
  const key = pbkdf2Sync(`${EMAIL}:${PASSWORD}`, salt, 200_000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(gzipSync(JSON.stringify(payload))), cipher.final(), cipher.getAuthTag()]);
  const envelope = {
    fmt: 'kts-personal', v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 200_000, salt: salt.toString('base64') },
    emailHash: createHash('sha256').update(EMAIL).digest('base64'),
    name: payload.name, role: payload.role, issued, expires,
    gz: true, iv: iv.toString('base64'), ct: encrypted.toString('base64'),
  };
  return { bytes: Buffer.from(JSON.stringify(envelope)), payload, year };
}

const stateExpression = `(() => {
  const totals = agg(fact('*'));
  return {
    rows: D.rows, control: controlCheck(), period: periodLabel('*'),
    totals: {rev:totals.rev, revV:totals.revV, cost:totals.cost, gp:totals.gp, qty:totals.qty,
      margin:totals.margin, docs:totals.nDocs, clients:totals.nClients, discounts:totals.discM + totals.discA},
    kpis: Array.from(document.querySelectorAll('.kpi'), (node) => node.textContent),
    rendered: document.getElementById('app').innerText,
  };
})()`;

type BrowserRoute = { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> };

async function main() {
  const inputHtml = process.env.INPUT_PERSONAL_HTML;
  if (!inputHtml) {
    console.log('SKIP browser integration: set INPUT_PERSONAL_HTML to the read-only personal v12 HTML fixture.');
    return;
  }
  const require = createRequire(path.resolve('package.json'));
  let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!modulePath) {
    try { modulePath = path.dirname(require.resolve('playwright/package.json')); }
    catch { modulePath = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const originalHtml = await readFile(inputHtml, 'utf8');
  const adaptedHtml = injectPersonalDashboardAdapter(originalHtml);
  const frame = buildPersonalDashboardFrame({ versionId: 1, snapshotId: 1, preview: false });
  const synthetic = syntheticSnapshot();
  const receivedPaths: string[] = [];
  const shell = (emptyState?: EmptyState) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#shell{width:100%;height:100%;border:0}</style></head><body><div id="parent-secret" hidden>synthetic-parent-only</div><iframe id="shell" sandbox="allow-scripts allow-same-origin" src="${FRAME_PATH}?version=1&amp;snapshot=1${emptyState ? `&amp;empty=${emptyState}` : ''}"></iframe><script>
    window.fixtureDownloads = [];
    window.fixtureMessages = [];
    window.addEventListener('message', async (event) => {
      const frame = document.getElementById('shell');
      if (event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
      const data = event.data || {};
      window.fixtureMessages.push({marker:data.marker,type:data.type,keys:Object.keys(data)});
      if (data.marker !== '${DOWNLOAD_MARKER}' || data.type !== 'download-request' || !(data.blob instanceof Blob)) return;
      const bytes = new Uint8Array(await data.blob.arrayBuffer());
      window.fixtureDownloads.push({name:data.name,size:bytes.length,type:data.blob.type,magic:Array.from(bytes.slice(0,4))});
    });
  </script></body></html>`;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const emptyState = EMPTY_STATES.find((state) => state === url.searchParams.get('empty'));
    receivedPaths.push(url.pathname);
    const headers = { ...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' };
    if (url.pathname === '/') {
      response.writeHead(200, headers).end(shell(emptyState));
    } else if (url.pathname === '/standalone') {
      response.writeHead(200, headers).end(originalHtml);
    } else if (url.pathname === FRAME_PATH) {
      // Deliberately include a snapshot ID in empty cases: emptyState must still suppress data access.
      const options = { versionId: 1, snapshotId: 1, preview: false, emptyState };
      const selectedFrame = emptyState ? buildPersonalDashboardFrame(options) : frame;
      response.writeHead(200, { ...headers, 'Content-Security-Policy': selectedFrame.csp }).end(selectedFrame.html);
    } else if (url.pathname === CONTENT_PATH) {
      response.writeHead(200, {
        ...headers, 'Content-Security-Policy': personalHtmlCsp(adaptedHtml),
        'X-DNS-Prefetch-Control': 'off', 'Referrer-Policy': 'no-referrer',
      }).end(adaptedHtml);
    } else if (url.pathname === SNAPSHOT_PATH) {
      response.writeHead(200, {
        ...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'application/octet-stream',
        'x-personal-email': encodeURIComponent(EMAIL), 'x-personal-filename': encodeURIComponent(FILENAME),
      }).end(synthetic.bytes);
    } else response.writeHead(404, PERSONAL_PRIVATE_HEADERS).end();
  });
  const failures: string[] = [];
  let enginesTested = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engineName of ['chromium', 'webkit']) {
      const engine = playwright[engineName];
      try { await access(engine.executablePath()); }
      catch { console.log(`SKIP ${engineName}: browser executable is not installed.`); continue; }
      const browser = await engine.launch({ headless: true });
      enginesTested += 1;
      const externalRequests: string[] = [];
      const scriptErrors: string[] = [];
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Europe/Moscow', acceptDownloads: false });
        await context.addInitScript(`(() => {
          window.fixtureIncomingPersonal = [];
          window.fixtureDecryptCalls = 0;
          window.addEventListener('message', (event) => {
            const data = event.data;
            if (data && data.marker === 'kts-personal-dashboard-v1') {
              window.fixtureIncomingPersonal.push({type:data.type, reason:data.reason,
                hasBytes:Object.prototype.hasOwnProperty.call(data, 'bytes')});
            }
          });
          if (crypto.subtle) {
            const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
            crypto.subtle.decrypt = function(...args) {
              window.fixtureDecryptCalls += 1;
              return decrypt(...args);
            };
          }
        })()`);
        await context.route('**/*', async (route: BrowserRoute) => {
          const url = route.request().url();
          if (new URL(url).origin === origin) await route.continue();
          else { externalRequests.push(new URL(url).origin); await route.abort(); }
        });
        for (const emptyState of EMPTY_STATES) {
          const emptyPage = await context.newPage();
          emptyPage.setDefaultTimeout(7000);
          emptyPage.on('pageerror', (error: Error) => scriptErrors.push(error.message));
          const snapshotRequestsBefore = receivedPaths.filter((pathname) => pathname === SNAPSHOT_PATH).length;
          try {
            await emptyPage.goto(`${origin}/?empty=${emptyState}`);
            await emptyPage.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#shell')?.contentDocument?.querySelector('#personal'));
            const emptyContent = emptyPage.frames().find((candidate: { url(): string }) => candidate.url().includes(CONTENT_PATH));
            assert.ok(emptyContent, `${engineName}/${emptyState}: original HTML frame exists`);
            await emptyContent.waitForFunction(() => document.querySelector<HTMLInputElement>('#pass')?.disabled === true);
            assert.equal(await emptyContent.locator('header h1').isVisible(), true, 'original dashboard title is visible without data');
            assert.equal((await emptyContent.locator('header h1').innerText()).toLocaleLowerCase('ru-RU'), 'личный дашборд продаж');
            assert.equal(await emptyContent.locator('.gate').isVisible(), true, 'original HTML gate is rendered without preview mode');
            for (const selector of ['#email', '#pass', '#fileInp', '#go']) {
              assert.equal(await emptyContent.locator(selector).isDisabled(), true, `${emptyState}: ${selector} is disabled until an assigned snapshot exists`);
            }
            assert.equal(await emptyContent.locator('#pass').inputValue(), '');
            assert.equal(await emptyContent.evaluate('FILE === null && D === null'), true, 'empty mode has neither file nor decrypted data');
            assert.equal(await emptyContent.evaluate('window.fixtureDecryptCalls'), 0, 'empty mode never invokes decryption');
            assert.deepEqual(await emptyContent.evaluate('window.fixtureIncomingPersonal'), [
              { type: 'empty', reason: emptyState, hasBytes: false },
            ], 'only an explicit empty-state message reaches the content iframe');
            const gateText = await emptyContent.locator('.gate').innerText();
            const expectedMessage: Record<EmptyState, RegExp> = {
              missing_email: /email|почт/i,
              ambiguous_email: /нескольк|неоднознач|совпад|дублир/i,
              no_snapshot: /ожида|пока|не загруж|нет|поступ|ещ[её] не/i,
              expired: /ист[её]к|просроч|срок/i,
            };
            assert.match(gateText, expectedMessage[emptyState], `${emptyState}: visible message explains why data is unavailable`);
            assert.equal(receivedPaths.filter((pathname) => pathname === SNAPSHOT_PATH).length, snapshotRequestsBefore, 'empty mode does not fetch a snapshot even when a snapshot ID was supplied');
          } finally { await emptyPage.close(); }
        }
        const standalone = await context.newPage();
        const integrated = await context.newPage();
        for (const page of [standalone, integrated]) {
          page.setDefaultTimeout(7000);
          page.on('pageerror', (error: Error) => scriptErrors.push(error.message));
        }
        await standalone.goto(`${origin}/standalone`);
        await standalone.locator('#fileInp').setInputFiles({ name: FILENAME, mimeType: 'application/json', buffer: synthetic.bytes });
        await standalone.locator('#email').fill(EMAIL);
        await standalone.locator('#pass').fill(PASSWORD);
        await standalone.locator('#go').click();
        await standalone.waitForFunction(() => D !== null && document.querySelector('.kpi'));
        const reference = await standalone.evaluate(stateExpression);
        assert.equal(reference.totals.rev, 300);
        assert.equal(reference.rows.length, synthetic.payload.rows.length);
        assert.deepEqual(reference.control, { mine: 300, ctrl: 300, ok: true });

        await integrated.goto(origin);
        await integrated.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#shell')?.contentDocument?.querySelector('#personal'));
        const content = integrated.frames().find((candidate: { url(): string }) => candidate.url().includes(CONTENT_PATH));
        assert.ok(content, `${engineName}: nested personal content frame exists`);
        await content.waitForFunction(() => typeof FILE !== 'undefined' && FILE !== null && document.querySelector<HTMLInputElement>('#email')?.readOnly);
        assert.equal(await content.locator('#email').inputValue(), EMAIL);
        assert.equal(await content.locator('#pass').inputValue(), '');
        assert.equal(await content.locator('#fileInp').isDisabled(), true);
        assert.equal(await content.evaluate('D === null'), true, 'automatic snapshot must not bypass password entry');
        await content.locator('#go').click();
        assert.match(await content.locator('#err').innerText(), /Введите email и пароль/);
        await content.locator('#pass').fill('wrong-synthetic-password');
        await content.locator('#go').click();
        await content.waitForFunction(() => document.getElementById('err')?.textContent?.includes('Пароль'));
        assert.equal(await content.evaluate('D === null'), true, 'incorrect password must not reveal data');
        await content.locator('#pass').fill(PASSWORD);
        await content.locator('#go').click();
        await content.waitForFunction(() => D !== null && document.querySelector('.kpi'));
        assert.deepEqual(await content.evaluate(stateExpression), reference, `${engineName}: initial KPI, control and rendered content match standalone v12`);

        const isolation = await content.evaluate(`(async () => {
          let parentBlocked = false, storageBlocked = false, networkBlocked = false;
          try { void parent.document.getElementById('status'); } catch { parentBlocked = true; }
          try { localStorage.setItem('synthetic-probe', 'test'); } catch { storageBlocked = true; }
          try { await fetch(${JSON.stringify(`${origin}/forbidden-network-probe`)}); } catch { networkBlocked = true; }
          return {origin:self.origin,parentBlocked,storageBlocked,networkBlocked};
        })()`);
        assert.deepEqual(isolation, { origin: 'null', parentBlocked: true, storageBlocked: true, networkBlocked: true });
        assert.equal(receivedPaths.includes('/forbidden-network-probe'), false, 'CSP prevents network probe reaching HTTP server');
        assert.equal(await integrated.locator('#shell').getAttribute('sandbox'), 'allow-scripts allow-same-origin', 'trusted wrapper stays same origin without popup permission');
        const wrapper = integrated.frames().find((candidate: { url(): string }) => candidate.url().includes(FRAME_PATH));
        assert.ok(wrapper);
        assert.equal(await wrapper.locator('#personal').getAttribute('sandbox'), 'allow-scripts');
        const pageCountBeforePopupProbe = context.pages().length;
        await content.evaluate(`(() => {
          const probe = document.createElement('button');
          probe.id = 'synthetic-popup-probe'; probe.textContent = 'Synthetic popup denial probe';
          probe.addEventListener('click', () => {
            const blank = window.open('about:blank', '_blank');
            const network = window.open(${JSON.stringify(`${origin}/forbidden-popup-probe`)}, '_blank');
            probe.dataset.blocked = String(blank === null && network === null);
          });
          document.body.append(probe);
        })()`);
        await content.locator('#synthetic-popup-probe').click();
        assert.equal(await content.locator('#synthetic-popup-probe').getAttribute('data-blocked'), 'true', 'even a real user gesture cannot open a blank or network popup');
        assert.equal(context.pages().length, pageCountBeforePopupProbe, 'popup probe creates no browser page');
        assert.equal(receivedPaths.includes('/forbidden-popup-probe'), false, 'popup probe makes no HTTP request');
        await content.locator('#synthetic-popup-probe').evaluate((node: HTMLElement) => node.remove());

        for (const page of [standalone, content]) await page.locator('label[data-set="setM"][data-v="9"]').click();
        assert.deepEqual(await content.evaluate(stateExpression), await standalone.evaluate(stateExpression), `${engineName}: month filter and calculated KPIs match`);
        assert.equal(await content.evaluate('agg(fact("*")).rev'), 200);
        for (const page of [standalone, content]) await page.locator('label[data-set="setM"][data-v="0"]').click();

        // Navigation uses dynamically rendered inline handlers in supplied v12.
        // Keep this a real user click: direct calls to render() would hide CSP integration bugs.
        for (const [index, tab] of ['summary', 'yoy', 'clients', 'goods', 'kp', 'lost', 'disc'].entries()) {
          await standalone.locator('nav button').nth(index).click();
          await content.locator('nav button').nth(index).click();
          const actualTab = await content.evaluate('U.tab');
          if (actualTab !== tab) {
            failures.push(`${engineName}: rendered v12 tab navigation did not switch to ${tab} (check dynamic inline onclick CSP).`);
            continue;
          }
          assert.deepEqual(await content.evaluate(stateExpression), await standalone.evaluate(stateExpression), `${engineName}: ${tab} navigation and calculations match standalone`);
          if (tab === 'goods' || tab === 'kp') {
            const dimension = tab === 'goods' ? 'nom' : 'partner';
            const label = tab === 'goods' ? /^Позиция$/ : /^Клиент$/;
            for (const page of [standalone, content]) await page.locator('label').filter({ hasText: label }).click();
            const actualDimension = await content.evaluate(tab === 'goods' ? 'U.goodsDim' : 'U.kpDim');
            if (actualDimension !== dimension) failures.push(`${engineName}: dynamic ${tab} dimension click failed.`);
            else assert.deepEqual(await content.evaluate(stateExpression), await standalone.evaluate(stateExpression), `${engineName}: ${tab} dimension matches standalone`);
            if (tab === 'goods') {
              for (const page of [standalone, content]) {
                await page.locator('.ms[data-ms="tm"] .ms-b').click();
                await page.locator('input[data-msk="tm"]').first().check();
                await page.locator('.gfbar a.lnk').click();
              }
              assert.equal(await content.evaluate('U.gf.tm.length'), 0, 'goods reset clears its selected filters');
              assert.deepEqual(await content.evaluate(stateExpression), await standalone.evaluate(stateExpression), `${engineName}: goods filter/reset matches standalone`);
            }
          }
        }
        for (const page of [standalone, content]) {
          await page.locator('label[data-set="setM"][data-v="9"]').click();
          await page.locator('.pbar a.reset').click();
        }
        assert.equal(await content.evaluate('U.ms.length'), 0, 'global reset clears its selected period');
        assert.deepEqual(await content.evaluate(stateExpression), await standalone.evaluate(stateExpression), `${engineName}: global reset matches standalone`);
        // Restore the synthetic fixture after the independent navigation assertion, then test the export bridge.
        await content.evaluate('U.tab="summary"; U.ms=[]; render()');
        await content.locator('a[data-xls]').first().click();
        await integrated.waitForFunction(() => 'fixtureDownloads' in window && Array.isArray(window.fixtureDownloads) && window.fixtureDownloads.length > 0);
        const exported = await integrated.evaluate('window.fixtureDownloads[0]');
        assert.match(exported.name, /\.xlsx$/);
        assert.ok(exported.size > 100);
        assert.deepEqual(exported.magic, [0x50, 0x4b, 3, 4]);
        assert.equal(exported.type, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        const messages = await integrated.evaluate('window.fixtureMessages');
        assert.ok(messages.every((entry: { keys: string[] }) => !entry.keys.some((key) => /password|plaintext|payload|rows/i.test(key))));
        assert.deepEqual(externalRequests, [], 'original and integrated fixtures make no external requests');
        assert.deepEqual(scriptErrors, [], 'both original and integrated v12 execute without script errors');
        console.log(`PASS ${engineName}: four HTML-only empty states without data fetch/decrypt; standalone parity, encrypted delivery/password, KPI/control, all tabs, month/goods/KP filters and resets, opaque sandbox, network/popup denial and gesture XLSX bridge.`);
      } catch (error) {
        failures.push(`${engineName}: ${error instanceof Error ? error.message : String(error)}`);
      } finally { await browser.close(); }
    }
    assert.ok(enginesTested > 0, 'At least one installed browser engine must run.');
    if (failures.length) throw new Error(failures.join('\n'));
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
