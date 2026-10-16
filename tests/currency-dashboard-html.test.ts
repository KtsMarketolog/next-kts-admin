import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { buildCurrencyDashboardContentSecurityPolicy, renderCurrencyDashboardHtml as renderHtml } from '../src/shared/lib/currencyDashboardHtml';

// Keep the reviewed V21 integration covered as an independently usable rollback.
// V25 and future author versions have their own adapter/parity test suite.
const legacyHtml = readFileSync('assets/currency-dashboard/kursy_valyut_v21.html', 'utf8');
const renderCurrencyDashboardHtml = (nonce: string, origin: string, canManage = false) => renderHtml(nonce, origin, canManage, legacyHtml);

const nonce = '01234567-89ab-4cde-8fab-0123456789ab';
const html = renderCurrencyDashboardHtml(nonce, 'https://example.test', true);
const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
const ast = ts.createSourceFile('currency.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function fn(name: string) {
  const node = ast.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(node, `Missing function ${name}`);
  return node.getText(ast);
}
function variable(name: string) {
  const node = ast.statements.find((s) => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText(ast) === name));
  assert.ok(node, `Missing variable ${name}`);
  return node.getText(ast);
}
function plain(value: unknown) { return JSON.parse(JSON.stringify(value)); }

test('reviewed asset has valid standalone JavaScript and a strict hash-based opaque-origin CSP', () => {
  assert.doesNotThrow(() => new Function(script));
  assert.equal(html.includes('__KTS_CURRENCY_BOOTSTRAP__'), false);
  assert.match(script, /"nonce":"01234567-89ab-4cde-8fab-0123456789ab"/);
  assert.equal([...html.matchAll(/<script\b/gi)].length, 1);
  assert.doesNotMatch(html, /<script[^>]*\bsrc\s*=|\bfetch\s*\(|localStorage|XMLHttpRequest|new Worker|gsPush|gsPull/);
  const policy = buildCurrencyDashboardContentSecurityPolicy(html);
  const hash = createHash('sha256').update(script.replace(/\r\n?/g, '\n')).digest('base64');
  assert.ok(policy.includes(`script-src 'sha256-${hash}'`));
  assert.match(policy, /connect-src 'none'/);
  assert.match(policy, /sandbox allow-scripts allow-downloads allow-modals allow-forms/);
  assert.match(policy, /form-action 'none'/);
  assert.doesNotMatch(policy, /allow-same-origin|unsafe-eval|script-src[^;]*unsafe-inline/);
  assert.notEqual(policy, buildCurrencyDashboardContentSecurityPolicy(renderCurrencyDashboardHtml('different_nonce_12345', 'https://example.test')));
});

test('rendering rejects invalid nonce and non-origin parent URLs', () => {
  for (const value of ['', 'short', '"</script>', 'x'.repeat(129)]) {
    assert.throws(() => renderCurrencyDashboardHtml(value, 'https://example.test'));
  }
  for (const value of ['javascript:alert(1)', 'https://example.test/path', 'https://example.test/', 'https://user:pass@example.test', 'null']) {
    assert.throws(() => renderCurrencyDashboardHtml(nonce, value));
  }
});

test('rendering defaults to read-only and viewer RPC refuses mutations before messaging the host', async () => {
  const viewerHtml = renderCurrencyDashboardHtml(nonce, 'https://example.test');
  assert.match(viewerHtml, /"canManage":false/);
  assert.match(html, /"canManage":true/);
  const requests: unknown[] = [];
  const context = createContext({ window: { parent: { postMessage(message: unknown) { requests.push(message); } }, addEventListener() {} }, setTimeout: () => 1, clearTimeout() {} });
  const viewerScript = viewerHtml.match(/<script>([\s\S]*)<\/script>/)![1];
  runInContext(viewerScript.slice(0, viewerScript.indexOf('const CODES=')), context);
  for (const method of ['snapshot:save', 'snapshot:rollback']) {
    await assert.rejects(runInContext(`rpc('${method}')`, context), { code: 'CURRENCY_READ_ONLY', status: 403 });
  }
  assert.equal(requests.length, 0);
  runInContext("rpc('snapshot:get')", context);
  assert.equal(requests.length, 1, 'Viewer can still read shared data');
});

test('manual numbers and dates reject permissive parseFloat cases; rendered text escapes HTML', () => {
  const context = createContext({});
  runInContext([fn('parseNumber'), fn('parseDate'), variable('escapeHtml')].join('\n'), context);
  const num = (value: unknown, options = {}) => runInContext(`parseNumber(${JSON.stringify(value)},${JSON.stringify(options)})`, context);
  assert.equal(num('12 345,67'), 12345.67);
  assert.equal(num('', { optional: true }), null);
  assert.equal(num('0', { zero: true }), 0);
  for (const value of ['12oops', '1.2.3', '-2', 'Infinity', 'NaN', '1e5', '', '0']) assert.throws(() => num(value));
  assert.equal(runInContext("parseDate('2028-02-29')", context), '2028-02-29');
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '24.09.2026']) assert.throws(() => runInContext(`parseDate('${date}')`, context));
  assert.equal(runInContext(`escapeHtml(${JSON.stringify('<img src=x onerror="boom()">&\'')})`, context), '&lt;img src=x onerror=&quot;boom()&quot;&gt;&amp;&#39;');
  assert.match(fn('renderAn'), /escapeHtml\(x\.trim\(\)\)/);
  assert.match(fn('renderLog'), /escapeHtml\(e\.msg\)/);
});

