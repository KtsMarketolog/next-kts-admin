/**
 * Real-browser acceptance for the reviewed currency HTML and its opaque-origin RPC.
 * Run: node --import tsx tests/currency-dashboard.browser.integration.ts
 * Uses synthetic data and an in-memory CAS fixture, not PostgreSQL or production.
 * No external requests are allowed. Screenshots go to a new /private/tmp directory.
 */
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';

import { renderCurrencyDashboardHtml, buildCurrencyDashboardContentSecurityPolicy } from '../src/shared/lib/currencyDashboardHtml';
import { readCurrencyRpcRequest } from '../src/shared/lib/currencyDashboardRpc';
import { validateCurrencySnapshot, type CurrencySnapshotState } from '../src/shared/lib/currencyDashboardModel';

const fixtureAt = '2026-09-30T09:00:00.000Z';
const nonce = '6a9aeac1-42cd-4212-9562-8fa520432d43';
const attack = '<img id="injected" src="https://blocked.example.test/x" onerror="window.__unsafe=true">';
const manual = validateCurrencySnapshot({
  at: fixtureAt, version: 'V21', data: {
    kts_cpsRates: { eur: 123.45, cny: 12.5, usd: 90, from: '2026-01-01', to: '2026-12-31' },
    kts_an: { upd: '30.09.2026', rows: ['Fixture Analyst & Co | 90–95 | 12.5 | конец 2026 | 30.09.2026'] },
    kts_cu: { prem: 240, rows: [{ date: '2026-01-13', price: 9500 }], lmci: null, lmciDate: null },
    kts_log: [{ t: fixtureAt, msg: 'Fixture common manual data', risk: false }],
  },
});
const initialState = (): CurrencySnapshotState => ({
  revision: 1, current: { ...structuredClone(manual), savedAt: fixtureAt, actor: 'admin:fixture' }, previous: null,
});
const historicalRates = {
  '2026-01-01': { USD: [91, 1], EUR: [100, 1], CNY: [12, 1], KZT: [18, 100] },
  '2026-01-13': { USD: [92, 1], EUR: [101, 1], CNY: [12.1, 1], KZT: [18.1, 100] },
  '2026-01-30': { USD: [93, 1], EUR: [102, 1], CNY: [12.2, 1], KZT: [18.2, 100] },
  '2026-09-01': { USD: [89, 1], EUR: [98, 1], CNY: [12.3, 1], KZT: [18.3, 100] },
  '2026-09-29': { USD: [90, 1], EUR: [99, 1], CNY: [12.4, 1], KZT: [18.4, 100] },
};
const baseline = (date: string, secid: string, price: number) => ({
  price, time: '08:30', src: 'fixture MOEX', secid,
  capturedAt: `${date}T05:30:00.000Z`, quoteAt: `${date}T05:20:00.000Z`, stale: false,
  ...(secid.startsWith('CE') ? { premium: 240 } : {}),
});
const baselines = {
  '2026-01-13': { COPPER: baseline('2026-01-13', 'CEH6', 9500), BR: baseline('2026-01-13', 'BRH6', 65) },
  '2026-09-30': { COPPER: baseline('2026-09-30', 'CEZ6', 10000), BR: baseline('2026-09-30', 'BRZ6', 70) },
};

