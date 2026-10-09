import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { injectProfitabilityAuditAdapter, isProfitabilityHtmlCandidate, isSupportedProfitabilityHtml } from '../src/shared/lib/dashboardProfitabilityHtml';
import { parseProfitabilityInvoice } from '../src/shared/lib/dashboardProfitabilityAudit';

const marker = 'kts-profitability-audit-v1';
const nonce = '01234567-89ab-4def-8123-456789abcdef';
const invoiceAnchor = "S.log.push({ file: f.name, kind: inv.docType + ' · ' + r.kind, ok: true, id: inv.id, msg });";
const snapshotAnchor = "S.log.push({ file: f.name, kind: 'снимок', ok: true, msg: 'счетов: ' + d.invs.length + ', сохранён ' + dtstr(new Date(d.saved)) });";
const syntheticScript = `var DEMO = false;\nfunction invoiceSuccess(inv, f) { var S={log:[]}, r={kind:'XLSX'}, msg=''; ${invoiceAnchor} }\nfunction snapshotSuccess(d, f) { var S={log:[]},dtstr=String; ${snapshotAnchor} }`;
const syntheticHtml = '<!doctype html><html><head><title>Fixture</title></head><body><script>' + syntheticScript + '</script></body></html>';

/** The test loader alone treats a fully synthetic application as the reviewed profile. No production bypass. */
function syntheticProfile() {
  const exports: Record<string, (html: string) => string | boolean> = {};
  const source = ts.transpileModule(readFileSync('src/shared/lib/dashboardProfitabilityHtml.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, {
    exports,
    require(name: string) {
      assert.equal(name, 'node:crypto');
      return { createHash(algorithm: string) {
        let input = '';
        return { update(value: string) { input += value; return this; }, digest(encoding: 'hex') {
          return input === syntheticScript ? 'e58f2d053f9edc76217a13e1a3d8ec89bd8e2493604ef00786d70b656d6e9b84' : createHash(algorithm).update(input).digest(encoding);
        } };
      } };
    },
  });
  return exports as unknown as { isSupportedProfitabilityHtml(html: string): boolean; injectProfitabilityAuditAdapter(html: string): string };
}

const syntheticAdaptedHtml = syntheticProfile().injectProfitabilityAuditAdapter(syntheticHtml);
const adapterScript = /<script data-kts-profitability-audit-adapter="v1">([\s\S]*?)<\/script>/.exec(syntheticAdaptedHtml)![1];