test('monthly rows and exports use the selected calendar month, true CBR nominal, and historic baseline premium', () => {
  const context = createContext({});
  runInContext(`
    let selectedMonth='2026-01';
    const CODES=['USD','EUR','CNY','KZT'];
    const state={hist:{'2025-12-31':{USD:[90,1]},'2026-01-01':{USD:[91,1],KZT:[20,100]},'2026-01-13':{USD:[9200,100]},'2026-09-29':{USD:[100,1]}},baselines:{'2026-01-13':{COPPER:{price:10000,premium:240}}}};
    const store={get(){return {'2026-01-30':{CNY:13},'2026-09-29':{CNY:14}};}};
    function cuSeries(){return [{date:'2026-01-13',price:9900,m3:10100}];}
    function cuData(){return {prem:700,lmci:null};}
    ${fn('sumRows')}
  `, context);
  const rows = plain(runInContext('sumRows()', context));
  assert.deepEqual(rows.map((r: { date: string }) => r.date), ['2026-01-01', '2026-01-13', '2026-01-30']);
  assert.equal(rows[0].USD_d, 1);
  assert.equal(rows[0].KZT, 20);
  assert.equal(rows[1].USD, 92);
  assert.equal(rows[1].CU2, 10240, 'current premium must not rewrite historic Jintian baseline');
  runInContext("selectedMonth='2026-09'", context);
  assert.deepEqual(plain(runInContext('sumRows().map(r=>r.date)', context)), ['2026-09-29']);
  assert.doesNotMatch(fn('sumRows'), /slice\(-31\)/);
  assert.match(script, /курсы_сводка_\$\{selectedMonth\}\.csv/);
  assert.match(script, /курсы_сводка_\$\{selectedMonth\}\.xlsx/);
});

test('forecast retains author 95-calendar-day lookback and damped Holt/95% formulas', () => {
  const context = createContext({});
  runInContext(`const HIST_DAYS=95;const state={hist:{'2026-01-01':{USD:[80,1]},'2026-05-01':{USD:[90,1]},'2026-08-01':{USD:[92,1]}}};${variable('iso')}\n${fn('series')}`, context);
  assert.deepEqual(plain(runInContext("series('USD').map(r=>r.date)", context)), ['2026-05-01', '2026-08-01']);
  assert.match(fn('holt'), /phi=\.92/);
  assert.match(fn('holt'), /w=1\.96\*sd\*Math\.sqrt\(k\)/);
  assert.match(html, /95%/);
});

