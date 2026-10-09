import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

import { dashboardProfitabilityBridgeScript, PROFITABILITY_AUDIT_MARKER } from '../src/shared/lib/dashboardProfitabilityBridge';
import { parseProfitabilityAuditRequest } from '../src/shared/lib/dashboardProfitabilityAudit';
import { buildTopDashboardContentSecurityPolicy, createTopDashboardFrameBridgeScript, detectTopDashboardDataContract,
  getTopDashboardDataAdapterScript, injectTopDashboardDataAdapter } from '../src/shared/lib/topDashboardContentSecurity';

const exampleInvoice = () => ({ schemaVersion: 1, documentType: 'invoice', invoiceNumber: 'SYNTHETIC-42', currency: 'USD', dealAmount: 125.5, amountSource: 'document', lines: [{ nomenclature: 'Synthetic item', quantity: 2 }] });
const marker = PROFITABILITY_AUDIT_MARKER;
const eventId = 'synthetic_event_00001';

function fixture(fetchImpl?: (body: string) => Promise<Response>) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const frameHandlers = new Map<string, () => void>();
  const messages: Array<Record<string, unknown>> = [];
  const parentMessages: Array<Record<string, unknown>> = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const timers = new Map<number, { fn: () => void; ms: number }>(); let nextTimer = 1;
  const notice = { hidden: true, dataset: {} as Record<string, string>, style: { cssText: '', background: '', color: '' }, textContent: '', setAttribute() {} };
  class Frame { contentWindow = { postMessage(message: Record<string, unknown>, origin: string) { assert.equal(origin, '*'); messages.push(message); } }; addEventListener(type: string, handler: () => void) { frameHandlers.set(type, handler); } }
  const frame = new Frame();
  const context = vm.createContext({ frame, HTMLIFrameElement: Frame, Map, Set, Uint8Array, TextEncoder, AbortController, Promise,
    crypto: webcrypto, document: { createElement: () => notice, body: { appendChild() {} } },
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return fetchImpl ? fetchImpl(String(init.body)) : Response.json({ ok: true });
    },
    window: { parent: {postMessage(message: Record<string, unknown>, origin: string) { assert.equal(origin, 'https://synthetic.test'); parentMessages.push(message); }}, location: {origin:'https://synthetic.test'}, addEventListener(type: string, handler: (event: Record<string, unknown>) => void) { handlers.set(type, handler); },
      setTimeout(fn: () => void, ms: number) { const id = nextTimer++; timers.set(id, { fn, ms }); return id; }, clearTimeout(id: number) { timers.delete(id); } },
  });
  vm.runInContext(dashboardProfitabilityBridgeScript('frame', { dashboardKey: 'top:42', versionId: 19, preview: false }), context);
  const nonce = () => String(messages.filter(value => value.type === 'init').at(-1)?.nonce);
  const send = (data: Record<string, unknown>, origin = 'null', source: unknown = frame.contentWindow) => handlers.get('message')?.({ source, origin, data });
  return { frame, notice, messages, parentMessages, requests, timers, nonce, send,
    invoice: (invoice = exampleInvoice(), id = eventId) => send({ marker, type: 'invoice', nonce: nonce(), eventId: id, invoice }),
    load: () => frameHandlers.get('load')?.(),
    acks: () => messages.filter(value => value.type === 'ack'),
    async retry() { const timer = [...timers].find(([, value]) => value.ms < 30000); assert.ok(timer, 'a bounded retry was scheduled'); timers.delete(timer[0]); timer[1].fn(); },
  };
}