type TestEvent = Record<string, unknown>;
type Invoice = Record<string, unknown>;
class Element {
  id = '';
  type = '';
  hidden = false;
  textContent = '';
  style = { cssText: '', borderColor: '' };
  attributes = new Map<string, string>();
  children: Element[] = [];
  listeners = new Map<string, (event: TestEvent) => void>();
  appendChild(element: Element) { this.children.push(element); return element; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(name: string, handler: (event: TestEvent) => void) { this.listeners.set(name, handler); }
}
function adapterFixture(script = adapterScript) {
  const messages: TestEvent[] = [];
  const docListeners = new Map<string, Array<(event: TestEvent) => void>>();
  const winListeners = new Map<string, Array<(event: TestEvent) => void>>();
  const add = (map: typeof docListeners) => (name: string, fn: (event: TestEvent) => void) => map.set(name, [...(map.get(name) ?? []), fn]);
  let time = 1_800_000_000_000;
  let sequence = 0;
  const intervals: Array<() => void> = [];
  const parent = { postMessage(message: TestEvent) { messages.push(JSON.parse(JSON.stringify(message))); } };
  const body = new Element();
  const document = { body, createElement: () => new Element(), addEventListener: add(docListeners) };
  const window = { parent, addEventListener: add(winListeners), setInterval: (fn: () => void) => intervals.push(fn),
    crypto: { getRandomValues: (value: Uint8Array) => value.fill(5), randomUUID: () => `01234567-89ab-4def-8123-${String(++sequence).padStart(12, '0')}` },
    __ktsProfitabilityAuditV19: undefined as undefined | { recordInvoices(invoices: Invoice[], file: object): void },
  };
  class Clock extends Date { static now() { return time; } }
  const context = vm.createContext({ window, document, Date: Clock, TextEncoder, Uint8Array });
  vm.runInContext(script, context);
  const fireDocument = (name: string, event: TestEvent) => docListeners.get(name)?.forEach(fn => fn({ type: name, ...event }));
  const fire = (name: string, event: TestEvent) => winListeners.get(name)?.forEach(fn => fn(event));
  const init = () => fire('message', { source: parent, data: { marker, type: 'init', nonce } });
  const mark = (file: object, id = 'fInv', isTrusted = true) => fireDocument('change', { isTrusted, target: { id, type: 'file', files: [file] } });
  const record = (invoices: Invoice[], file: object) => window.__ktsProfitabilityAuditV19!.recordInvoices(invoices, file);
  const invoices = () => messages.filter(message => message.type === 'invoice');
  const ack = (ok: boolean, eventId = invoices().at(-1)?.eventId) => fire('message', { source: parent, data: { marker, type: 'ack', nonce, eventId, ok, error: 'Временно недоступно' } });
  const advance = (ms: number) => { time += ms; intervals.forEach(fn => fn()); };
  const status = () => body.children[0]?.children[1]?.textContent ?? '';
  return { window, document, body, parent, context, messages, fireDocument, fire, init, mark, record, invoices, ack, advance, status };
}

function invoice(overrides: Invoice = {}): Invoice {
  return { docType: 'Счёт', no: 'SYNTHETIC-001', warns: [], curDet: 'USD', cur: 'RUB', totalDue: 40,
    buyer: 'PRIVATE-BUYER-DO-NOT-SEND', sellerInn: 'PRIVATE-INN', comment: 'PRIVATE-COMMENT',
    lines: [{ name: 'Synthetic valve', qty: 2, gross: 40, mprice: 999999, cost: 1234, match: { privateStock: true } }], ...overrides };
}

test('V19 fingerprint is exact, independent of data, unique, and unknown HTML remains byte-for-byte unchanged', () => {
  assert.equal(isSupportedProfitabilityHtml(syntheticHtml), false);
  assert.equal(injectProfitabilityAuditAdapter(syntheticHtml), syntheticHtml);
  const profile = syntheticProfile();
  assert.equal(profile.isSupportedProfitabilityHtml(syntheticHtml), true);
  assert.equal(profile.isSupportedProfitabilityHtml(syntheticHtml.replace('var DEMO = false', 'var DEMO = true')), false);
  assert.equal(profile.isSupportedProfitabilityHtml(syntheticHtml.replace('<script>', '<script type="text/plain">')), false);
  assert.equal(profile.isSupportedProfitabilityHtml(syntheticHtml.replace('</body>', '<script>' + syntheticScript + '</script></body>')), false);
  const adapted = profile.injectProfitabilityAuditAdapter(syntheticHtml);
  assert.ok(adapted.indexOf('data-kts-profitability') < adapted.indexOf('<title>'));
  assert.match(adapted, /recordInvoices\(\[inv\], f\)/);
  assert.match(adapted, /recordInvoices\(d\.invs, f\)/);
  assert.equal(profile.injectProfitabilityAuditAdapter(adapted), adapted);
  assert.equal(profile.isSupportedProfitabilityHtml(adapted), false);
  assert.doesNotThrow(() => new Function(adapterScript));
});

test('candidate recognition only refuses unknown profitability versions; it never enables audit by markers', () => {
  const candidate = '<html><head><title>Рентабельность счетов V20</title></head><body><input id="fInv" type="file"><script>const format="kts-rent-snapshot";</script></body></html>';
  assert.equal(isProfitabilityHtmlCandidate(candidate), true);
  assert.equal(isSupportedProfitabilityHtml(candidate), false);
  assert.equal(injectProfitabilityAuditAdapter(candidate), candidate);
  assert.equal(isProfitabilityHtmlCandidate(candidate.replace('<script>', '<script data-kts-profitability-audit-adapter="v1">')), true);
  assert.equal(isProfitabilityHtmlCandidate('<html><title>Аналитика продаж</title><input id="fInv" type="file"><script>const format="kts-rent-snapshot";</script></html>'), false);
  assert.equal(isProfitabilityHtmlCandidate('<html><title>Рентабельность счетов</title><script>const format="generic-snapshot";</script></html>'), false);
  assert.equal(isProfitabilityHtmlCandidate('<html><script>function parseInvoiceFile(f){}; const kind="kts-rent-snapshot"; const prefix="kts-rent:";</script></html>'), true);
});

test('allowlisted original currency/amount and nonmanual invoice items only, server derives identity and time', () => {
  const state = adapterFixture();
  const file = {};
  state.mark(file);
  state.record([invoice({ lines: [{ name: 'Synthetic valve', qty: 2, gross: 40, mprice: 999999, cost: 1234 },
    { manual: true, name: 'Manual RUB delivery', qty: 1, gross: 5000 }] })], file);
  assert.equal(state.invoices().length, 0);
  state.init();
  assert.equal(state.invoices().length, 1);
  const event = state.invoices()[0];
  assert.deepEqual(event.invoice, { schemaVersion: 1, documentType: 'invoice', invoiceNumber: 'SYNTHETIC-001', currency: 'USD',
    dealAmount: 40, amountSource: 'document', lines: [{ nomenclature: 'Synthetic valve', quantity: 2 }] });
  assert.deepEqual(parseProfitabilityInvoice(event.invoice), event.invoice);
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE|mprice|cost|buyer|seller|file|manager|actor|date/);
  assert.match(state.status(), /Ожидают подтверждения/);
  state.ack(true);
  assert.match(state.status(), /записана в журнал: 1/);
});