test('snapshot projection excludes automatic prices, caches, baseline, preferences and seen state', () => {
  const context = createContext({});
  runInContext([variable('MANUAL_KEYS'), fn('manualCopper'), fn('manualSnapshotData')].join('\n'), context);
  const result = plain(runInContext(`manualSnapshotData({kts_cu:{prem:240,rows:[],lmci:null,lmciDate:null,auto:[{cash:10}],autoAt:'yesterday',autoVia:'script'},kts_prefs:{sound:true},kts_base:{COPPER:1},kts_cbrHist_v2:{},kts_seen:{}})`, context));
  assert.deepEqual(result, { kts_cu: { prem: 240, rows: [], lmci: null, lmciDate: null } });
  assert.doesNotMatch(script, /function setBaseline\(/);
  assert.doesNotMatch(script, />60000|unit===['"]RUB/);
});

test('iframe RPC rejects forged parent/origin/nonce messages and uses string request ids', async () => {
  let listener: (event: unknown) => void = () => {};
  const requests: Record<string, unknown>[] = [];
  const parent = { postMessage(message: Record<string, unknown>, origin: string) { requests.push({ ...message, origin }); } };
  const context = createContext({ window: { parent, addEventListener(_event: string, callback: typeof listener) { listener = callback; } }, setTimeout: () => 1, clearTimeout() {} });
  runInContext(script.slice(0, script.indexOf('const CODES=')), context);
  const result = runInContext("rpc('snapshot:get')", context);
  const request = requests[0];
  assert.equal(typeof request.id, 'string');
  assert.equal(request.origin, 'https://example.test');
  const data = { channel: 'kts-currency-v1', nonce, id: request.id, result: { revision: 1 } };
  listener({ source: {}, origin: 'https://example.test', data });
  listener({ source: parent, origin: 'https://evil.test', data });
  listener({ source: parent, origin: 'https://example.test', data: { ...data, nonce: 'wrong' } });
  assert.equal(runInContext('rpcPending.size', context), 1);
  listener({ source: parent, origin: 'https://example.test', data });
  assert.deepEqual(await result, { revision: 1 });
  assert.equal(runInContext('rpcPending.size', context), 0);
});

function sharedHarness(canManage = true) {
  const nodes = new Map<string, { textContent: string; disabled: boolean; classList: { add(): void; remove(): void }; addEventListener(): void }>();
  const document = { getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, { textContent: '', disabled: false, classList: { add() {}, remove() {} }, addEventListener() {} }); return nodes.get(id)!; }, querySelectorAll() { return []; } };
  const context = createContext({ document, console });
  runInContext(`
    const CAN_MANAGE=${canManage};
    ${fn('requireManage')}
    ${variable('MANUAL_KEYS')}
    ${variable('memoryStore')}
    ${variable('store')}
    function persistDeviceValue(){}
    ${fn('mergeLogs')}
    const announcements=[];
    function presentAnnouncement(event){announcements.push(event);}
    ${fn('manualCopper')}
    const state={},CPS_DEFAULT={eur:1};
    let resolveRpc,rejectRpc;
    function rpc(){return new Promise((resolve,reject)=>{resolveRpc=resolve;rejectRpc=reject;});}
    function renderAn(){} function renderAll(){} function renderLog(){}
    ${script.slice(script.indexOf('let sharedEnvelope='), script.indexOf("document.getElementById('reloadShared').onclick"))}
    installEnvelope({revision:1,current:{at:'2026-09-29T00:00:00Z',savedAt:'2026-09-29T00:00:00Z',actor:'Admin',version:'V21',data:{kts_cpsRates:{eur:100}}},previous:null});
  `, context);
  return { context, nodes };
}

test('viewer cannot save/import shared patches and rollback remains disabled after data refreshes', async () => {
  const { context, nodes } = sharedHarness(false);
  await assert.rejects(runInContext("saveSharedPatch({kts_cpsRates:{eur:110}},'Импорт',true)", context), { code: 'CURRENCY_READ_ONLY', status: 403 });
  assert.equal(runInContext("store.get('kts_cpsRates').eur", context), 100);
  assert.equal(runInContext('resolveRpc', context), undefined, 'No mutation RPC is sent');
  runInContext('sharedEnvelope.previous=sharedEnvelope.current;updateHistoryStatus();setSharedBusy(true);setSharedBusy(false)', context);
  assert.equal(nodes.get('rollbackShared')!.disabled, true);
});

test('shared changes become visible only after server success; CAS failure preserves old data and drafts', async () => {
  const { context, nodes } = sharedHarness();
  runInContext("dirtyForms.add('cpsForm');dirtyForms.add('anForm')", context);
  const saving = runInContext("saveSharedPatch({kts_cpsRates:{eur:110}},'Курс обновлён')", context);
  assert.equal(runInContext("store.get('kts_cpsRates').eur", context), 100);
  runInContext("rejectRpc(Object.assign(new Error('Conflict'),{code:'CURRENCY_CONFLICT',status:409}))", context);
  await assert.rejects(saving, { message: 'Conflict' });
  assert.equal(runInContext("store.get('kts_cpsRates').eur", context), 100);
  assert.equal(runInContext("dirtyForms.has('cpsForm')", context), true);
  runInContext("showSaveError({code:'CURRENCY_CONFLICT'})", context);
  assert.match(nodes.get('saveStatus')!.textContent, /не сохранён и не потерян/);
  const retry = runInContext("saveSharedPatch({kts_cpsRates:{eur:110}},'Курс обновлён')", context);
  runInContext("resolveRpc({revision:2,current:{at:'2026-09-30T00:00:00Z',savedAt:'2026-09-30T00:00:00Z',actor:'OtherAdmin',version:'V21',data:{kts_cpsRates:{eur:110}}},previous:sharedEnvelope.current})", context);
  await retry;
  assert.equal(runInContext("store.get('kts_cpsRates').eur", context), 110);
  assert.equal(runInContext("dirtyForms.has('cpsForm')", context), false);
  assert.equal(runInContext("dirtyForms.has('anForm')", context), true, 'save one form must preserve another unfinished form');
  assert.match(nodes.get('saveStatus')!.textContent, /OtherAdmin.*ревизия 2/);
  assert.equal(nodes.get('rollbackShared')!.disabled, false);
});

test('polling never downgrades a newer revision or silently destroys a dirty draft', async () => {
  const { context } = sharedHarness();
  runInContext("dirtyForms.add('anForm')", context);
  const update = runInContext('loadShared()', context);
  runInContext("resolveRpc({revision:2,current:{data:{kts_cpsRates:{eur:120}}}})", context);
  await update;
  assert.equal(runInContext('sharedEnvelope.revision', context), 1);
  const stale = runInContext('loadShared(true)', context);
  runInContext("sharedEnvelope.revision=3;resolveRpc({revision:2,current:null,previous:null})", context);
  await stale;
  assert.equal(runInContext('sharedEnvelope.revision', context), 3);
});

test('manual change announcement waits for server success and does not duplicate journal events', async () => {
  const { context } = sharedHarness();
  const failed = runInContext("saveSharedPatch({kts_cpsRates:{eur:110}},'Курс обновлён',false,{})", context);
  assert.equal(runInContext('announcements.length', context), 0);
  runInContext("rejectRpc(new Error('network'))", context);
  await assert.rejects(failed);
  assert.equal(runInContext('announcements.length', context), 0);
  const success = runInContext("saveSharedPatch({kts_cpsRates:{eur:110}},'Курс обновлён',false,{})", context);
  runInContext("resolveRpc({revision:2,current:{at:'2026-09-30T00:00:00Z',savedAt:'2026-09-30T00:00:00Z',actor:'Admin',data:{kts_cpsRates:{eur:110},kts_log:[{t:'2026-09-30T00:00:00Z',msg:'Курс обновлён',risk:false}]}},previous:null})", context);
  await success;
  assert.equal(runInContext('announcements.length', context), 1);
  assert.equal(runInContext("store.get('kts_log').length", context), 1);
});

test('shared refresh preserves and deduplicates automatic notification history', () => {
  const { context } = sharedHarness();
  runInContext(`
    const local={t:'2026-09-30T00:00:00Z',msg:'Новый курс ЦБ',risk:false};
    store.set('kts_log',[local]);
    installEnvelope({revision:2,current:{savedAt:'2026-09-30T01:00:00Z',actor:'Admin',data:{kts_log:[local,{t:'2026-09-29T00:00:00Z',msg:'Ручной курс',risk:true}]}}});
  `, context);
  assert.deepEqual(plain(runInContext("store.get('kts_log').map(e=>e.msg)", context)), ['Новый курс ЦБ', 'Ручной курс']);
  runInContext('installEnvelope({revision:3,current:null,previous:null})', context);
  assert.equal(runInContext("store.get('kts_log').length", context), 2);
});

test('saving common manual data never publishes the account device notification history', () => {
  const { context } = sharedHarness();
  runInContext("store.set('kts_log',[{t:'2026-09-30T00:00:00Z',msg:'Private automatic event',risk:false}])", context);
  assert.equal(runInContext('makeSnapshot().data.kts_log', context), undefined);
  runInContext("sharedEnvelope.current.data.kts_log=[{t:'2026-09-29T00:00:00Z',msg:'Common manual event',risk:false}]", context);
  assert.deepEqual(plain(runInContext('makeSnapshot().data.kts_log.map(e=>e.msg)', context)), ['Common manual event']);
});

test('older cached CBR publication does not roll back the seen marker or cause a duplicate new-course alert', () => {
  const context = createContext({});
  runInContext(`
    const state={today:{Date:'2026-09-29T00:00:00+03:00'}},events=[];
    let saved={cbrDate:'2026-09-30T00:00:00+03:00'};
    const store={get(){return saved;},set(_key,value){saved=value;}};
    function announce(msg){events.push(msg);}
    ${fn('checkCbrChange')}
    checkCbrChange();state.today.Date='2026-09-30T00:00:00+03:00';checkCbrChange();
  `, context);
  assert.equal(runInContext('events.length', context), 0);
  assert.equal(runInContext('saved.cbrDate', context), '2026-09-30T00:00:00+03:00');
});

test('persisted futures alert never compares prices of different contracts', () => {
  const context = createContext({});
  runInContext(`
    const state={fut:{BR:{secid:'BRF7',last:74}}},events=[],sourceStates={};
    let saved={fut:{BR:70},futContracts:{BR:'BRZ6'}};
    const store={get(){return saved;},set(_key,value){saved=value;}};
    function announce(msg){events.push(msg);}
    ${variable('nf')}
    ${variable('sgn')}
    ${variable('speakNum')}
    ${fn('checkFutChange')}
    checkFutChange();
  `, context);
  assert.equal(runInContext('events.length', context), 0);
  assert.equal(runInContext('saved.fut.BR', context), 74);
  assert.equal(runInContext('saved.futContracts.BR', context), 'BRF7');
  runInContext('state.fut.BR.last=75;checkFutChange()', context);
  assert.equal(runInContext('events.length', context), 1);
});

test('stale exchange fallback cannot move seen prices or generate false movement alerts', () => {
  const context = createContext({});
  runInContext(`
    const sourceStates={'moex-currency':{stale:true},'moex-futures':{stale:true}};
    const state={moex:[{id:'CNYRUB_TOM',last:12}],fut:{BR:{secid:'BRF7',last:70}}};
    const seen={moex:{CNYRUB_TOM:13},fut:{BR:75},futContracts:{BR:'BRF7'}};
    const store={get(){return seen;},set(){throw new Error('Must not change seen');}};
    function announce(){throw new Error('Must not announce');}
    ${fn('checkFutChange')}
    ${fn('checkMoexChange')}
    checkFutChange();checkMoexChange();
  `, context);
  assert.equal(runInContext('seen.moex.CNYRUB_TOM', context), 13);
  assert.equal(runInContext('seen.fut.BR', context), 75);
});

test('device state restores before rates are checked, queues immutable writes, and never persists manual fields', async () => {
  const requests: { method: string; params?: unknown }[] = [];
  const warning = { hidden: true, textContent: '' };
  const context = createContext({ document: { getElementById: () => warning }, rpc: async (method: string, params?: unknown) => {
    requests.push({ method, params });
    return method === 'device:get' ? { persistent: true, values: { kts_seen: { cbrDate: '2026-09-30T00:00:00Z' }, kts_prefs: { sound: true } } } : { persistent: true };
  } });
  runInContext([variable('DEVICE_KEYS'), variable('memoryStore'), variable('deviceLoaded'), variable('store'), fn('deviceWarning'), fn('persistDeviceValue'), fn('loadDeviceState')].join('\n'), context);
  await runInContext('loadDeviceState()', context);
  assert.equal(runInContext("store.get('kts_prefs').sound", context), true);
  runInContext("const p={sound:true};store.set('kts_prefs',p);p.sound=false;store.set('kts_prefs',p);store.set('kts_cpsRates',{eur:999})", context);
  await runInContext('deviceWrites', context);
  assert.deepEqual(plain(requests.slice(1)), [
    { method: 'device:set', params: { key: 'kts_prefs', value: { sound: true } } },
    { method: 'device:set', params: { key: 'kts_prefs', value: { sound: false } } },
  ]);
  assert.equal(warning.hidden, true);
  const init = script.slice(script.indexOf('(async function init()'));
  assert.ok(init.indexOf('await loadDeviceState()') < init.indexOf('await refreshCbr()'));
});

test('device read failure is explicit and cannot overwrite previously saved state', async () => {
  const warning = { hidden: true, textContent: '' };
  let calls = 0;
  const context = createContext({ document: { getElementById: () => warning }, rpc: async () => { calls++; throw new Error('unavailable'); } });
  runInContext([variable('DEVICE_KEYS'), variable('memoryStore'), variable('deviceLoaded'), variable('store'), fn('deviceWarning'), fn('persistDeviceValue'), fn('loadDeviceState')].join('\n'), context);
  await runInContext('loadDeviceState()', context);
  runInContext("store.set('kts_prefs',{sound:false})", context);
  await runInContext('deviceWrites', context);
  assert.equal(calls, 1);
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /Общие данные на сервере не затронуты/);
});

