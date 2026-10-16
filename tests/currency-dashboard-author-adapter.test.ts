import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { adaptCurrencyAuthorHtml, inspectCurrencyAuthorHtml, CurrencyAuthorCompatibilityError } from '../src/shared/lib/currencyDashboardAuthorAdapter';

const raw = readFileSync('assets/currency-dashboard/kursy_valyut_v25.html', 'utf8');
const adapted = adaptCurrencyAuthorHtml(raw, 'V25');
function js(html: string) { return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((match) => match[1]).find((value) => value.trim())!; }
const script = js(adapted);
function ast(code: string) { return ts.createSourceFile('currency.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS); }
function fn(name: string, code = script) {
  const file = ast(code), statement = file.statements.find((entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === name);
  assert.ok(statement, `Missing function ${name}`);
  return statement.getText(file);
}
function plain(value: unknown) { return JSON.parse(JSON.stringify(value)); }

test('author V25 adapter retains original CSS, formula implementations and visual bodies', () => {
  assert.deepEqual(inspectCurrencyAuthorHtml(raw), { sourceVersion: 'V25' });
  assert.equal(adapted.match(/<style>[\s\S]*?<\/style>/)![0], raw.match(/<style>[\s\S]*?<\/style>/)![0]);
  for (const name of ['holt', 'series', 'nextRateDates', 'forecast', 'baseYears', 'baseAvg', 'baseMonthly', 'baseCalc', 'trendForecast', 'pearson', 'keyRateAt', 'renderCorr', 'renderTiles', 'renderChart', 'showBig', 'showStrip', 'renderSum']) {
    assert.equal(fn(name), fn(name, js(raw)), `${name} remains the author's implementation`);
  }
  for (const name of ['renderBase', 'renderCps', 'renderCu']) {
    assert.equal(fn(`author_${name}`).replace(`function author_${name}`, `function ${name}`), fn(name, js(raw)), `${name} only gains a draft-protection wrapper`);
  }
  assert.equal(fn('author_renderAn').replace('function author_renderAn', 'function renderAn').replace('escapeHtml(x.trim())', 'x.trim()'), fn('renderAn', js(raw)));
  assert.ok(adapted.includes('Прогноз на 2027 год'));
  assert.ok(adapted.includes('id="pgBase"'));
  assert.ok(adapted.includes('id="wForm"'));
  assert.ok(adapted.includes('id="f27Form"'));
});

test('adapter version is metadata, not a numbered allowlist, and preserves compatible new sections', () => {
  const next = raw.replaceAll('V25', 'V42').replace('</style>', '.future-section{color:#123456}</style>').replace('</script>\n</body>', 'function futureFormula(x){return x*3;}\n</script>\n</body>');
  assert.equal(inspectCurrencyAuthorHtml(next).sourceVersion, 'V42');
  const output = adaptCurrencyAuthorHtml(next, 'V42');
  assert.ok(output.includes('.future-section{color:#123456}'));
  assert.equal(fn('futureFormula', js(output)), 'function futureFormula(x){return x*3;}');
  assert.match(fn('makeSnapshot', js(output)), /version:"V42"/);
  assert.throws(() => adaptCurrencyAuthorHtml(next, 'V25'), CurrencyAuthorCompatibilityError);
});

test('adapter accepts syntax only and rejects unsupported integration without evaluating uploaded code', () => {
  const noExecution = raw.replace('const CODES=', 'throw new Error("never executed on server");\nconst CODES=');
  assert.doesNotThrow(() => adaptCurrencyAuthorHtml(noExecution, 'V25'));
  for (const invalid of [
    raw.replace('function forecast(', 'function unsupportedForecast('),
    raw.replace('id="cpsForm"', 'id="unknownCpsForm"'),
    raw.replace('<script src="copper_data.js">', '<script src="https://evil.example/script.js">'),
    raw.replace('<script>', '<script>const value = __KTS_CURRENCY_BOOTSTRAP__;'),
    raw.replace('<script>', '<script>function extraSource(){return fetch("https://other.example/");}'),
    raw.replace('<script>', '<script>function extraSource(){return eval("1");}'),
    raw.replace('<script>', '<script>function extraSave(){store.set("kts_future",{answer:42});}'),
    raw.replace('<script>', '<script>function extraSave(key,value){store.set(key,value);}'),
    raw.replace('</body>', '<form id="futureForm"><button>Save</button></form></body>'),
    raw.replace('<input name="eur"', '<input name="newCurrency"'),
    raw.replace('store.set("kts_f27",{upd:', 'store.set("kts_new_f27",{upd:'),
    raw.replace('</head>', '<link href="https://other.example/x.css" rel="stylesheet"></head>'),
    raw.replace('<body>', '<body onload="alert(1)">'),
  ]) assert.throws(() => adaptCurrencyAuthorHtml(invalid, 'V25'), CurrencyAuthorCompatibilityError);
});

test('new forecast form sends separate author rows to CAS save', async () => {
  const file = ast(script);
  const statement = file.statements.find((entry) => ts.isExpressionStatement(entry) && /getElementById\('f27Form'\)\.addEventListener\('submit'/.test(entry.getText(file)));
  assert.ok(statement);
  let submit: ((event: unknown) => Promise<void>) | undefined;
  const patches: unknown[] = [];
  const context = createContext({
    document: { getElementById: () => ({ addEventListener(_event: string, callback: typeof submit) { submit = callback; } }) },
    requireManage() {}, saveSharedPatch: async (patch: unknown) => { patches.push(plain(patch)); }, ruDate: () => '16.10.2026', iso: () => '2026-10-16', renderF27() {}, showSaveError() {},
  });
  runInContext(statement.getText(file), context);
  const details = { open: true };
  await submit!({ preventDefault() {}, target: { rows: { value: 'Bank A | 16.10.2026 | 80 | 85 | |\nBank B | 16.10.2026 | 81 | 86 | |' }, closest: () => details } });
  assert.equal((patches[0] as { kts_f27: { rows: string[] } }).kts_f27.rows.length, 2);
  assert.equal(details.open, false);
});

test('adapted HTML has a single bootstrap, no external script, network, origin storage or worker dependency', () => {
  assert.equal(adapted.split('__KTS_CURRENCY_BOOTSTRAP__').length, 2);
  assert.equal([...adapted.matchAll(/<script\b/gi)].length, 1);
  assert.doesNotMatch(adapted, /<script[^>]+src=|\blocalStorage\b|\bsessionStorage\b|\bfetch\s*\(|new Worker|gsPush|gsPull/);
  assert.equal((ast(script) as ts.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics.length, 0);
});

test('readonly RPC refuses shared writes and keeps the reviewed device and scheduled-update channels', async () => {
  const messages: unknown[] = [];
  const context = createContext({ window: { parent: { postMessage(message: unknown) { messages.push(message); } }, addEventListener() {} }, setTimeout: () => 1, clearTimeout() {} });
  const prefix = script.slice(0, script.indexOf('const CODES=')).replace('__KTS_CURRENCY_BOOTSTRAP__', JSON.stringify({ canManage: false, nonce: 'nonce', parentOrigin: 'https://example.test' }));
  runInContext(prefix, context);
  await assert.rejects(runInContext("rpc('snapshot:save')", context), { code: 'CURRENCY_READ_ONLY' });
  await assert.rejects(runInContext("rpc('snapshot:rollback')", context), { code: 'CURRENCY_READ_ONLY' });
  assert.equal(messages.length, 0);
  runInContext("rpc('snapshot:get')", context);
  assert.equal(messages.length, 1);
  assert.match(fn('startScheduleClock'), /schedule:start/);
  assert.match(fn('startKeepAlive'), /prefs\.sound\|\|prefs\.voice/);
  assert.match(fn('sysNotify'), /notification:show/);
});

test('manual snapshot bridge keeps future fields but excludes device, source, baseline and auto-copper data', () => {
  const context = createContext({});
  runInContext([fn('isManualKey'), fn('manualCopper'), fn('manualSnapshotData')].join('\n'), context);
  const result = plain(runInContext(`manualSnapshotData({kts_weights:{'2022':{USD:35}},kts_f27:{rows:[]},kts_future:{answer:42},kts_cu:{prem:250,rows:[],auto:[1],autoAt:'today'},kts_base:{},kts_baseHist:{},kts_prefs:{},kts_seen:{},kts_gs:{}})`, context));
  assert.deepEqual(result, { kts_weights: { '2022': { USD: 35 } }, kts_f27: { rows: [] }, kts_future: { answer: 42 }, kts_cu: { prem: 250, rows: [], lmci: null, lmciDate: null } });
  assert.match(fn('saveSharedPatch'), /expectedRevision:sharedEnvelope\.revision/);
  assert.match(fn('makeSnapshot'), /sharedEnvelope\.current\?\.data/);
  assert.match(script, /kts_weights:'wForm',kts_f27:'f27Form'/);
  assert.match(script, /#wForm input,#wForm button,#f27Form textarea,#f27Form button/);
});

test('new purchase and forecast forms retain drafts across server and render refresh', () => {
  const fields = [{ name: 'rows', value: 'unsaved', checked: false }];
  const form = { contains: () => false, querySelectorAll: () => fields };
  const context = createContext({ document: { getElementById: () => form, activeElement: null }, dirtyForms: new Set(['f27Form']), savingShared: false, setSharedBusy() {} });
  runInContext(fn('preserveAuthorDraft'), context);
  context.render = () => { fields[0].value = 'server'; };
  runInContext("preserveAuthorDraft('f27Form',render)", context);
  assert.equal(fields[0].value, 'unsaved');
  runInContext("dirtyForms.clear();preserveAuthorDraft('f27Form',render)", context);
  assert.equal(fields[0].value, 'server');
  assert.match(fn('loadShared'), /dirtyForms\.size/);
});

test('V25 uses shared base archive and retains existing calendar nominal and historical baseline behavior', async () => {
  const stored: unknown[] = [];
  const context = createContext({
    state: {}, store: { set(key: string, value: unknown) { stored.push([key, plain(value)]); } },
    getJSON: async (kind: string) => { assert.equal(kind, 'cbr-base-history'); return { data: { '2022-01-10': { USD: 75 } }, miss: [], _currencySource: { stale: false } }; },
    renderAuthorExtras() {}, renderSum() {},
  });
  runInContext(fn('loadBaseHist'), context);
  await runInContext('loadBaseHist()', context);
  assert.deepEqual(stored, [['kts_baseHist', { data: { '2022-01-10': { USD: 75 } }, miss: [] }]]);
  assert.equal(runInContext('state.baseLoading', context), false);
  const calendar = createContext({
    state: { hist: { '2026-01-01': { USD: [9000, 100], KZT: [1.8, 10] } }, baselines: { '2026-01-02': { COPPER: { price: 10000, premium: 240 } } } },
    CODES: ['USD', 'KZT'], store: { get: () => ({ '2026-01-03': { CNY: 12 } }) }, cuSeries: () => [], cuData: () => ({ prem: 900 }), sumMonth: () => '2026-01',
  });
  runInContext(fn('serverCalendarRows'), calendar);
  const rows = plain(runInContext('serverCalendarRows()', calendar));
  assert.equal(rows[0].USD, 90);
  assert.equal(rows[0].KZT, 18);
  assert.equal(rows[1].CU2, 10240);
  assert.equal(rows[2].MX, 12);
  assert.match(fn('sumRows'), /author_sumRows/);
});
