import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as protocol from '../src/shared/lib/dashboardProfitabilityAudit';
import { parseDashboardUsageBatch } from '../src/shared/lib/dashboardUsage';

const invoice: protocol.ProfitabilityInvoice = { schemaVersion: 1, documentType: 'invoice', invoiceNumber: 'Тест-1', currency: 'CNY',
  dealAmount: 123.45, amountSource: 'document', lines: [{ nomenclature: 'Тестовая позиция', quantity: 0.125 }] };
const payload: protocol.ProfitabilityAuditRequest = { eventId: 'test_invoice_event_0001', dashboardKey: 'top:9', versionId: 42, preview: false, invoice };
test('invoice protocol preserves original currency and fractional quantity, missing values are explicit', () => {
  assert.deepEqual(protocol.parseProfitabilityAuditRequest(payload), payload);
  assert.deepEqual(protocol.parseProfitabilityInvoice({ ...invoice, invoiceNumber: null, dealAmount: null, amountSource: 'unavailable' }).dealAmount, null);
  assert.equal(protocol.parseProfitabilityInvoice({ ...invoice, dealAmount: -12, lines: [{ nomenclature: 'Возврат', quantity: -1 }] }).dealAmount, -12);
});
test('invoice protocol refuses private extras, ambiguous values, oversized and nonfinite fields', () => {
  const invalid = [
    { ...payload, actor: 'admin:1' }, { ...payload, createdAt: '2026-01-01' }, { ...payload, preview: 'false' },
    { ...payload, versionId: 1.5 }, { ...payload, dashboardKey: 'manager:support' }, { ...payload, eventId: 'short' },
    ...[
      { ...invoice, rawFile: 'secret' }, { ...invoice, currency: 'руб.' }, { ...invoice, currency: null },
      { ...invoice, documentType: ['invoice'] }, { ...invoice, amountSource: ['document'] },
      { ...invoice, dealAmount: NaN }, { ...invoice, dealAmount: Infinity }, { ...invoice, dealAmount: 1e16 },
      { ...invoice, dealAmount: '123.45' }, { ...invoice, dealAmount: null }, { ...invoice, amountSource: 'unavailable' },
      { ...invoice, invoiceNumber: 'n'.repeat(201) }, { ...invoice, lines: [] },
      { ...invoice, lines: Array.from({ length: 1001 }, () => invoice.lines[0]) },
      { ...invoice, lines: [{ nomenclature: 'N', quantity: 1, cost: 99 }] },
      { ...invoice, lines: [{ nomenclature: '', quantity: 1 }] },
      { ...invoice, lines: [{ nomenclature: 'N'.repeat(501), quantity: 1 }] },
      { ...invoice, lines: [{ nomenclature: 'N', quantity: '1' }] },
      { ...invoice, lines: [{ nomenclature: 'N', quantity: Infinity }] },
    ].map((value) => ({ ...payload, invoice: value })),
  ];
  for (const value of invalid) assert.throws(() => protocol.parseProfitabilityAuditRequest(value), /Некорректная детализация/);
  assert.throws(() => parseDashboardUsageBatch({ dashboardKey: 'top:9', versionId: 42, preview: false, events: [{ id: payload.eventId, action: 'data_loaded', invoice }] }));
});

