import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { buildCurrencyDashboardContentSecurityPolicy, renderCurrencyDashboardHtml } from '../src/shared/lib/currencyDashboardHtml';

const nonce = '01234567-89ab-4cde-8fab-0123456789ab';
const html = renderCurrencyDashboardHtml(nonce, 'https://example.test');
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

function sharedHarness() {
  const nodes = new Map<string, { textContent: string; disabled: boolean; classList: { add(): void; remove(): void }; addEventListener(): void }>();
  const document = { getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, { textContent: '', disabled: false, classList: { add() {}, remove() {} }, addEventListener() {} }); return nodes.get(id)!; }, querySelectorAll() { return []; } };
  const context = createContext({ document, console });
  runInContext(`
    ${variable('MANUAL_KEYS')}
    ${variable('memoryStore')}
    ${variable('store')}
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