function source(kind: unknown, params: Record<string, unknown>, stale: boolean) {
  let value: Record<string, unknown>;
  switch (kind) {
    case 'cbr-daily': value = {
      Date: '2026-09-30T00:00:00+03:00', Valute: Object.fromEntries([
        ['USD', 91, 1, 90], ['EUR', 100, 1, 99], ['CNY', 12.5, 1, 12.4], ['KZT', 18.5, 100, 18.4],
      ].map(([code, current, nominal, previous]) => [code, { CharCode: code, Name: code, Value: current, Nominal: nominal, Previous: previous }])),
    }; break;
    case 'cbr-history': value = { data: historicalRates }; break;
    case 'moex-currency': value = { marketdata: {
      columns: ['SECID', 'LAST', 'LASTTOPREVPRICE', 'UPDATETIME'],
      data: [['CNYRUB_TOM', 12.55, 0.5, '12:00:00'], ['KZTRUB_TOM', 18.6, 0.4, '12:00:00']],
    } }; break;
    case 'moex-futures': value = {
      securities: { columns: ['SECID', 'SHORTNAME', 'ASSETCODE', 'LASTTRADEDATE', 'PREVSETTLEPRICE', 'CURRENCYID'], data: [
        ['CEZ6', 'Copper', 'COPPER', '2026-12-20', 10000, 'USD'], ['BRZ6', 'Brent', 'BR', '2026-12-01', 70, 'USD'],
      ] },
      marketdata: { columns: ['SECID', 'LAST', 'LASTTOPREVPRICE', 'UPDATETIME', 'VOLTODAY', 'OPEN'], data: [
        ['CEZ6', 10100, 1, '12:00:00', 100, 10000], ['BRZ6', 71, 1, '12:00:00', 200, 70],
      ] },
    }; break;
    case 'moex-candles': {
      const january = String(params.from).startsWith('2026-01');
      const date = january ? '2026-01-13' : '2026-09-30';
      const price = String(params.secid).startsWith('CE') ? 10050 : String(params.secid).startsWith('BR') ? 70.5 : 12.5;
      value = { candles: { columns: ['begin', 'end', 'open', 'close', 'high', 'low'], data: [
        [`${date} 12:00:00`, `${date} 12:59:59`, price - 0.1, price, price + 0.1, price - 0.2],
      ] } }; break;
    }
    case 'world': value = { result: 'success', base_code: 'USD', time_last_update_unix: Date.parse(fixtureAt) / 1000,
      rates: { USD: 1, RUB: 91, EUR: 0.91, CNY: 7.2, KZT: 490, KGS: 87, AED: 3.67, TRY: 40 } }; break;
    case 'copper': value = { rows: [24, 25, 28, 29, 30].map((day, index) => ({ date: `2026-09-${day}`, cash: 9800 + index * 10, m3: 9900 + index * 10 })), fetched_at: fixtureAt, source: 'fixture Westmetall' }; break;
    default: throw new Error(`Unknown synthetic source: ${String(kind)}`);
  }
  return { ...value, _currencySource: { fetchedAt: fixtureAt, stale, ...(stale ? { error: 'Источник временно недоступен; показана сохранённая копия.' } : {}), delayMinutes: String(kind).startsWith('moex') ? 15 : 0 } };
}