test('official LME change alerts survive reloads but never announce first, same or older publication', async () => {
  const context = createContext({});
  runInContext(`
    const state={},events=[];let saved=null;
    const store={get(){return saved;},set(_key,value){saved=value;}};
    let rows=[{date:'2026-09-29',cash:10000,m3:10100}];
    async function getJSON(){return {rows,fetched_at:'2026-09-30T00:00:00Z'};}
    function announce(msg,options){events.push({msg,options});}
    ${variable('nf')}
    ${variable('sgn')}
    ${variable('ruDate')}
    ${variable('speakNum')}
    ${fn('loadCopper')}
  `, context);
  await runInContext('loadCopper()', context);
  assert.equal(runInContext('events.length', context), 0);
  runInContext("state.copperAuto=null;rows=[{date:'2026-09-30',cash:10200,m3:10300}]", context);
  await runInContext('loadCopper()', context);
  assert.equal(runInContext('events.length', context), 1);
  assert.match(runInContext('events[0].msg', context), /Медь LME 30.09.2026/);
  assert.equal(runInContext('events[0].options.risk', context), true);
  await runInContext('loadCopper()', context);
  runInContext("rows=[{date:'2026-09-29',cash:10000,m3:10100}]", context);
  await runInContext('loadCopper()', context);
  assert.equal(runInContext('events.length', context), 1);
  assert.equal(runInContext('saved.copper.date', context), '2026-09-30');
});