test('file identity and trusted import events suppress automatic restoration, demo files and source inputs', () => {
  const state = adapterFixture();
  state.init();
  for (const [id, trusted] of [['fInv', false], ['fStock', true], ['fDir', true], ['unknown', true]] as const) {
    const file = {};
    state.mark(file, id, trusted);
    state.record([invoice()], file);
  }
  state.record([invoice()], {});
  assert.equal(state.invoices().length, 0);
  for (const id of ['fInv', 'fSnap', 'fDirInv']) {
    const file = {};
    state.mark(file, id);
    state.record([invoice()], file);
    state.ack(true);
  }
  const dropped = {};
  state.fireDocument('drop', { isTrusted: true, dataTransfer: { files: [dropped] } });
  state.record([invoice()], dropped);
  assert.equal(state.invoices().length, 4);
});

test('missing numbers, original line-sum fallback, unavailable amount and signed quantities preserve truth', () => {
  const state = adapterFixture();
  const file = {};
  state.mark(file, 'fSnap'); state.init();
  state.record([invoice({ no: 'filename-fallback', warns: ['не найден номер КП'], docType: 'КП', totalDue: null,
    lines: [{ name: 'Return', qty: -2, gross: -20 }, { name: 'New goods', qty: 3, gross: 50 }, { manual: true, name: 'RUB adjustment', qty: 1, gross: 500 }] })], file);
  assert.deepEqual(state.invoices()[0].invoice, { schemaVersion: 1, documentType: 'quote', invoiceNumber: null,
    currency: 'USD', dealAmount: 30, amountSource: 'lines', lines: [{ nomenclature: 'Return', quantity: -2 }, { nomenclature: 'New goods', quantity: 3 }] });
  state.ack(true);
  state.record([invoice({ totalDue: null, lines: [{ name: 'Synthetic unknown price', qty: 1, gross: null }] })], file);
  assert.equal((state.invoices()[1].invoice as Invoice).dealAmount, null);
  assert.equal((state.invoices()[1].invoice as Invoice).amountSource, 'unavailable');
  for (const item of state.invoices()) assert.doesNotThrow(() => parseProfitabilityInvoice(item.invoice));
});