async function until(predicate: () => boolean) {
  for (let count = 0; count < 200; count++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.ok(predicate(), 'asynchronous bridge state reached the expected result');
}

test('invoice bridge accepts only validated opaque child messages and pins API identity', async () => {
  const state = fixture();
  const message = { marker, type: 'invoice', nonce: state.nonce(), eventId, invoice: exampleInvoice() };
  state.send(message, 'https://example.test');
  state.send(message, 'null', {});
  state.send({ ...message, nonce: 'wrong_nonce' });
  state.send({ marker, type: 'ack', nonce: state.nonce(), eventId, ok: true });
  assert.equal(state.requests.length, 0);
  state.send({ ...message, dashboardKey: 'top:999' });
  assert.equal(state.acks().at(-1)?.ok, false, 'report cannot set the trusted envelope');
  state.invoice();
  await until(() => state.acks().some(message => message.ok === true));
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].url, '/api/admin/dashboard-usage/profitability');
  assert.equal(state.requests[0].init.credentials, 'same-origin');
  assert.equal(state.requests[0].init.redirect, 'error');
  const body = parseProfitabilityAuditRequest(JSON.parse(String(state.requests[0].init.body)));
  assert.deepEqual(body, { eventId, dashboardKey: 'top:42', versionId: 19, preview: false, invoice: exampleInvoice() });
  assert.ok(!Object.hasOwn(body, 'actor') && !Object.hasOwn(body, 'createdAt'));
  assert.match(state.notice.textContent, /сохранена/);
});

test('only trusted pending state is relayed to the top page and transport failures cannot hide unsaved details', async () => {
  const state=fixture(async()=>new Response('',{status:409}));
  const status={marker,type:'status',nonce:state.nonce(),pending:true};
  assert.equal(state.parentMessages.at(-1)!.pending,false);
  state.send(status,'https://synthetic.test'); state.send(status,'null',{});
  state.send({...status,nonce:'wrong'}); state.send({...status,pending:'true'});
  assert.equal(state.parentMessages.at(-1)!.pending,false);
  state.send(status);
  assert.equal(state.parentMessages.at(-1)!.pending,true);
  assert.deepEqual(Object.keys(state.parentMessages.at(-1)!).sort(),['marker','pending','type']);
  state.send({...status,pending:false});
  assert.equal(state.parentMessages.at(-1)!.pending,false);
  state.invoice(); await until(()=>state.acks().length===1);
  state.send({...status,pending:false});
  assert.equal(state.parentMessages.at(-1)!.pending,true,'failed durable write remains unsaved');
  state.load(); assert.equal(state.parentMessages.at(-1)!.pending,false);
});

test('durable ACK waits for API, retries same event, and coalesces duplicates', async () => {
  let resolveSecond: ((response: Response) => void) | undefined;
  let attempts = 0;
  const state = fixture(async () => ++attempts === 1 ? new Response('', { status: 503 })
    : new Promise<Response>(resolve => { resolveSecond = resolve; }));
  state.invoice();
  await until(() => [...state.timers.values()].some(value => value.ms === 1000));
  assert.equal(state.acks().length, 0, 'no ACK before durable success');
  state.invoice();
  await state.retry();
  await until(() => state.requests.length === 2);
  assert.equal(state.requests[0].init.body, state.requests[1].init.body, 'retry is idempotent and carries identical event ID');
  assert.equal(state.acks().length, 0);
  resolveSecond?.(Response.json({ ok: true, eventId }));
  await until(() => state.acks().some(message => message.ok === true));
  state.invoice();
  await until(() => state.acks().filter(message => message.ok === true).length === 2);
  assert.equal(state.requests.length, 2, 'successful duplicate ACK does not create another request');
  state.invoice({ ...exampleInvoice(), dealAmount: 999 });
  await until(() => state.acks().at(-1)?.ok === false);
  assert.equal(state.requests.length, 2, 'same event ID cannot be reused for different financial data');
});

