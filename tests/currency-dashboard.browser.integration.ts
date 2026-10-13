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
import { setTimeout as delay } from 'node:timers/promises';
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

function source(kind: unknown, params: Record<string, unknown>, stale: boolean, cbrDate: string) {
  let value: Record<string, unknown>;
  switch (kind) {
    case 'cbr-daily': value = {
      Date: `${cbrDate}T00:00:00+03:00`, Valute: Object.fromEntries((cbrDate === '2026-09-30' ? [
        ['USD', 91, 1, 90], ['EUR', 100, 1, 99], ['CNY', 12.5, 1, 12.4], ['KZT', 18.5, 100, 18.4],
      ] : [
        ['USD', 92, 1, 91], ['EUR', 99, 1, 100], ['CNY', 12.6, 1, 12.5], ['KZT', 18.6, 100, 18.5],
      ]).map(([code, current, nominal, previous]) => [code, { CharCode: code, Name: code, Value: current, Nominal: nominal, Previous: previous }])),
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
  const frameAllow = host.match(/\ballow="([^"]+)"/)?.[1] ?? '';
  assert.ok(frameSandbox, 'Host has an explicit sandbox attribute');
  assert.ok(frameSandbox.split(' ').includes('allow-forms'), 'Host sandbox must permit handled submit events');
  assert.equal(frameSandbox.split(' ').includes('allow-same-origin'), false, 'Host must preserve opaque-origin isolation');
  const output = await mkdtemp('/private/tmp/kts-currency-browser-');
  let envelope = initialState(), staleSources = false, saveRequests = 0, successfulWrites = 0;
  let fixtureCbrDate = '2026-09-30';
  const methods: string[] = [], serverErrors: string[] = [];
  let origin = '';
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const common = { 'Cache-Control': 'no-store' };
      if (url.pathname === '/') {
        const unsafe = url.searchParams.has('unsafe');
        const viewer = url.searchParams.has('viewer');
        const account = url.searchParams.get('account') || 'fixture-account';
        response.writeHead(200, { ...common, 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'fixture-auth=secret; SameSite=Strict' }).end(`<!doctype html><html><body style="margin:0">
<iframe id="report" sandbox="${frameSandbox}" allow="${frameAllow}" style="width:100%;height:1100px;border:0" src="/frame${viewer ? '?viewer=1' : ''}"></iframe><script>
const channel='kts-currency-v1',nonce=${JSON.stringify(nonce)},frame=document.getElementById('report');
const deviceKey=${JSON.stringify(`kts-currency-fixture-device:${account}`)},deviceKeys=['kts_seen','kts_prefs','kts_log'];
window.__fixtureLocalMethods=[];window.__fixtureNotifications=[];window.__fixtureRemoteRequests=[];
window.__fixtureActiveRequests={};window.__fixturePeakRequests={};window.__fixtureHoldKey=null;window.__fixtureHeldRequests=[];
window.__fixtureLoadGeneration=0;window.__fixtureBeforeLoadRequests=[];
frame.addEventListener('load',()=>{window.__fixtureLoadGeneration++;});
window.addEventListener('message',async event=>{
const m=event.data;if(event.source!==frame.contentWindow||event.origin!=='null'||m?.channel!==channel||m.nonce!==nonce||typeof m.id!=='string'||! /^[a-zA-Z0-9:_-]{1,100}$/.test(m.id))return;
const generation=window.__fixtureLoadGeneration;
if(generation===0)window.__fixtureBeforeLoadRequests.push(m.method);
const send=payload=>{if(generation===window.__fixtureLoadGeneration)frame.contentWindow.postMessage({channel,nonce,id:m.id,...payload},'*');};
const reply=result=>send({result});
if(['device:get','device:set','notification:permission','notification:show','schedule:start'].includes(m.method)){
  window.__fixtureLocalMethods.push(m.method);
  try{
    if(m.method==='schedule:start'){
      if(!m.params||Object.keys(m.params).length)throw new Error('Schedule handshake takes no parameters');
      reply({started:true});return;
    }
    if(m.method==='device:get'){reply({values:JSON.parse(localStorage.getItem(deviceKey)||'{}'),persistent:true});return;}
    if(m.method==='device:set'){
      if(!deviceKeys.includes(m.params?.key))throw new Error('Unsupported device key');
      const values=JSON.parse(localStorage.getItem(deviceKey)||'{}');values[m.params.key]=m.params.value;
      localStorage.setItem(deviceKey,JSON.stringify(values));reply({persistent:true});return;
    }
    if(m.method==='notification:permission'){reply({permission:'granted'});return;}
    if(typeof m.params?.body!=='string')throw new Error('Invalid notification body');
    window.__fixtureNotifications.push(m.params.body);reply({shown:true});return;
  }catch(error){send({error:{message:error.message,status:400}});return;}
}
const key=m.method==='source'?'source:'+m.params.kind+(m.params.kind==='moex-candles'?':'+JSON.stringify(m.params):''):m.method;
window.__fixtureRemoteRequests.push(key);window.__fixtureActiveRequests[key]=(window.__fixtureActiveRequests[key]||0)+1;
window.__fixturePeakRequests[key]=Math.max(window.__fixturePeakRequests[key]||0,window.__fixtureActiveRequests[key]);
try{
if(window.__fixtureHoldKey===key)await new Promise(resolve=>window.__fixtureHeldRequests.push(resolve));
const response=await fetch('/rpc',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-fixture-unsafe':${JSON.stringify(unsafe ? '1' : '0')}},body:JSON.stringify({method:m.method,params:m.params})});
const body=await response.json();send(response.ok?{result:body}:{error:{message:body.error,status:response.status,code:body.code}});}
catch(error){send({error:{message:error.message,status:500}});}
finally{window.__fixtureActiveRequests[key]--;}});
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
        else if (method === 'source') result = source(params.kind, params, staleSources, fixtureCbrDate);
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
    const engineNames = process.env.CURRENCY_BROWSER_ENGINE ? [process.env.CURRENCY_BROWSER_ENGINE] : ['chromium', 'webkit'];
    for (const engineName of engineNames) {
      assert.ok(['chromium', 'webkit'].includes(engineName), 'Only configured browser engines may be selected');
      const engine = playwright[engineName];
      try { await access(engine.executablePath()); } catch { console.log(`SKIP ${engineName}: executable unavailable`); continue; }
      engines += 1;
      envelope = initialState(); staleSources = false; saveRequests = 0; successfulWrites = 0;
      fixtureCbrDate = '2026-09-30';
      methods.length = 0; serverErrors.length = 0;
      const browser = await engine.launch({ headless: true });
      const blocked: string[] = [], errors: string[] = [], warnings: string[] = [];
      const createPage = async (suffix = '', options: { audio?: boolean; clock?: boolean } = {}) => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: 'Europe/Moscow', acceptDownloads: true });
        if (options.audio) await context.addInitScript(() => {
          // Observe real Web Audio nodes while retaining each engine's autoplay policy.
          type AudioNodeObservation = { frequency: number; gain: number; stopped: boolean; disconnected: boolean; contextState: string };
          const observedWindow = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext; __fixtureAudioNodes: AudioNodeObservation[] };
          observedWindow.__fixtureAudioNodes = [];
          const Constructor = observedWindow.AudioContext || observedWindow.webkitAudioContext;
          if (!Constructor) return;
          const createOscillator = Constructor.prototype.createOscillator;
          Constructor.prototype.createOscillator = function () {
            const oscillator = createOscillator.call(this);
            const observation = { frequency: 0, gain: 0, stopped: false, disconnected: false, contextState: '' };
            let gain: GainNode | undefined;
            const connect = oscillator.connect, start = oscillator.start, stop = oscillator.stop, disconnect = oscillator.disconnect;
            oscillator.connect = ((...args: unknown[]) => {
              const target = args[0] as GainNode;
              if (target?.gain) gain = target;
              return Reflect.apply(connect, oscillator, args);
            }) as typeof oscillator.connect;
            oscillator.start = (...args) => {
              Object.assign(observation, { frequency: oscillator.frequency.value, gain: gain?.gain.value ?? 0, contextState: this.state });
              observedWindow.__fixtureAudioNodes.push(observation);
              return Reflect.apply(start, oscillator, args);
            };
            oscillator.stop = (...args) => { observation.stopped = true; return Reflect.apply(stop, oscillator, args); };
            oscillator.disconnect = ((...args: unknown[]) => { observation.disconnected = true; return Reflect.apply(disconnect, oscillator, args); }) as typeof oscillator.disconnect;
            return oscillator;
          };
        });
        await context.route('**/*', async (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => {
          const url = new URL(route.request().url());
          if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue();
          blocked.push(url.href); return route.abort();
        });
        const page = await context.newPage();
        page.on('pageerror', (error: Error) => errors.push(error.message));
        page.on('console', (message: { type(): string; text(): string }) => { if (message.type() === 'error') warnings.push(message.text().slice(0, 350)); });
        page.on('dialog', (dialog: { accept(): Promise<void> }) => dialog.accept());
        if (options.clock) await page.clock.install({ time: new Date(fixtureAt) });
        else await page.clock.setFixedTime(new Date(fixtureAt));
        await page.goto(origin + suffix);
        const report = page.frameLocator('#report');
        const frame = page.frames().find((item: { url(): string }) => new URL(item.url()).pathname === '/frame');
        assert.ok(frame);
        try {
          await frame.waitForFunction(() => document.querySelector('#saveStatus')?.textContent?.includes('ревизия'));
          await frame.waitForFunction(() => document.querySelector('#sourceStatus')?.textContent?.includes('LME Cash Settlement') && !document.querySelector('#cuLive')?.textContent?.includes('Загрузка'));
          await page.waitForFunction(() => (window as unknown as { __fixtureLocalMethods: string[] }).__fixtureLocalMethods.includes('schedule:start'));
          assert.deepEqual(await page.evaluate(() => (window as unknown as { __fixtureBeforeLoadRequests: string[] }).__fixtureBeforeLoadRequests), [], 'The first device RPC waits until the host finishes resetting the loaded iframe');
        } catch (error) { console.error(JSON.stringify({ engine: engineName, errors, warnings, serverErrors, methods })); throw error; }
        if (options.clock) await page.clock.pauseAt(new Date(Date.parse(fixtureAt) + 10_000));
        return { context, page, report, frame };
      };
      try {
        const first = await createPage(), second = await createPage();
        const assertAuthorTiles = async (item: typeof first) => {
          const tiles = await item.frame.evaluate(() => Array.from(document.querySelectorAll('#tiles .tile')).map(tile => ({
            opacity: getComputedStyle(tile).opacity,
            background: getComputedStyle(tile).backgroundColor,
            rate: getComputedStyle(tile.querySelector('.rate')!).color,
            code: getComputedStyle(tile.querySelector('.code')!).color,
          })));
          assert.equal(tiles.length, 4, 'All four CBR currency cards render');
          for (const tile of tiles) assert.deepEqual(tile, {
            opacity: '1', background: 'rgb(255, 255, 255)', rate: 'rgb(27, 3, 137)', code: 'rgb(13, 24, 91)',
          }, 'Currency cards preserve the author’s colors at full opacity');
        };
        const reloadPage = async (item: typeof first, suffix?: string) => {
          if (suffix === undefined) await item.page.reload();
          else await item.page.goto(origin + suffix);
          item.frame = item.page.frames().find((candidate: { url(): string }) => new URL(candidate.url()).pathname === '/frame');
          assert.ok(item.frame);
          await item.frame.waitForFunction(() => document.querySelector('#saveStatus')?.textContent?.includes('ревизия'));
          await item.frame.waitForFunction(() => document.querySelector('#sourceStatus')?.textContent?.includes('LME Cash Settlement') && document.querySelectorAll('#tiles .tile').length === 4);
        };
        const openForm = async (item: typeof first, id: string) => {
          const details = item.report.locator('details').filter({ has: item.report.locator(`#${id}`) });
          if (!(await details.getAttribute('open'))) await details.locator('summary').click();
        };
        for (const item of [first, second]) {
          assert.match(await item.report.locator('#cpsRates').innerText(), /123,45/);
          assert.match(await item.report.locator('#an').innerText(), /Fixture Analyst & Co/);
          assert.match(await item.report.locator('#saveStatus').innerText(), /ревизия 1/);
          assert.equal(await item.report.locator('#rollbackShared').isDisabled(), true);
          await assertAuthorTiles(item);
          assert.match(await item.report.locator('#alertMsg').innerText(), /Курс ЦБ на 30\.09\.2026:.*дашборд запущен/);
          assert.equal(await item.report.locator('#bigAlert').evaluate((element: Element) => element.classList.contains('show')), false, 'First-ever launch retains the original silent banner without a popup');
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
        await assertAuthorTiles(viewer);
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
        await viewer.report.locator('#tSound').click();
        await viewer.page.waitForFunction(() => JSON.parse(localStorage.getItem('kts-currency-fixture-device:fixture-account') || '{}').kts_prefs?.sound === true);
        await reloadPage(viewer);
        assert.equal(await viewer.report.locator('#tSound').getAttribute('aria-pressed'), 'true', 'Read-only users can persist their own device preferences');
        assert.equal(await viewer.report.locator('#cpsForm input').first().isDisabled(), true, 'Restoring preferences never unlocks shared editing');
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

        const lifecycle = await createPage();
        await lifecycle.page.waitForFunction(() => JSON.parse(localStorage.getItem('kts-currency-fixture-device:fixture-account') || '{}').kts_seen?.cbrDate === '2026-09-30T00:00:00+03:00');
        for (const selector of ['#tSound', '#tVoice', '#tNotif', '#alertX', '#tAuto']) await lifecycle.report.locator(selector).click();
        await lifecycle.page.waitForFunction(() => {
          const preferences = JSON.parse(localStorage.getItem('kts-currency-fixture-device:fixture-account') || '{}').kts_prefs;
          return preferences?.sound && preferences.voice && preferences.notif && preferences.alertMini && preferences.auto;
        });
        assert.deepEqual(await lifecycle.page.evaluate(() => (window as unknown as { __fixtureNotifications: string[] }).__fixtureNotifications), [], 'Enabling notifications does not invent a market alert');
        assert.ok(await lifecycle.page.evaluate(() => (window as unknown as { __fixtureLocalMethods: string[] }).__fixtureLocalMethods.includes('notification:permission')), 'Notification permission is requested through the authenticated parent');

        fixtureCbrDate = '2026-10-01';
        await lifecycle.page.clock.setFixedTime(new Date('2026-10-01T09:00:00.000Z'));
        await reloadPage(lifecycle);
        await lifecycle.frame.waitForFunction(() => document.querySelector('#bigAlert')?.classList.contains('show') && document.querySelector('#bigTxt')?.textContent?.includes('Новый курс ЦБ на 01.10.2026'));
        const dailyMessage = await lifecycle.report.locator('#bigTxt').innerText();
        for (const fragment of ['USD 92,00 (+1,00)', 'EUR 99,00 (−1,00)', 'CNY 12,60 (+0,10)', 'KZT 18,60 (+0,10)']) {
          assert.ok(dailyMessage.includes(fragment), `New-day alert includes the current value and exact delta: ${fragment}`);
        }
        assert.match(await lifecycle.report.locator('#bigTtl').innerText(), /Центробанк установил новый курс/i);
        await lifecycle.page.waitForFunction(() => {
          const state = JSON.parse(localStorage.getItem('kts-currency-fixture-device:fixture-account') || '{}');
          return state.kts_seen?.cbrDate === '2026-10-01T00:00:00+03:00' && state.kts_log?.some((entry: { msg: string }) => entry.msg.includes('Новый курс ЦБ на 01.10.2026'));
        });
        await lifecycle.page.waitForFunction(() => (window as unknown as { __fixtureNotifications: string[] }).__fixtureNotifications.length === 1);
        assert.deepEqual(await lifecycle.page.evaluate(() => (window as unknown as { __fixtureNotifications: string[] }).__fixtureNotifications), [dailyMessage]);
        await lifecycle.page.screenshot({ path: path.join(output, `${engineName}-new-cbr-day.png`) });

        await reloadPage(lifecycle);
        assert.equal(await lifecycle.report.locator('#bigAlert').evaluate((element: Element) => element.classList.contains('show')), false, 'Reloading the same rate day must not replay the popup');
        assert.equal(await lifecycle.report.locator('#alertMsg').innerText(), dailyMessage, 'The last new-course banner survives reopening');
        assert.deepEqual(await lifecycle.page.evaluate(() => (window as unknown as { __fixtureNotifications: string[] }).__fixtureNotifications), [], 'Reloading does not repeat the system notification');
        for (const selector of ['#tSound', '#tVoice', '#tNotif', '#tAuto']) assert.equal(await lifecycle.report.locator(selector).getAttribute('aria-pressed'), 'true', `${selector} restores its device preference`);
        assert.equal(await lifecycle.report.locator('#alert').evaluate((element: Element) => element.classList.contains('mini')), true, 'Collapsed banner preference is restored');
        assert.equal((await lifecycle.report.locator('#alertX').innerText()).toLocaleLowerCase('ru-RU'), 'развернуть');
        assert.equal(await lifecycle.report.locator('#log li').filter({ hasText: dailyMessage }).count(), 1, 'The daily notification journal survives reload without duplicates');
        await assertAuthorTiles(lifecycle);

        envelope = { ...envelope, revision: envelope.revision + 1, current: {
          ...envelope.current!, data: { ...envelope.current!.data, kts_log: [{ t: '2026-10-01T09:01:00.000Z', msg: 'Another administrator updated the shared snapshot', risk: false }] },
        } };
        await lifecycle.frame.evaluate(() => {
          const observed = window as unknown as { __fixtureReloadClicks: unknown[] };
          observed.__fixtureReloadClicks = [];
          for (const name of ['pointerdown', 'pointerup', 'click']) document.addEventListener(name, event => {
            observed.__fixtureReloadClicks.push({ type: name, target: (event.target as HTMLElement)?.id, soundHint: document.querySelector('#sndHint')?.className, buttonTop: document.querySelector('#reloadShared')?.getBoundingClientRect().top });
          }, { once: true, capture: true });
        });
        await lifecycle.report.locator('#reloadShared').click();
        try {
          await lifecycle.frame.waitForFunction((revision: number) => document.querySelector('#saveStatus')?.textContent?.includes(`ревизия ${revision}`), envelope.revision);
        } catch (error) {
          console.error('Shared reload diagnostics', await lifecycle.frame.evaluate(() => ({ status: document.querySelector('#saveStatus')?.textContent, hint: document.querySelector('#snapHint')?.textContent, ready: document.readyState, clicks: (window as unknown as { __fixtureReloadClicks: unknown[] }).__fixtureReloadClicks })), await lifecycle.page.evaluate(() => {
            const fixture = window as unknown as { __fixtureLoadGeneration: number; __fixtureRemoteRequests: string[]; __fixtureBeforeLoadRequests: string[] };
            return { generation: fixture.__fixtureLoadGeneration, requests: fixture.__fixtureRemoteRequests, beforeLoad: fixture.__fixtureBeforeLoadRequests };
          }));
          throw error;
        }
        assert.equal(await lifecycle.report.locator('#log li').filter({ hasText: dailyMessage }).count(), 1, 'A new shared snapshot never erases the device alert journal');
        await reloadPage(lifecycle);
        assert.equal(await lifecycle.report.locator('#log li').filter({ hasText: dailyMessage }).count(), 1, 'Device journal remains durable after installing another administrator’s snapshot');

        await reloadPage(lifecycle, '/?account=another-account');
        assert.match(await lifecycle.report.locator('#alertMsg').innerText(), /Курс ЦБ на 01\.10\.2026:.*дашборд запущен/);
        for (const selector of ['#tSound', '#tVoice', '#tNotif', '#tAuto']) assert.equal(await lifecycle.report.locator(selector).getAttribute('aria-pressed'), 'false', 'Another account must not inherit device preferences');
        assert.equal(await lifecycle.report.locator('#log li').filter({ hasText: dailyMessage }).count(), 0, 'Another account must not inherit the private alert journal');
        assert.equal(await lifecycle.report.locator('#bigAlert').evaluate((element: Element) => element.classList.contains('show')), false);
        await reloadPage(lifecycle, '/');
        assert.equal(await lifecycle.report.locator('#tSound').getAttribute('aria-pressed'), 'true', 'Returning to the first account restores its settings');
        assert.equal(await lifecycle.report.locator('#log li').filter({ hasText: dailyMessage }).count(), 1);
        const previousFrameGeneration = await lifecycle.page.evaluate(() => (window as unknown as { __fixtureLoadGeneration: number }).__fixtureLoadGeneration);
        await lifecycle.page.evaluate(() => {
          const iframe = document.querySelector('#report') as HTMLIFrameElement;
          iframe.src = iframe.src;
        });
        await lifecycle.page.waitForFunction((previous: number) => (window as unknown as { __fixtureLoadGeneration: number }).__fixtureLoadGeneration > previous, previousFrameGeneration);
        lifecycle.frame = lifecycle.page.frames().find((candidate: { url(): string }) => new URL(candidate.url()).pathname === '/frame');
        await lifecycle.frame.waitForFunction(() => document.querySelector('#tSound')?.getAttribute('aria-pressed') === 'true' && document.querySelector('#log')?.textContent?.includes('Новый курс ЦБ на 01.10.2026'));
        assert.equal(await lifecycle.report.locator('#log li').filter({ hasText: dailyMessage }).count(), 1, 'Reloading only the iframe survives the host load-generation reset');
        assert.equal(await lifecycle.report.locator('#bigAlert').evaluate((element: Element) => element.classList.contains('show')), false);
        assert.equal(successfulWrites, 2, 'Device lifecycle and notification preferences never write a shared snapshot');
        fixtureCbrDate = '2026-09-30';

        const scheduler = await createPage('', { clock: true });
        const waitUntil = async (predicate: () => Promise<boolean>, message: string) => {
          const deadline = Date.now() + 10_000;
          while (!(await predicate())) {
            assert.ok(Date.now() < deadline, message);
            await delay(20);
          }
        };
        const scheduleRequests = async () => scheduler.page.evaluate(() => (window as unknown as { __fixtureRemoteRequests: string[] }).__fixtureRemoteRequests.slice());
        const drainScheduledRequests = async () => {
          let previousCount = -1;
          await waitUntil(async () => {
            const current = await scheduler.page.evaluate(() => {
              const fixture = window as unknown as { __fixtureRemoteRequests: string[]; __fixtureActiveRequests: Record<string, number> };
              return { count: fixture.__fixtureRemoteRequests.length, active: Object.values(fixture.__fixtureActiveRequests).some(Boolean) };
            });
            const settled = !current.active && current.count === previousCount;
            previousCount = current.count;
            return settled;
          }, 'Scheduled requests settle without waiting for a browser timer');
        };
        const trustedTick = async (tickNonce = nonce) => scheduler.page.evaluate(({ channel, tickNonce }: { channel: string; tickNonce: string }) => {
          const target = (document.querySelector('#report') as HTMLIFrameElement).contentWindow!;
          target.postMessage({ channel, nonce: tickNonce, event: 'schedule:tick' }, '*');
        }, { channel: 'kts-currency-v1', tickNonce });
        const clearScheduleRequests = async () => scheduler.page.evaluate(() => { (window as unknown as { __fixtureRemoteRequests: string[] }).__fixtureRemoteRequests = []; });
        const countRequest = (requests: string[], key: string) => requests.filter(request => request === key).length;
        await drainScheduledRequests();
        await clearScheduleRequests();
        const scheduleStartedAt = await scheduler.page.evaluate(() => Date.now());
        let scheduleNow = scheduleStartedAt + 65 * 60_000;
        await scheduler.page.clock.setSystemTime(scheduleNow);
        await trustedTick('another-frame-nonce');
        await scheduler.frame.evaluate(({ nonce }: { nonce: string }) => {
          // The same envelope from the iframe itself must not impersonate the host.
          window.postMessage({ channel: 'kts-currency-v1', nonce, event: 'schedule:tick' }, '*');
          window.dispatchEvent(new MessageEvent('message', { source: window.parent, origin: 'https://wrong-parent.example.test', data: { channel: 'kts-currency-v1', nonce, event: 'schedule:tick' } }));
        }, { nonce });
        await delay(40);
        assert.deepEqual(await scheduleRequests(), [], 'Wrong nonce, source, and origin cannot start overdue jobs');
        await trustedTick();
        await waitUntil(async () => (await scheduleRequests()).includes('source:cbr-history'), 'A trusted host tick runs overdue hourly jobs');
        await drainScheduledRequests();
        const caughtUp = await scheduleRequests();
        for (const key of ['source:cbr-daily', 'source:cbr-history', 'source:moex-currency', 'source:moex-futures', 'source:world', 'source:copper', 'baselines:get', 'snapshot:get']) {
          assert.equal(countRequest(caughtUp, key), 1, `65-minute suspension catches up ${key} once instead of replaying missed intervals`);
        }
        await trustedTick(); await trustedTick(); await delay(40);
        assert.deepEqual(await scheduleRequests(), caughtUp, 'Repeated ticks at the same wall-clock time do not duplicate work');

        await clearScheduleRequests();
        await scheduler.page.evaluate(() => { (window as unknown as { __fixtureHoldKey: string | null }).__fixtureHoldKey = 'source:moex-currency'; });
        scheduleNow += 61_000;
        await scheduler.page.clock.setSystemTime(scheduleNow);
        await trustedTick();
        await waitUntil(async () => scheduler.page.evaluate(() => (window as unknown as { __fixtureHeldRequests: unknown[] }).__fixtureHeldRequests.length === 1), 'MOEX request remains in flight for the overlap scenario');
        scheduleNow += 61_000;
        await scheduler.page.clock.setSystemTime(scheduleNow);
        await trustedTick(); await trustedTick(); await delay(40);
        assert.equal(countRequest(await scheduleRequests(), 'source:moex-currency'), 1, 'An overdue source cannot overlap its still-pending request');
        assert.equal(await scheduler.page.evaluate(() => (window as unknown as { __fixturePeakRequests: Record<string, number> }).__fixturePeakRequests['source:moex-currency']), 1);
        await scheduler.page.evaluate(() => {
          const fixture = window as unknown as { __fixtureHoldKey: string | null; __fixtureHeldRequests: Array<() => void> };
          fixture.__fixtureHoldKey = null;
          fixture.__fixtureHeldRequests.splice(0).forEach(release => release());
        });
        await drainScheduledRequests();

        await clearScheduleRequests();
        scheduleNow += 2_000;
        await scheduler.page.clock.setSystemTime(scheduleNow);
        await scheduler.frame.evaluate(() => {
          Object.defineProperty(document, 'hidden', { configurable: true, value: true });
          document.dispatchEvent(new Event('visibilitychange'));
          Reflect.deleteProperty(document, 'hidden');
        });
        await delay(40);
        assert.deepEqual(await scheduleRequests(), [], 'Moving into the background does not force another refresh');
        await scheduler.frame.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await waitUntil(async () => (await scheduleRequests()).includes('source:cbr-daily'), 'Returning to a visible page refreshes the current CBR rate');
        await drainScheduledRequests();
        const resumed = await scheduleRequests();
        const resumeKeys = ['source:cbr-daily', 'source:moex-currency', 'source:moex-futures', 'baselines:get', 'snapshot:get'];
        for (const key of resumeKeys) assert.equal(countRequest(resumed, key), 1, `Visible-page recovery refreshes ${key}`);
        for (const key of ['source:cbr-history', 'source:world', 'source:copper']) assert.equal(countRequest(resumed, key), 0, 'Hourly sources wait until due');
        await scheduler.frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
        await trustedTick(); await delay(40);
        assert.deepEqual(await scheduleRequests(), resumed, 'Adjacent pageshow and visibility events are deduplicated');
        await clearScheduleRequests();
        scheduleNow += 2_000;
        await scheduler.page.clock.setSystemTime(scheduleNow);
        await scheduler.frame.evaluate(() => {
          window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
          window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
        });
        await waitUntil(async () => (await scheduleRequests()).includes('source:cbr-daily'), 'A restored page resumes scheduling after pagehide');
        await drainScheduledRequests();
        for (const key of resumeKeys) assert.equal(countRequest(await scheduleRequests(), key), 1, `Restored-page recovery refreshes ${key} once`);

        const audioLifecycle = await createPage('', { audio: true });
        const audioNodes = async (): Promise<Array<{ frequency: number; gain: number; stopped: boolean; disconnected: boolean; contextState: string }>> => audioLifecycle.frame.evaluate(() => (window as unknown as { __fixtureAudioNodes: Array<{ frequency: number; gain: number; stopped: boolean; disconnected: boolean; contextState: string }> }).__fixtureAudioNodes.filter(node => node.frequency === 40));
        const activeAudio = async () => (await audioNodes()).filter(node => !node.stopped);
        assert.deepEqual(await audioNodes(), [], 'No continuous audio starts before a user gesture');
        await audioLifecycle.report.locator('#cbrDate').click();
        assert.deepEqual(await audioNodes(), [], 'A gesture alone does not start audio when sound and voice are disabled');
        await audioLifecycle.report.locator('#tSound').click();
        await waitUntil(async () => (await activeAudio()).length === 1, 'Sound activation starts one continuous audio node after browser permission');
        const firstAudioNode = (await audioNodes())[0];
        assert.ok(Math.abs(firstAudioNode.gain - 0.0008) < 1e-8, 'Continuous audio uses the author’s near-silent gain');
        assert.equal(firstAudioNode.contextState, 'running', 'Continuous audio starts only after the browser allows the context to run');
        await audioLifecycle.report.locator('#tVoice').click();
        assert.equal((await activeAudio()).length, 1, 'Enabling both options never creates two continuous nodes');
        await audioLifecycle.report.locator('#tSound').click();
        assert.equal((await activeAudio()).length, 1, 'Voice alone retains the continuous audio node');
        await audioLifecycle.report.locator('#tVoice').click();
        await waitUntil(async () => (await activeAudio()).length === 0, 'Disabling both options stops continuous audio');
        assert.equal((await audioNodes())[0].disconnected, true, 'Stopped continuous audio is disconnected');
        await audioLifecycle.report.locator('#tVoice').click();
        await waitUntil(async () => (await activeAudio()).length === 1, 'A later explicit preference can restart continuous audio');
        await audioLifecycle.frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
        assert.equal((await activeAudio()).length, 0, 'pagehide releases the continuous audio node');
        assert.ok((await audioNodes()).every(node => node.stopped && node.disconnected));
        await audioLifecycle.frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
        await waitUntil(async () => (await activeAudio()).length === 1, 'Persisted pageshow restores audio that was previously activated by the user');
        assert.ok((await audioNodes()).every(node => node.contextState === 'running'));
        await audioLifecycle.page.waitForFunction(() => JSON.parse(localStorage.getItem('kts-currency-fixture-device:fixture-account') || '{}').kts_prefs?.voice === true);
        await reloadPage(audioLifecycle);
        assert.equal(await audioLifecycle.report.locator('#tVoice').getAttribute('aria-pressed'), 'true');
        assert.deepEqual(await audioNodes(), [], 'Restored preferences after a fresh navigation still require a new user gesture');
        await audioLifecycle.report.locator('#cbrDate').click();
        await waitUntil(async () => (await activeAudio()).length === 1, 'A real gesture activates a restored voice preference');
        await audioLifecycle.report.locator('#tVoice').click();
        assert.equal((await activeAudio()).length, 0);

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
        console.log(JSON.stringify({ engine: engineName, result: 'pass', hydration: 'two contexts', saveRequests, successfulWrites, revision: envelope.revision, calendarAndExports: 'January 2026', persistedAlertsAndPreferences: 'new day, reload, snapshot revision, account isolation', authorTileColors: 'full opacity', scheduler: 'trusted ticks, elapsed-time catchup, no overlap, visible and restored pages', audio: 'gesture and preference gating, stop, persisted pageshow', isolation, output }));
        for (const item of [first, second, viewer, stale, escaped, lifecycle, scheduler, audioLifecycle]) await item.context.close();
      } catch (error) {
        console.error(JSON.stringify({ engine: engineName, errors, warnings, serverErrors, methods, output })); throw error;
      } finally { await browser.close(); }
    }
    assert.ok(engines > 0, 'At least one browser engine must be installed');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