test('failed, lost and forged ACKs do not discard events; retries keep the same id and unload warns', () => {
  const state = adapterFixture();
  const file = {};
  state.mark(file); state.record([invoice()], file);
  state.fire('message', { source: {}, data: { marker, type: 'init', nonce } });
  assert.equal(state.invoices().length, 0);
  state.advance(11000);
  assert.match(state.status(), /Нет соединения/);
  state.init();
  const eventId = state.invoices()[0].eventId;
  state.fire('message', { source: {}, data: { marker, type: 'ack', nonce, eventId, ok: true } });
  state.fire('message', { source: state.parent, data: { marker, type: 'ack', nonce: 'wrong', eventId, ok: true } });
  let warned = false;
  state.fire('beforeunload', { preventDefault: () => { warned = true; } });
  assert.equal(warned, true);
  state.advance(10000);
  assert.equal(state.invoices().at(-1)!.eventId, eventId);
  state.ack(false);
  assert.match(state.status(), /Временно недоступно/);
  const count = state.invoices().length;
  state.advance(29999); assert.equal(state.invoices().length, count);
  state.advance(1); assert.equal(state.invoices().length, count + 1);
  assert.equal(state.invoices().at(-1)!.eventId, eventId);
  state.ack(true);
  warned = false;
  state.fire('beforeunload', { preventDefault: () => { warned = true; } });
  assert.equal(warned, false);
});

test('inner pending status contains no financial details and survives delayed handshakes, retries and validation failure', () => {
  const state = adapterFixture(); const file = {};
  state.mark(file); state.record([invoice()], file);
  assert.equal(state.messages.some(message => message.type === 'status'), false, 'no status before trusted nonce');
  state.init();
  const lastStatus = () => state.messages.filter(message => message.type === 'status').at(-1)!;
  assert.deepEqual(lastStatus(), { marker, type: 'status', nonce, pending: true });
  state.advance(3000);
  assert.deepEqual(lastStatus(), { marker, type: 'status', nonce, pending: true });
  state.ack(true);
  assert.deepEqual(lastStatus(), { marker, type: 'status', nonce, pending: false });
  state.record([invoice({ lines: [] })], file);
  assert.deepEqual(lastStatus(), { marker, type: 'status', nonce, pending: true }, 'rejected details must not clear loss warning');
  assert.doesNotMatch(JSON.stringify(state.messages.filter(message => message.type === 'status')), /invoice|quantity|amount|SYNTHETIC|PRIVATE/);
});

test('oversized or malformed details and queue overflow stay visibly failed without truncation or leaked values', () => {
  const invalids = [invoice({ no: 'N'.repeat(201) }), invoice({ totalDue: 1e16 }), invoice({ curDet: 'INVALID' }),
    invoice({ lines: [{ name: 'N'.repeat(501), qty: 1, gross: 1 }] }), invoice({ lines: [{ name: 'x', qty: Infinity, gross: 1 }] }),
    invoice({ lines: [{ name: 'x', qty: 1e13, gross: 1 }] }), invoice({ lines: Array.from({ length: 1001 }, () => ({ name: 'x', qty: 1, gross: 1 })) }),
    invoice({ lines: Array.from({ length: 1000 }, () => ({ name: '字'.repeat(500), qty: 1, gross: 1 })) }),
  ];
  for (const inv of invalids) {
    const state = adapterFixture(); const file = {};
    state.mark(file); state.init(); state.record([inv], file);
    assert.equal(state.invoices().length, 0);
    assert.match(state.status(), /Не записано: 1/);
  }
  const state = adapterFixture(); const file = {};
  state.mark(file); state.record(Array.from({ length: 101 }, () => invoice()), file);
  assert.match(state.status(), /Очередь журнала заполнена/);
  assert.match(state.status(), /В очереди: 100/);
  state.init(); assert.equal(state.invoices().length, 1);
});