const routeCode = ts.transpileModule(readFileSync('src/app/api/admin/dashboard-usage/profitability/route.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function harness(options: { role?: string | null; failure?: number; limited?: boolean; missing?: boolean } = {}) {
  let writes = 0, reads = 0;
  const errors: string[] = [];
  class ProfitabilityAuditError extends Error { constructor(message: string, public status: number) { super(message); } }
  const modules: Record<string, unknown> = {
    '@/shared/lib/adminAuth': { getAdminSession: async () => options.role === null ? null : { role: options.role || 'admin', sessionId: 'server-session' } },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => options.limited ? new Response(null, { status: 429 }) : null },
    '@/shared/lib/dashboardUsageAccess': { canReviewDashboardUsage: (session: { role: string }) => ['admin', 'top', 'admintop'].includes(session.role) },
    '@/shared/lib/dashboardProfitabilityAudit': protocol,
    '@/shared/lib/originProtection': { enforceSameOriginRequest: (request: Request) => request.headers.get('origin') === 'https://kts.test' ? null : new Response(null, { status: 403 }) },
    '@/shared/lib/db/dashboardProfitabilityAuditRepo': {
      ProfitabilityAuditError,
      recordDashboardProfitabilityAudit: async (_session: unknown, input: unknown) => {
        writes++; assert.equal(JSON.stringify(input), JSON.stringify(payload));
        if (options.failure) throw options.failure === 503 ? new Error('private SQL') : new ProfitabilityAuditError('Нет доступа', options.failure);
        return { id: '777' };
      },
      readDashboardProfitabilityAudit: async () => { reads++; return options.missing ? null : invoice; },
    },
  };
  const exports: Record<string, (request: Request) => Promise<Response>> = {};
  runInNewContext(routeCode, { exports, Buffer, Response, URL, TextDecoder, setTimeout, clearTimeout, RangeError,
    console: { error: (message: string) => errors.push(message) }, require: (name: string) => { assert.ok(name in modules, name); return modules[name]; } });
  return { exports, errors, writes: () => writes, reads: () => reads };
}
function request(body: string = JSON.stringify(payload), headers: Record<string, string> = {}) {
  return new Request('https://kts.test/api/admin/dashboard-usage/profitability', { method: 'POST',
    headers: { origin: 'https://kts.test', 'content-type': 'application/json', ...headers }, body });
}
test('audit endpoint ACK only after persistence, no secrets in transient errors', async () => {
  const good = harness(); const response = await good.exports.POST(request());
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, id: '777' });
  assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(good.writes(), 1);
  for (const status of [403, 409, 503]) {
    const h = harness({ failure: status }); const r = await h.exports.POST(request());
    assert.equal(r.status, status); assert.doesNotMatch(await r.text(), /private SQL/);
    assert.ok(h.errors.every((message) => message === 'PROFITABILITY_AUDIT_WRITE_FAILED'));
  }
});
test('audit endpoint bounds chunked input and rejects auth/origin/type/shape before writes', async () => {
  for (const [options, req, status] of [
    [{ role: null }, request(), 401], [{}, request(undefined, { origin: 'https://other.test' }), 403],
    [{}, request(undefined, { 'content-type': 'text/plain' }), 415], [{ limited: true }, request(), 429],
    [{}, request('{broken'), 400], [{}, request(JSON.stringify({ ...payload, user: 'fake' })), 400],
    [{}, request('x'.repeat(protocol.MAX_PROFITABILITY_AUDIT_BODY + 1)), 413],
  ] as const) {
    const h = harness(options); assert.equal((await h.exports.POST(req)).status, status); assert.equal(h.writes(), 0);
  }
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(protocol.MAX_PROFITABILITY_AUDIT_BODY + 1)); }, cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  const h = harness();
  const req = new Request('https://kts.test/api/admin/dashboard-usage/profitability', { method: 'POST', body: stream, duplex: 'half', headers: { origin: 'https://kts.test', 'content-type': 'application/json', 'content-length': '0' } } as RequestInit);
  assert.equal((await h.exports.POST(req)).status, 413); assert.equal(cancelled, true); assert.equal(stream.locked, false); assert.equal(h.writes(), 0);
});
test('invoice details are only readable by admin, TOP and adminTOP within retention', async () => {
  for (const role of ['admin', 'top', 'admintop', 'manager', 'support_manager', 'purchaser', null]) {
    const h = harness({ role }); const response = await h.exports.GET(new Request('https://kts.test/api/admin/dashboard-usage/profitability?id=777'));
    const allowed = role && ['admin', 'top', 'admintop'].includes(role);
    assert.equal(response.status, allowed ? 200 : role ? 403 : 401); assert.equal(h.reads(), allowed ? 1 : 0);
  }
  const h = harness({ missing: true }); assert.equal((await h.exports.GET(new Request('https://kts.test/api/admin/dashboard-usage/profitability?id=777'))).status, 404);
  assert.equal((await h.exports.GET(new Request('https://kts.test/api/admin/dashboard-usage/profitability?id=NaN'))).status, 400);
});