async function main() {
  console.log('currency browser: loading browser runtime');
  const modulePath = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  console.log('currency browser: creating local fixture');
  // Read the actual host attribute so a permissive fixture cannot conceal production drift.
  const host = await readFile(path.join(process.cwd(), 'src/features/admin/currency-dashboard/CurrencyDashboard.tsx'), 'utf8');
  const frameSandbox = host.match(/sandbox="([^"]+)"/)?.[1];
  assert.ok(frameSandbox, 'Host has an explicit sandbox attribute');
  assert.ok(frameSandbox.split(' ').includes('allow-forms'), 'Host sandbox must permit handled submit events');
  assert.equal(frameSandbox.split(' ').includes('allow-same-origin'), false, 'Host must preserve opaque-origin isolation');
  const output = await mkdtemp('/private/tmp/kts-currency-browser-');
  let envelope = initialState(), staleSources = false, saveRequests = 0, successfulWrites = 0;
  const methods: string[] = [], serverErrors: string[] = [];
  let origin = '';
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const common = { 'Cache-Control': 'no-store' };
      if (url.pathname === '/') {
        const unsafe = url.searchParams.has('unsafe');
        const viewer = url.searchParams.has('viewer');
        response.writeHead(200, { ...common, 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'fixture-auth=secret; SameSite=Strict' }).end(`<!doctype html><html><body style="margin:0">
<iframe id="report" sandbox="${frameSandbox}" style="width:100%;height:1100px;border:0" src="/frame${viewer ? '?viewer=1' : ''}"></iframe><script>
const channel='kts-currency-v1',nonce=${JSON.stringify(nonce)},frame=document.getElementById('report');
window.addEventListener('message',async event=>{
const m=event.data;if(event.source!==frame.contentWindow||event.origin!=='null'||m?.channel!==channel||m.nonce!==nonce||typeof m.id!=='string'||! /^[a-zA-Z0-9:_-]{1,100}$/.test(m.id))return;
try{const response=await fetch('/rpc',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-fixture-unsafe':${JSON.stringify(unsafe ? '1' : '0')}},body:JSON.stringify({method:m.method,params:m.params})});
const body=await response.json();frame.contentWindow.postMessage({channel,nonce,id:m.id,...(response.ok?{result:body}:{error:{message:body.error,status:response.status,code:body.code}})},'*');}
catch(error){frame.contentWindow.postMessage({channel,nonce,id:m.id,error:{message:error.message,status:500}},'*');}});
</script></body></html>`);
      } else if (url.pathname === '/frame') {
        const html = renderCurrencyDashboardHtml(nonce, origin, !url.searchParams.has('viewer'));
        response.writeHead(200, { ...common, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': buildCurrencyDashboardContentSecurityPolicy(html) }).end(html);
      } else if (url.pathname === '/rpc' && request.method === 'POST') {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw new Error('Fixture request too large'); chunks.push(chunk); }
        const { method, params } = await readCurrencyRpcRequest(new Request(origin + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) }));
        methods.push(method);
        let result: unknown;
        if (method === 'snapshot:get') {
          result = structuredClone(envelope);
          // Defense in depth: malformed read fixture bypasses the real write validator deliberately.
          if (request.headers['x-fixture-unsafe'] === '1') {
            const unsafe = result as CurrencySnapshotState;
            unsafe.current!.data.kts_an = { upd: '30.09.2026', rows: [`${attack} | 90 | 12 | 2026 | 30.09.2026`] };
            unsafe.current!.data.kts_log = [{ t: fixtureAt, msg: attack, risk: false }];
          }
        } else if (method === 'snapshot:save' || method === 'snapshot:rollback') {
          if (method === 'snapshot:save') saveRequests += 1;
          if (params.expectedRevision !== envelope.revision) {
            response.writeHead(409, { ...common, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Другой администратор изменил данные', code: 'CURRENCY_CONFLICT', revision: envelope.revision })); return;
          }
          const snapshot = method === 'snapshot:save' ? validateCurrencySnapshot(params.snapshot) : envelope.previous;
          assert.ok(snapshot, 'Rollback has a previous snapshot');
          const previous = envelope.current;
          envelope = { revision: envelope.revision + 1, current: { ...structuredClone(snapshot), at: fixtureAt, savedAt: fixtureAt, actor: 'admintop:fixture' }, previous };
          successfulWrites += 1; result = envelope;
        } else if (method === 'baselines:get') result = baselines;
        else if (method === 'source') result = source(params.kind, params, staleSources);
        response.writeHead(200, { ...common, 'Content-Type': 'application/json' }).end(JSON.stringify(result));
      } else response.writeHead(404, common).end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      serverErrors.push(message);
      response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
  let engines = 0;
  try {
    for (const engineName of ['chromium', 'webkit']) {
      const engine = playwright[engineName];
      try { await access(engine.executablePath()); } catch { console.log(`SKIP ${engineName}: executable unavailable`); continue; }
      engines += 1;
      envelope = initialState(); staleSources = false; saveRequests = 0; successfulWrites = 0;
      methods.length = 0; serverErrors.length = 0;
      const browser = await engine.launch({ headless: true });
      const blocked: string[] = [], errors: string[] = [], warnings: string[] = [];
      const createPage = async (suffix = '') => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: 'Europe/Moscow', acceptDownloads: true });
        await context.route('**/*', async (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => {
          const url = new URL(route.request().url());
          if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
          blocked.push(url.href); return route.abort();
        });
        const page = await context.newPage();
        page.on('pageerror', (error: Error) => errors.push(error.message));
        page.on('console', (message: { type(): string; text(): string }) => { if (message.type() === 'error') warnings.push(message.text().slice(0, 350)); });
        page.on('dialog', (dialog: { accept(): Promise<void> }) => dialog.accept());
        await page.clock.setFixedTime(new Date(fixtureAt));
        await page.goto(origin + suffix);
        const report = page.frameLocator('#report');
        const frame = page.frames().find((item: { url(): string }) => new URL(item.url()).pathname === '/frame');
        assert.ok(frame);
        try {
          await frame.waitForFunction(() => document.querySelector('#saveStatus')?.textContent?.includes('ревизия'));
          await frame.waitForFunction(() => document.querySelector('#sourceStatus')?.textContent?.includes('LME Cash Settlement') && !document.querySelector('#cuLive')?.textContent?.includes('Загрузка'));
        } catch (error) { console.error(JSON.stringify({ engine: engineName, errors, warnings, serverErrors, methods })); throw error; }
        return { context, page, report, frame };
      };
      try {
        const first = await createPage(), second = await createPage();
        const openForm = async (item: typeof first, id: string) => {
          const details = item.report.locator('details').filter({ has: item.report.locator(`#${id}`) });
          if (!(await details.getAttribute('open'))) await details.locator('summary').click();
        };
        for (const item of [first, second]) {
          assert.match(await item.report.locator('#cpsRates').innerText(), /123,45/);
          assert.match(await item.report.locator('#an').innerText(), /Fixture Analyst & Co/);
          assert.match(await item.report.locator('#saveStatus').innerText(), /ревизия 1/);
          assert.equal(await item.report.locator('#rollbackShared').isDisabled(), true);
        }
        assert.equal(saveRequests, 0, 'Initial source refreshes must never write a manual snapshot');
        await first.page.screenshot({ path: path.join(output, `${engineName}-main.png`) });

        await openForm(first, 'cpsForm');
        for (const invalid of ['-100', 'abc123']) {
          await first.report.locator('#cpsForm [name="eur"]').fill(invalid);
          await first.report.locator('#cpsForm button[type="submit"]').click();
          await first.frame.waitForFunction(() => document.querySelector('#saveStatus')?.textContent?.includes('Не удалось сохранить'));
          assert.equal(saveRequests, 0, `Invalid ${invalid} is rejected before snapshot:save`);
        }
        await first.report.locator('#cpsForm [name="eur"]').fill('125,50');
        await first.report.locator('#cpsForm button[type="submit"]').click();
        await first.frame.waitForFunction(() => document.querySelector('#saveStatus')?.textContent?.includes('ревизия 2'));
        assert.equal(envelope.current?.data.kts_cpsRates?.eur, 125.5);
        assert.equal(envelope.previous?.data.kts_cpsRates?.eur, 123.45);
        assert.equal(saveRequests, 1); assert.equal(successfulWrites, 1);

        await openForm(second, 'cpsForm');
        await second.report.locator('#cpsForm [name="eur"]').fill('130');
        await second.report.locator('#cpsForm button[type="submit"]').click();
        await second.frame.waitForFunction(() => document.querySelector('#saveStatus')?.textContent?.includes('Другой администратор'));
        assert.equal(await second.report.locator('#cpsForm [name="eur"]').inputValue(), '130', 'CAS rejection preserves the draft');
        assert.equal(envelope.revision, 2); assert.equal(successfulWrites, 1);
        await second.report.locator('#reloadShared').click();
        await second.frame.waitForFunction(() => document.querySelector('#saveStatus')?.textContent?.includes('ревизия 2'));
        assert.match(await second.report.locator('#cpsRates').innerText(), /125,50/);
        await second.report.locator('#rollbackShared').click();
        await second.frame.waitForFunction(() => document.querySelector('#saveStatus')?.textContent?.includes('ревизия 3'));
        assert.equal(envelope.current?.data.kts_cpsRates?.eur, 123.45);
        assert.equal(envelope.previous?.data.kts_cpsRates?.eur, 125.5);
        assert.equal(successfulWrites, 2);

        await second.report.locator('[data-page="pgSum"]').click();
        await second.report.locator('#summaryMonth').fill('2026-01');
        await second.report.locator('#summaryMonth').dispatchEvent('change');
        await second.frame.waitForFunction(() => document.querySelector('#sumCnt')?.textContent?.includes('2026-01'));
        const januaryDates = await second.report.locator('#sumTable tr td:first-child').allTextContents();
        assert.deepEqual(januaryDates, ['30.01.2026', '13.01.2026', '01.01.2026'], 'Historical January observations remain accessible, without inventing missing days');
        for (const format of ['Csv', 'Xlsx']) {
          const downloadEvent = second.page.waitForEvent('download');
          await second.report.locator(`#btn${format}`).click();
          const download = await downloadEvent, filename = download.suggestedFilename();
          assert.ok(filename.includes('2026-01'));
          const file = await download.path(); assert.ok(file);
          const bytes = await readFile(file);
          if (format === 'Csv') {
            const csv = bytes.toString('utf8');
            assert.ok(csv.includes('30.01.2026') && csv.includes('13.01.2026') && csv.includes('01.01.2026'));
            assert.equal(csv.includes('.09.2026'), false, 'CSV is restricted to the selected month');
          } else {
            assert.equal(bytes.subarray(0, 2).toString(), 'PK');
            const workbook = XLSX.read(bytes, { type: 'buffer' });
            const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
            assert.deepEqual(rows.slice(1, 4).map(row => row[0]), januaryDates);
            assert.equal(JSON.stringify(rows).includes('.09.2026'), false, 'Excel is restricted to the selected month');
          }
        }
        await second.page.screenshot({ path: path.join(output, `${engineName}-january.png`) });

        const viewer = await createPage('/?viewer=1');
        assert.equal(await viewer.report.locator('#readOnlyStatus').isVisible(), true);
        assert.match(await viewer.report.locator('#cpsRates').innerText(), /123,45/);
        for (const selector of ['#cpsForm input', '#cpsForm button', '#anForm textarea', '#anForm button', '#cuForm input', '#cuForm button', '#tOpen', '#snapFile', '#rollbackShared']) {
          const controls = viewer.report.locator(selector);
          for (let index = 0; index < await controls.count(); index += 1) assert.equal(await controls.nth(index).isDisabled(), true, selector);
        }
        assert.equal(await viewer.report.locator('#reloadShared').isEnabled(), true);
        assert.equal(await viewer.report.locator('#tSnap').isEnabled(), true);
        const viewerMethodsStart = methods.length;
        const deniedWrites = await viewer.frame.evaluate(async () => {
          const api = window as unknown as {
            rpc(method: string): Promise<unknown>;
            saveSharedPatch(patch: unknown, message: string, replace: boolean): Promise<unknown>;
            setSharedBusy(busy: boolean): void;
          };
          const denied: string[] = [];
          for (const action of [() => api.rpc('snapshot:save'), () => api.rpc('snapshot:rollback'), () => api.saveSharedPatch({}, 'Импорт', true)]) {
            try { await action(); denied.push('unexpected success'); } catch (error) { denied.push((error as { code: string }).code); }
          }
          api.setSharedBusy(true); api.setSharedBusy(false);
          return denied;
        });
        assert.deepEqual(deniedWrites, ['CURRENCY_READ_ONLY', 'CURRENCY_READ_ONLY', 'CURRENCY_READ_ONLY']);
        assert.equal(methods.slice(viewerMethodsStart).some(method => ['snapshot:save', 'snapshot:rollback'].includes(method)), false);
        assert.equal(await viewer.report.locator('#rollbackShared').isDisabled(), true, 'Busy cycles must not enable viewer mutations');
        assert.equal(await viewer.report.locator('#tOpen').isDisabled(), true);
        await viewer.report.locator('#reloadShared').click();
        await viewer.report.locator('[data-page="pgSum"]').click();
        await viewer.report.locator('#summaryMonth').fill('2026-01');
        await viewer.report.locator('#summaryMonth').dispatchEvent('change');
        assert.deepEqual(await viewer.report.locator('#sumTable tr td:first-child').allTextContents(), januaryDates);
        const viewerDownloadEvent = viewer.page.waitForEvent('download');
        await viewer.report.locator('#btnCsv').click();
        assert.ok((await viewerDownloadEvent).suggestedFilename().includes('2026-01'), 'Viewer retains calendar and export access');
        await viewer.page.screenshot({ path: path.join(output, `${engineName}-viewer.png`) });
        assert.equal(successfulWrites, 2, 'Viewer actions never change shared data');

        const quotes = await second.report.locator('#moex td').allTextContents();
        staleSources = true;
        const stale = await createPage();
        assert.deepEqual(await stale.report.locator('#moex td').allTextContents(), quotes, 'Stale sources retain the last successful quotes');
        assert.match(await stale.report.locator('#errBox').innerText(), /Не все данные актуальны/);
        assert.match(await stale.report.locator('#sourceStatus').innerText(), /сохранённая копия/);
        assert.equal(successfulWrites, 2, 'Reloads and stale market sources never replace manual snapshots');
        staleSources = false;

        const escaped = await createPage('/?unsafe=1');
        assert.ok((await escaped.report.locator('#an').innerText()).includes(attack));
        assert.ok((await escaped.report.locator('#log').innerText()).includes(attack));
        assert.equal(await escaped.report.locator('#injected').count(), 0, 'Untrusted strings render as text, not HTML');
        assert.equal(await escaped.frame.evaluate(() => Boolean((window as unknown as { __unsafe?: boolean }).__unsafe)), false);
        const isolation = await first.frame.evaluate(async () => {
          let parentBlocked = false, cookiesBlocked = false, storageBlocked = false, fetchBlocked = false, externalFetchBlocked = false;
          try { void window.parent.document.body; } catch { parentBlocked = true; }
          try { void document.cookie; } catch { cookiesBlocked = true; }
          try { void localStorage.length; } catch { storageBlocked = true; }
          try { await fetch('/rpc'); } catch { fetchBlocked = true; }
          try { await fetch('https://blocked.example.test/'); } catch { externalFetchBlocked = true; }
          return { parentBlocked, cookiesBlocked, storageBlocked, fetchBlocked, externalFetchBlocked };
        });
        assert.deepEqual(isolation, { parentBlocked: true, cookiesBlocked: true, storageBlocked: true, fetchBlocked: true, externalFetchBlocked: true });
        assert.deepEqual(blocked, [], 'CSP stops forbidden traffic before the network layer');
        assert.deepEqual(serverErrors, [], 'All fixture RPC calls satisfy the real snapshot contract');
        assert.deepEqual(errors, [], 'No runtime errors in Chromium/WebKit');
        console.log(JSON.stringify({ engine: engineName, result: 'pass', hydration: 'two contexts', saveRequests, successfulWrites, revision: envelope.revision, calendarAndExports: 'January 2026', isolation, output }));
        for (const item of [first, second, viewer, stale, escaped]) await item.context.close();
      } catch (error) {
        console.error(JSON.stringify({ engine: engineName, errors, warnings, serverErrors, methods, output })); throw error;
      } finally { await browser.close(); }
    }
    assert.ok(engines > 0, 'At least one browser engine must be installed');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