const localHtmlPath = process.env.KTS_PROFITABILITY_HTML_FIXTURE;
test('optional real V19 app: exact profile and original successful invoice/snapshot hooks, synthetic data only', { skip: !localHtmlPath || !existsSync(localHtmlPath) }, async () => {
  const original = readFileSync(localHtmlPath!, 'utf8');
  assert.equal(isSupportedProfitabilityHtml(original), true);
  assert.equal(isProfitabilityHtmlCandidate(original), true);
  assert.equal(isProfitabilityHtmlCandidate(original.replace(invoiceAnchor, invoiceAnchor + '/*changed author version*/')), true);
  assert.equal(isSupportedProfitabilityHtml(original.replace(invoiceAnchor, invoiceAnchor + '/*changed*/')), false);
  const adapted = injectProfitabilityAuditAdapter(original);
  assert.equal(isProfitabilityHtmlCandidate(adapted), true);
  assert.equal(injectProfitabilityAuditAdapter(adapted), adapted);
  const adapter = /<script data-kts-profitability-audit-adapter="v1">([\s\S]*?)<\/script>/.exec(adapted)![1];
  const app = [...adapted.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(match => match[1].includes('async function addFiles(files)'))![1];
  // Only execute the two reviewed application functions, not libraries, embedded datasets or network code.
  const addFiles = app.slice(app.indexOf('async function addFiles(files)'), app.indexOf('/* основной дашборд: снимок'));
  const openSnapshot = app.slice(app.indexOf('async function openSnapshot(f)'), app.indexOf('async function loadDataFiles(files)'));
  const state = adapterFixture(adapter);
  const S = { log: [] as Invoice[], invs: [] as Invoice[], exp: new Set(), view: 'load', sess: {}, srcRes: {}, shared: [], mrates: {} };
  Object.assign(state.context, { S, MGR: true, DEMO: false, uid: 1, SET: { inputVat: true },
    toast() {}, busy() {}, render() {}, tick: async () => {}, srcType: () => null, pickLatest: () => ({ chosen: [], skipped: [] }),
    parseInvoiceFile: async (f: { name: string }) => { if (f.name === 'bad.xlsx') throw new Error('synthetic parse failure'); return invoice(); },
    matchLine: () => ({}), dtstr: String, console: { error() {} },
    openSourcesSnapshot: () => {},
  });
  vm.runInContext(addFiles + '\n' + openSnapshot, state.context);
  state.init();
  const file = { name: 'synthetic.xlsx' };
  state.mark(file);
  await (state.context.addFiles as (files: object[]) => Promise<void>)([file]);
  assert.equal(state.invoices().length, 1);
  assert.equal(S.invs.length, 1);
  state.ack(true);
  const bad = { name: 'bad.xlsx' }; state.mark(bad);
  await (state.context.addFiles as (files: object[]) => Promise<void>)([bad]);
  assert.equal(state.invoices().length, 1);
  assert.equal(S.log.at(-1)!.ok, false);
  const snapshot = { name: 'synthetic.json', text: async () => JSON.stringify({ kind: 'kts-rent-snapshot', saved: new Date().toISOString(), invs: [invoice({ no: 'SYNTHETIC-SNAPSHOT' })] }) };
  state.mark(snapshot, 'fSnap');
  await (state.context.openSnapshot as (file: object) => Promise<void>)(snapshot);
  assert.equal(state.invoices().length, 2);
  state.ack(true);
  const badSnapshot = { name: 'broken.json', text: async () => '{bad json' }; state.mark(badSnapshot, 'fSnap');
  await (state.context.openSnapshot as (file: object) => Promise<void>)(badSnapshot);
  assert.equal(state.invoices().length, 2);
  assert.equal(S.log.at(-1)!.ok, false);
  await (state.context.openSnapshot as (file: object) => Promise<void>)({ ...snapshot }); // automatic restoration, a different File identity
  assert.equal(state.invoices().length, 2);
  state.context.DEMO = true;
  const demo = { name: 'demo.xlsx' }; state.mark(demo);
  await (state.context.addFiles as (files: object[]) => Promise<void>)([demo]);
  assert.equal(state.invoices().length, 2);
});