test('invalid/oversized details never reach API; permanent errors remain visible', async () => {
  const state = fixture(async () => new Response('', { status: 409 }));
  state.invoice({ ...exampleInvoice(), lines: [{ nomenclature: 'bad', quantity: Number.NaN }] });
  state.invoice({ ...exampleInvoice(), lines: Array.from({ length: 1000 }, () => ({ nomenclature: '界'.repeat(500), quantity: 1 })) }, 'synthetic_oversize_01');
  assert.equal(state.requests.length, 0);
  assert.equal(state.acks().length, 2);
  assert.ok(state.acks().every(message => message.ok === false));
  state.invoice(exampleInvoice(), 'synthetic_conflict_01');
  await until(() => state.requests.length === 1 && state.acks().length === 3);
  assert.equal(state.acks().at(-1)?.ok, false);
  assert.equal(state.notice.dataset.kind, 'error');
  assert.match(state.notice.textContent, /не принята/);
  assert.equal([...state.timers.values()].filter(value => value.ms < 30000).length, 0, 'permanent failure is not retried blindly');
});

test('navigation rotates nonce and never ACKs stale content after in-flight completion', async () => {
  let resolveRequest: ((response: Response) => void) | undefined;
  const state = fixture(async () => new Promise<Response>(resolve => { resolveRequest = resolve; }));
  const oldNonce = state.nonce();
  state.invoice();
  await until(() => state.requests.length === 1);
  state.load();
  assert.notEqual(state.nonce(), oldNonce);
  state.send({ marker, type: 'invoice', nonce: oldNonce, eventId, invoice: exampleInvoice() });
  resolveRequest?.(Response.json({ ok: true }));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(state.acks().length, 0);
  assert.equal(state.requests.length, 1);
});

test('financial bridge is opt-in; local invoice mode disables shared-file capture and restoration', () => {
  const ordinary = createTopDashboardFrameBridgeScript(1, 2, true);
  assert.doesNotMatch(ordinary, /kts-profitability-audit-v1/);
  const special = createTopDashboardFrameBridgeScript(1, 2, false, { preview: false });
  assert.match(special, /kts-profitability-audit-v1/);
  assert.match(special, /"preview":false/);
  assert.match(special, /CONFIG\.localInvoiceMode \|\| !CONFIG\.canManage/);
  assert.match(special, /if \(!CONFIG\.localInvoiceMode\) \{\s+prefetchPromise/);
  const local = getTopDashboardDataAdapterScript(null, null, true, null, true);
  assert.match(local, /const LOCAL_INVOICE_MODE = true/);
  assert.match(local, /const READ_ONLY = false/);
  assert.match(local, /if \(!data \|\| typeof data !== 'object' \|\| LOCAL_INVOICE_MODE\) return/);
  assert.throws(() => dashboardProfitabilityBridgeScript('frame;fetch("bad")', { dashboardKey: 'top:1', versionId: 2, preview: false }));
});

test('unknown profitability versions fail closed instead of generic sharing; blob modules require an explicit scoped opt-in', () => {
  const candidate='<html><head><title>Рентабельность счетов</title></head><body><input type="file" id="fInv"><script>const format="kts-rent-snapshot";</script></body></html>';
  assert.equal(detectTopDashboardDataContract(candidate).profile,'profitability-unsupported');
  assert.equal(detectTopDashboardDataContract(candidate).mode,'disabled');
  const html=injectTopDashboardDataAdapter(candidate,{readOnly:false,localInvoiceMode:true});
  assert.match(html,/const READ_ONLY = true/); assert.match(html,/const LOCAL_INVOICE_MODE = false/);
  const blocked=createTopDashboardFrameBridgeScript(1,2,true,{preview:true,auditEnabled:false});
  assert.doesNotMatch(blocked,/kts-profitability-audit-v1/);
  assert.match(blocked,/"localInvoiceMode":true/);
  const defaultPolicy=buildTopDashboardContentSecurityPolicy(html);
  assert.doesNotMatch(defaultPolicy,/script-src[^;]*blob:/);
  const special=buildTopDashboardContentSecurityPolicy(html,{allowBlobModules:true});
  assert.match(special,/script-src blob:/); assert.match(special,/connect-src 'none'/);
  assert.doesNotMatch(special,/unsafe-eval|allow-same-origin|https:/);
});
