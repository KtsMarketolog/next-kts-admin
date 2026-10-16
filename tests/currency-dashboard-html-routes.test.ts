import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { AdminSession } from '../src/shared/lib/adminAuth';
import * as access from '../src/shared/lib/currencyDashboardAccess';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';

const URL = 'https://example.test/api/admin/currency-dashboard/html';
const admin: AdminSession = { role: 'admin', adminUserId: 1, sessionId: 'test' };
class CurrencyHtmlError extends Error { constructor(message: string, readonly code = 'CURRENCY_HTML_INVALID', readonly status = 400) { super(message); } }
class CurrencyHtmlConflictError extends CurrencyHtmlError { constructor(readonly currentRevision: number) { super('Conflict', 'CURRENCY_HTML_CONFLICT', 409); } }
const state = { revision: 1, activeVersionId: 2, previousVersionId: 1, versions: [] };
function harness(session: AdminSession | null = admin) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string, value: unknown) => async (...args: unknown[]) => { calls.push({ name, args }); return value; };
  let compatible = true;
  let auditFails = false;
  const modules: Record<string, unknown> = {
    '@/shared/lib/adminAuth': { getAdminSession: async () => session },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => null },
    '@/shared/lib/currencyDashboardAccess': access,
    '@/shared/lib/currencyDashboardHtmlUpload': {
      getBuiltinCurrencyDashboardHtmlSeed: () => ({ current: { htmlContent: '<html>builtin</html>', originalName: 'builtin.html', sourceVersion: 'V25' } }),
      inspectCurrencyDashboardUpload: (html: string) => { calls.push({ name: 'inspect', args: [html] }); if (!compatible) throw new Error('Unsupported HTML'); return { sourceVersion: 'V26' }; },
    },
    '@/shared/lib/db/currencyDashboardHtmlRepo': {
      CURRENCY_HTML_MAX_BYTES: 2 * 1024 * 1024, CurrencyHtmlError, CurrencyHtmlConflictError,
      createCurrencyDashboardHtmlVersion: record('create', { ...state, version: { id: 3, sourceVersion: 'V26' } }),
      ensureCurrencyDashboardHtmlSeed: record('seed', undefined),
      getCurrencyDashboardHtmlState: record('state', state),
      getCurrencyDashboardHtmlVersion: record('version', { htmlContent: '<html>draft</html>', version: { id: 3 } }),
      publishCurrencyDashboardHtmlVersion: record('publish', { ...state, revision: 2, activeVersionId: 3 }),
      rollbackCurrencyDashboardHtmlVersion: record('rollback', { ...state, revision: 2, activeVersionId: 1 }),
    },
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async (...args: unknown[]) => {
      calls.push({ name: 'audit', args });
      if (auditFails) throw new Error('synthetic audit failure after commit');
    } },
    '@/shared/lib/originProtection': { enforceSameOriginRequest },
  };
  const exports: Record<string, (request: Request) => Promise<Response>> = {};
  const source = readFileSync('src/app/api/admin/currency-dashboard/html/route.ts', 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, { exports, require: (name: string) => { if (!(name in modules)) throw new Error(`Unexpected module ${name}`); return modules[name]; },
    Request, Response, URL: globalThis.URL, Buffer, TextDecoder, console: { error: () => {} }, Error });
  return { exports, calls, incompatible: () => { compatible = false; }, auditFails: () => { auditFails = true; } };
}
function upload(content = '<html>currency V26</html>', filename = 'currency.html', origin = 'https://example.test') {
  const form = new FormData();
  form.set('file', new File([content], filename, { type: 'text/html' }));
  return new Request(URL, { method: 'POST', headers: { Origin: origin }, body: form });
}
function patch(body: unknown, origin = 'https://example.test') {
  return new Request(URL, { method: 'PATCH', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('HTML management GET and mutations reject readers and missing persisted sessions before database operations', async () => {
  for (const session of [null, { role: 'admin' }, { role: 'purchaser', adminUserId: 5, sessionId: 'x', dashboardAccess: ['currency-rates'] },
    { role: 'top', adminUserId: 5, sessionId: 'x', dashboardAccess: ['currency-rates'] },
    { role: 'manager', managerId: 2, sessionId: 'x', dashboardAccess: ['currency-rates'] }] as Array<AdminSession | null>) {
    for (const method of ['GET', 'POST', 'PATCH']) {
      const h = harness(session);
      const response = await h.exports[method](method === 'GET' ? new Request(URL) : method === 'POST' ? upload() : patch({ action: 'rollback', expectedRevision: 1 }));
      assert.equal(response.status, session ? 403 : 401);
      assert.match(response.headers.get('Cache-Control')!, /no-store/);
      assert.deepEqual(h.calls, []);
    }
  }
});

test('HTML management accepts existing management grants only, never elevates view permissions', async () => {
  for (const role of ['admin', 'admintop', 'top', 'manager', 'support_manager'] as const) {
    const h = harness({ role, adminUserId: 3, managerId: 9, sessionId: 'test', canManageTopDashboard: true });
    assert.equal((await h.exports.POST(upload())).status, 201);
    const created = h.calls.find((call) => call.name === 'create')!.args[0] as { actor: string };
    assert.equal(created.actor, `${role}:${role === 'manager' || role === 'support_manager' ? 9 : 3}`);
    assert.equal(h.calls.some((call) => call.name === 'publish'), false);
  }
});

test('HTML upload is staged, same-origin, streamed-size-bounded and UTF-8 only', async () => {
  const h = harness();
  const response = await h.exports.POST(upload());
  assert.equal(response.status, 201);
  assert.equal((await response.json()).activeVersionId, 2);
  assert.deepEqual(h.calls.map((call) => call.name), ['inspect', 'seed', 'create', 'audit']);
  for (const request of [upload('x', 'file.json'), upload('x', 'file.html', 'https://evil.test'),
    new Request(URL, { method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': String(4 * 1024 * 1024) }, body: 'x' }),
    upload('x'.repeat(2 * 1024 * 1024 + 1)),
    new Request(URL, { method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'text/plain' }, body: 'x' })]) {
    const invalid = harness();
    assert.ok((await invalid.exports.POST(request)).status >= 400);
    assert.deepEqual(invalid.calls, []);
  }
  const bad = new FormData(); bad.set('file', new File([Uint8Array.from([255, 254])], 'bad.html'));
  assert.equal((await harness().exports.POST(new Request(URL, { method: 'POST', headers: { Origin: 'https://example.test' }, body: bad }))).status, 400);
});

test('unknown or incompatible HTML never reaches seeding, storage or publication', async () => {
  const h = harness(); h.incompatible();
  const response = await h.exports.POST(upload());
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'CURRENCY_HTML_INCOMPATIBLE');
  assert.deepEqual(h.calls.map((call) => call.name), ['inspect']);
  for (const fields of [['file', 'file'], ['file', 'html']]) {
    const form = new FormData();
    for (const field of fields) form.append(field, new File(['<html/>'], 'a.html'));
    const checked = harness();
    assert.equal((await checked.exports.POST(new Request(URL, { method: 'POST', headers: { Origin: 'https://example.test' }, body: form }))).status, 400);
    assert.deepEqual(checked.calls, []);
  }
});

test('HTML publish/rollback require a fresh exact revision and revalidate stored contents', async () => {
  for (const action of ['publish', 'rollback']) {
    const body = { action, expectedRevision: 1, ...(action === 'publish' ? { versionId: 3 } : {}) };
    const h = harness();
    assert.equal((await h.exports.PATCH(patch(body))).status, 200);
    assert.deepEqual(h.calls.map((call) => call.name), ['seed', 'state', 'version', 'inspect', action, 'audit']);
    const stale = harness();
    const response = await stale.exports.PATCH(patch({ ...body, expectedRevision: 0 }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).revision, 1);
    assert.deepEqual(stale.calls.map((call) => call.name), ['seed', 'state']);
    const incompatible = harness(); incompatible.incompatible();
    assert.equal((await incompatible.exports.PATCH(patch(body))).status, 400);
    assert.equal(incompatible.calls.some((call) => call.name === action), false);
  }
});

test('HTML control API rejects forged fields, ambiguous selectors and cross-origin changes', async () => {
  for (const body of [null, [], { action: 'publish', versionId: 3, expectedRevision: '1' },
    { action: 'publish', versionId: -1, expectedRevision: 1 }, { action: 'delete', expectedRevision: 1 },
    { action: 'rollback', expectedRevision: 1, versionId: 2 }, { action: 'publish', versionId: 3, expectedRevision: 1, htmlContent: 'injected' }]) {
    const h = harness(); assert.equal((await h.exports.PATCH(patch(body))).status, 400); assert.deepEqual(h.calls, []);
  }
  const forbidden = harness();
  assert.equal((await forbidden.exports.PATCH(patch({ action: 'rollback', expectedRevision: 1 }, 'https://evil.test'))).status, 403);
  assert.deepEqual(forbidden.calls, []);
  assert.equal((await harness().exports.GET(new Request(`${URL}?html=3`))).status, 400);
  assert.equal('DELETE' in harness().exports, false);
});

test('a post-commit audit failure does not misreport a successful HTML save or publication', async () => {
  for (const operation of ['upload', 'publish', 'rollback']) {
    const h = harness(); h.auditFails();
    const response = operation === 'upload' ? await h.exports.POST(upload())
      : await h.exports.PATCH(patch({ action: operation, expectedRevision: 1, ...(operation === 'publish' ? { versionId: 3 } : {}) }));
    assert.equal(response.status, operation === 'upload' ? 201 : 200);
    assert.equal((await response.json()).revision, operation === 'upload' ? 1 : 2);
  }
});