test('author currency cards retain full opacity while actual disabled controls remain dimmed', () => {
  assert.match(html, /button:disabled:not\(\.tile\),input:disabled,textarea:disabled\{opacity:\.55/);
  assert.doesNotMatch(html, /button:disabled,/);
});

test('failed source refresh keeps the last successful time and is explicitly stale', async () => {
  const context = createContext({});
  runInContext(`const sourceStates={'cbr-daily':{at:'2026-09-29T12:00:00Z',stale:false}};function rpc(){throw new Error('Источник недоступен');}function setStatus(){}\n${fn('getJSON')}`, context);
  await assert.rejects(runInContext("getJSON('cbr-daily')", context), { message: 'Источник недоступен' });
  assert.deepEqual(plain(runInContext("sourceStates['cbr-daily']", context)), { at: '2026-09-29T12:00:00Z', stale: true, error: 'Источник недоступен' });
  assert.doesNotMatch(fn('setStatus'), /state\.updated\s*=\s*new Date/);
});

test('zero/no-trade currency quotes cannot become an artificial zero exchange rate', async () => {
  const context = createContext({});
  runInContext(`const state={};async function getJSON(){return {marketdata:{columns:['SECID','LAST','MARKETPRICE','WAPRICE'],data:[['CNYRUB_TOM',0,12.5,12.4],['KZTRUB_TOM',0,null,0]]}};}\n${fn('loadMoex')}`, context);
  await runInContext('loadMoex()', context);
  assert.deepEqual(plain(runInContext('state.moex.map(r=>[r.id,r.last])', context)), [['CNYRUB_TOM', 12.5]]);
});

test('no comparison crosses futures contracts, and CNY hourly base excludes the unfinished 08:00 candle', () => {
  const context = createContext({});
  runInContext(`const state={fut:{COPPER:{secid:'NEW',lastUsd:11000}},baselines:{'2026-09-29':{COPPER:{secid:'OLD',price:10000}}},candleSecids:{COPPER:'NEW'}};function baseOf(){return {secid:'OLD',price:10000};}\n${fn('liveBlock')}\n${fn('weekDays')}`, context);
  assert.match(runInContext("liveBlock('COPPER',11000,String)", context), /Сравнение разных контрактов не выполняется/);
  const rows = [
    { t: '2026-09-29 07:00:00', end: '2026-09-29 07:59:59', o: 10, c: 10, h: 11, l: 9 },
    { t: '2026-09-29 08:00:00', end: '2026-09-29 08:59:59', o: 10, c: 12, h: 12, l: 10 },
    { t: '2026-09-29 09:00:00', end: '2026-09-29 09:59:59', o: 12, c: 13, h: 13, l: 12 },
  ];
  assert.equal(runInContext(`weekDays(${JSON.stringify(rows)},'CNY')[0].base`, context), 10);
  assert.equal(runInContext(`weekDays(${JSON.stringify(rows)},'COPPER')[0].base`, context), null);
  assert.match(fn('loadFutures'), /if\(!match\)return/);
  assert.match(fn('renderTicker'), /cu\.secid===bC\.secid/);
  assert.match(fn('renderTicker'), /br\.secid===bB\.secid/);
});

test('successful candle refresh for another instrument does not hide an earlier failure', async () => {
  const context = createContext({});
  runInContext(`const sourceStates={},sourceNames={};async function rpc(_method,params){if(params.secid==='BAD')throw new Error('Нет связи');return {_currencySource:{fetchedAt:'2026-09-29T00:00:00Z',stale:false}};}function setStatus(){}\n${fn('getJSON')}`, context);
  await assert.rejects(runInContext("getJSON('moex-candles',{secid:'BAD',from:'2026-09-01',till:'2026-09-30'})", context));
  await runInContext("getJSON('moex-candles',{secid:'GOOD',from:'2026-09-01',till:'2026-09-30'})", context);
  assert.equal(runInContext('Object.values(sourceStates).filter(s=>s.stale).length', context), 1);
});

test('asset provenance keeps the author UI and methods in the reviewed deployment artifact', () => {
  const raw = readFileSync('assets/currency-dashboard/kursy_valyut_v21.html', 'utf8');
  for (const phrase of ['Методика и разработка — ФАМ', 'Jintian', 'СПС-холод', 'Хольт', 'Курс 1', 'Курс 2']) assert.ok(raw.includes(phrase), phrase);
});

test('worker ticks use elapsed time, catch up once after sleep and never overlap a pending job', async () => {
  const context = createContext({});
  runInContext(`
    let now=0,release;const Date={now:()=>now},calls=[];
    function setStatus(){}
    ${variable('runningJobs')}
    ${variable('scheduledJobs')}
    ${fn('runJob')}
    ${fn('checkScheduledJobs')}
    const fast=async()=>{calls.push('fast');await new Promise(resolve=>{release=resolve;});};
    const slow=async()=>{calls.push('slow');};
    scheduledJobs=[{fn:fast,every:60000,lastStarted:0,onResume:true},{fn:slow,every:600000,lastStarted:0,onResume:false}];
    scheduleReady=true;
    now=59999;checkScheduledJobs();
  `, context);
  assert.deepEqual(plain(runInContext('calls', context)), []);
  runInContext('now=60000;checkScheduledJobs();checkScheduledJobs()', context);
  assert.deepEqual(plain(runInContext('calls', context)), ['fast']);
  runInContext('now=3900000;checkScheduledJobs();checkScheduledJobs()', context);
  assert.deepEqual(plain(runInContext('calls', context)), ['fast', 'slow']);
  await runInContext('release()', context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  runInContext('checkScheduledJobs();checkScheduledJobs()', context);
  assert.deepEqual(plain(runInContext('calls', context)), ['fast', 'slow', 'fast']);
  await runInContext('release()', context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  runInContext('now+=500;checkScheduledJobs(true)', context);
  assert.equal(runInContext('calls.length', context), 3, 'resume events in same second do not duplicate');
  runInContext('now+=500;checkScheduledJobs(true)', context);
  assert.equal(runInContext('calls.length', context), 4, 'visible resume checks live jobs, not every hourly task');
  await runInContext('release()', context);
  await new Promise<void>((resolve) => setImmediate(resolve));
  runInContext('schedulePageHidden=true;now+=3900000;checkScheduledJobs(true)', context);
  assert.equal(runInContext('calls.length', context), 4, 'pagehide suspends outgoing jobs');
  runInContext('schedulePageHidden=false;checkScheduledJobs()', context);
  assert.deepEqual(plain(runInContext('calls', context)), ['fast', 'slow', 'fast', 'fast', 'fast', 'slow']);
});

test('only authenticated parent ticks reach the fixed local job list', () => {
  let listener: (event: unknown) => void = () => {};
  let ticks = 0;
  const parent = { postMessage() {} };
  const context = createContext({ window: { parent, addEventListener(_event: string, callback: typeof listener) { listener = callback; } }, checkScheduledJobs() { ticks++; } });
  runInContext(script.slice(0, script.indexOf('const CODES=')), context);
  const data = { channel: 'kts-currency-v1', nonce, event: 'schedule:tick' };
  listener({ source: {}, origin: 'https://example.test', data });
  listener({ source: parent, origin: 'null', data });
  listener({ source: parent, origin: 'https://example.test', data: { ...data, nonce: 'wrong' } });
  listener({ source: parent, origin: 'https://example.test', data: { ...data, event: 'other' } });
  assert.equal(ticks, 0);
  listener({ source: parent, origin: 'https://example.test', data });
  assert.equal(ticks, 1);
});

test('author audio keep-alive is opt-in, activated, singleton and cleaned when disabled or leaving', async () => {
  const context = createContext({});
  runInContext(`
    const prefs={sound:false,voice:false},stats={created:0,started:0,stopped:0,disconnected:0};
    let finishResume;
    const document={getElementById:()=>({classList:{toggle(){}}})};
    const window={AudioContext:class{
      state='running';destination={};
      constructor(){stats.created++;}
      createOscillator(){return {frequency:{value:0},connect(){},start(){stats.started++;},stop(){stats.stopped++;},disconnect(){stats.disconnected++;}};}
      createGain(){return {gain:{value:0},connect(){},disconnect(){stats.disconnected++;}};}
      resume(){return new Promise(resolve=>{finishResume=()=>{this.state='running';resolve();};});}
    }};
    ${variable('audio')}
    ${variable('keepAlive')}
    ${fn('getAudio')}
    ${fn('sndHint')}
    ${fn('startKeepAlive')}
    ${fn('stopKeepAlive')}
    ${fn('resumeAudio')}
  `, context);
  await runInContext('resumeAudio()', context);
  runInContext('prefs.sound=true;startKeepAlive()', context);
  assert.equal(runInContext('stats.created', context), 0, 'off or no gesture does not create an audio context');
  await runInContext('audioActivated=true;resumeAudio()', context);
  runInContext('startKeepAlive()', context);
  assert.equal(runInContext('stats.started', context), 1);
  assert.equal(runInContext('keepAlive.oscillator.frequency.value', context), 40);
  assert.equal(runInContext('keepAlive.gain.gain.value', context), 0.0008);
  await runInContext('prefs.sound=false;prefs.voice=true;resumeAudio()', context);
  assert.equal(runInContext('stats.stopped', context), 0, 'voice alone keeps opt-in audio running');
  await runInContext('prefs.voice=false;resumeAudio()', context);
  assert.equal(runInContext('stats.stopped', context), 1);
  assert.equal(runInContext('stats.disconnected', context), 2);
  runInContext('prefs.sound=true;audio.state="suspended"', context);
  const pending = runInContext('resumeAudio()', context);
  runInContext('audioPageHidden=true;finishResume()', context);
  await pending;
  assert.equal(runInContext('stats.started', context), 1, 'late resume cannot restart audio after pagehide');
  await runInContext('audioPageHidden=false;resumeAudio()', context);
  assert.equal(runInContext('stats.started', context), 2);
  runInContext('audioPageHidden=true;startKeepAlive()', context);
  assert.equal(runInContext('stats.stopped', context), 2);
});

test('late toggle confirmation cannot play sound or voice after pagehide', async () => {
  for (const key of ['sound', 'voice']) {
    const context = createContext({});
    runInContext(`
      let release,audioPageHidden=false;const prefs={sound:false,voice:false},button={setAttribute(){}};
      const document={getElementById:()=>button},store={set(){}},window={speechSynthesis:true};
      const speechSynthesis={cancel(){},getVoices:()=>[],speak(){throw new Error('Voice after leaving');}};
      function SpeechSynthesisUtterance(text){this.text=text;}
      function resumeAudio(){return new Promise(resolve=>{release=resolve;});}
      function getAudio(){throw new Error('Chime after leaving');}
      ${fn('chime')}
      ${fn('say')}
      ${fn('setTog')}
      setTog('toggle','${key}');
    `, context);
    const pending = runInContext('button.onclick()', context);
    runInContext('audioPageHidden=true;release()', context);
    await pending;
  }
});

test('frame fallback clock is bounded, disposed and replaced by the trusted host when available', async () => {
  const context = createContext({});
  runInContext(`
    ${variable('scheduledJobs')}
    ${fn('stopScheduleFallback')}
    ${fn('startScheduleClock')}
    let attempts=0,succeed=false,next=0;const timers=new Map();
    function checkScheduledJobs(){}
    function setInterval(callback,ms){if(ms!==1000)throw new Error('interval');timers.set(++next,callback);return next;}
    function clearInterval(id){timers.delete(id);}
    async function rpc(method){if(method!=='schedule:start')throw new Error('method');attempts++;if(!succeed)throw new Error('unavailable');return {started:true};}
    scheduleReady=true;
  `, context);
  await runInContext('Promise.all([startScheduleClock(),startScheduleClock()])', context);
  assert.equal(runInContext('attempts', context), 1);
  assert.equal(runInContext('timers.size', context), 1);
  await runInContext('startScheduleClock()', context);
  assert.equal(runInContext('timers.size', context), 1);
  runInContext('schedulePageHidden=true;stopScheduleFallback()', context);
  await runInContext('startScheduleClock()', context);
  assert.equal(runInContext('timers.size', context), 0);
  await runInContext('schedulePageHidden=false;succeed=true;startScheduleClock()', context);
  assert.equal(runInContext('scheduleHostStarted', context), true);
  assert.equal(runInContext('timers.size', context), 0);
});
