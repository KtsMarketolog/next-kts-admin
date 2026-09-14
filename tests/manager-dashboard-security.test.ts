import assert from 'node:assert/strict';
import { createCipheriv, createHash, pbkdf2Sync, webcrypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createContext, runInContext, Script, type Context } from 'node:vm';
import test from 'node:test';

import type { AdminSession } from '../src/shared/lib/adminAuth';
import {
  buildPersonalDashboardFrame,
  getPersonalDashboardAdapterScript,
  injectPersonalDashboardAdapter,
  isPersonalDashboardHtml,
  personalHtmlCsp,
  type PersonalDashboardEmptyState,
} from '../src/shared/lib/managerDashboardHtml';
import {
  parsePersonalDashboardId,
  personalDashboardFreshness,
  personalDashboardFrameSelection,
  personalDashboardMode,
  readPersonalRequestBytes,
} from '../src/shared/lib/managerDashboardSecurity';

test('personal dashboard requires a persisted session and explicit allowed employee roles', () => {
  const sessionId = 'synthetic-session';
  assert.equal(personalDashboardMode(null), null);
  for (const role of ['admin', 'admintop', 'manager', 'support_manager', 'top', 'wholesale_admin'] as const) {
    assert.equal(personalDashboardMode({ role, adminUserId: 1, managerId: 2 }), null, `${role} legacy cookie`);
  }
  assert.equal(personalDashboardMode({ role: 'admin', sessionId }), 'manage');
  assert.equal(personalDashboardMode({ role: 'admintop', sessionId, adminUserId: 1 }), 'manage');
  assert.equal(personalDashboardMode({ role: 'manager', sessionId, managerId: 2 }), 'view');
  for (const role of ['support_manager', 'top', 'wholesale_admin'] as const) {
    assert.equal(personalDashboardMode({ role, sessionId, adminUserId: 1, managerId: 2, canAccessTopDashboard: true, canManageTopDashboard: true }), null);
  }
  for (const id of [undefined, 0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(personalDashboardMode({ role: 'manager', sessionId, managerId: id }), null);
    assert.equal(personalDashboardMode({ role: 'admintop', sessionId, adminUserId: id }), null);
  }
  assert.equal(personalDashboardMode({ role: 'client', sessionId } as unknown as AdminSession), null);
});

test('personal IDs reject coercions, traversal, overflow and ambiguous spellings', () => {
  for (const id of [null, '', '0', '-1', '+1', ' 1', '1 ', '01', '1.0', '1e2', 'Infinity', 'NaN', '9007199254740992', '1/../2', '1?managerId=2', '1\n']) {
    assert.equal(parsePersonalDashboardId(id), null, String(id));
  }
  assert.equal(parsePersonalDashboardId('1'), 1);
  assert.equal(parsePersonalDashboardId(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

test('snapshot freshness follows Moscow midnight and inclusive expiry dates', () => {
  const snapshot = { issued: '2026-09-14', expires: '2026-09-14' };
  assert.equal(personalDashboardFreshness(snapshot, new Date('2026-09-14T20:59:59Z')).snapshotStatus, 'current');
  assert.equal(personalDashboardFreshness(snapshot, new Date('2026-09-14T21:00:00Z')).snapshotStatus, 'expired');
  const stale = personalDashboardFreshness({ ...snapshot, expires: '2026-10-01' }, new Date('2026-09-14T21:00:00Z'));
  assert.equal(stale.snapshotStatus, 'stale');
  assert.equal(stale.todayMoscow, '2026-09-15');
  assert.equal(personalDashboardFreshness(null).snapshotStatus, 'missing');
});

test('shared HTML selection stays available without a usable binding or snapshot, but never selects another manager data', () => {
  const now = new Date('2026-09-14T12:00:00Z');
  const snapshot = { id: 23, issued: '2026-09-14', expires: '2026-09-14' };
  const status = { bindingStatus: 'matched' as const, snapshot, history: [snapshot] };
  assert.deepEqual(personalDashboardFrameSelection(status, undefined, now), { snapshotId: 23 });
  assert.deepEqual(personalDashboardFrameSelection(status, 23, now), { snapshotId: 23 });
  assert.deepEqual(personalDashboardFrameSelection(status, 99, now), { denied: true });
  assert.deepEqual(personalDashboardFrameSelection({ ...status, snapshot: null, history: [] }, undefined, now), { emptyState: 'no_snapshot' });
  assert.deepEqual(personalDashboardFrameSelection(status, 23, new Date('2026-09-14T21:00:00Z')), { emptyState: 'expired' });
  for (const bindingStatus of ['missing_email', 'ambiguous_email'] as const) {
    // Even stale metadata cannot make the frame fetch bytes without a binding.
    assert.deepEqual(personalDashboardFrameSelection({ ...status, bindingStatus }, 23, now), { emptyState: bindingStatus });
  }
});

function streamRequest(chunks: Uint8Array[], contentLength?: string) {
  const observed = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[observed.pulls++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { observed.cancelled = true; },
  });
  const request = new Request('https://example.test/upload', {
    method: 'POST', body, duplex: 'half',
    headers: contentLength === undefined ? {} : { 'content-length': contentLength },
  } as RequestInit & { duplex: 'half' });
  return { request, observed };
}

test('bounded request reader rejects declared oversize and malformed lengths before consuming a body', async () => {
  for (const length of ['9', '-1', '1.5', '1e2', '+1', '99999999999999999999999999999']) {
    const { request } = streamRequest([new Uint8Array([1])], length);
    await assert.rejects(readPersonalRequestBytes(request, 8), /REQUEST_TOO_LARGE/);
    assert.equal(request.bodyUsed, false);
  }
});

test('bounded request reader enforces actual streamed bytes even with absent or false Content-Length', async () => {
  for (const declared of [undefined, '0', '2']) {
    const { request, observed } = streamRequest([new Uint8Array(4), new Uint8Array(5), new Uint8Array(4)], declared);
    await assert.rejects(readPersonalRequestBytes(request, 8), /REQUEST_TOO_LARGE/);
    assert.equal(observed.cancelled, true);
    assert.equal(request.body?.locked, false);
  }
  const { request } = streamRequest([new Uint8Array([1, 2]), new Uint8Array([3, 4])], '4');
  assert.deepEqual(await readPersonalRequestBytes(request, 4), new Uint8Array([1, 2, 3, 4]));
  assert.equal(request.body?.locked, false);
  assert.equal((await readPersonalRequestBytes(new Request('https://example.test'), 4)).length, 0);
});

const fixtureHtml = `<!doctype html><html lang="ru"><head><title>Synthetic personal dashboard</title></head><body><script>
let FILE = null;
const fmt = 'kts-personal';
function gate() { document.body.innerHTML = '<input id="fileInp"><input id="email"><input id="pass"><button id="go">Open</button>'; }
async function decryptFile() { return { emailHash: '' }; }
async function tryOpen() {}
gate();
</script></body></html>`;

test('personal HTML contract accepts the dynamic v12 file gate and rejects unrelated dashboards', () => {
  assert.equal(isPersonalDashboardHtml(fixtureHtml), true);
  assert.equal(isPersonalDashboardHtml('<html><body><input type="file"></body></html>'), false);
  for (const missing of ['gate', 'tryOpen', 'decryptFile', 'fileInp', 'FILE', 'emailHash', 'kts-personal']) {
    assert.equal(isPersonalDashboardHtml(fixtureHtml.replaceAll(missing, 'replaced')), false, missing);
  }
  assert.throws(() => injectPersonalDashboardAdapter('<html>unrelated</html>'), /контракт/);
});

test('personal HTML injection keeps source calculations and adds parseable sandboxed adapters after the source', () => {
  const output = injectPersonalDashboardAdapter(fixtureHtml);
  assert.ok(output.indexOf('data-kts-personal-adapter') > output.indexOf('gate();'));
  assert.ok(output.indexOf('data-kts-personal-adapter') < output.lastIndexOf('</body>'));
  assert.ok(output.includes(fixtureHtml.slice(0, fixtureHtml.indexOf('</body>'))));
  for (const script of output.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new Script(script[1]);
  const csp = personalHtmlCsp(output);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /(?:^|; )sandbox allow-scripts(?:;|$)/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-popups|'unsafe-eval'/);
  assert.match(csp, /script-src 'sha256-/);
  assert.match(output, /const READ_ONLY = true/);
});

type Message = { source: unknown; origin?: string; data: Record<string, unknown> };
type Element = { value: string; disabled: boolean; readOnly: boolean; autocomplete: string; placeholder: string; textContent: string; onclick?: unknown };

function adapterHarness() {
  const handlers = new Map<string, Array<(event: Message) => void>>();
  const parent = { postMessage: (message: unknown) => outbound.push(message) };
  const outbound: unknown[] = [];
  const elements = Object.fromEntries(['email', 'pass', 'fileInp', 'go', 'drop', 'note', 'intro'].map((id) => [id, {
    value: '', disabled: false, readOnly: false, autocomplete: '', placeholder: '', textContent: '',
  }])) as Record<string, Element>;
  const context = createContext({
    window: {
      parent,
      addEventListener(type: string, callback: (event: Message) => void) {
        handlers.set(type, [...(handlers.get(type) ?? []), callback]);
      },
    },
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      querySelector: (selector: string) => selector === '.gate .note' ? elements.note : elements.intro,
    },
    File, Blob, ArrayBuffer, Uint8Array, TextEncoder, TextDecoder, DecompressionStream,
    crypto: webcrypto, atob, btoa, Intl, Date,
  });
  runInContext(`
    let FILE = null; let D = null;
    const calls = {gate:0, unpack:0, render:0};
    function gate() { calls.gate++; document.getElementById('go').onclick = tryOpen; }
    async function decryptFile() { throw new Error('Original decrypt must be replaced'); }
    async function tryOpen() {
      const payload = await decryptFile(await FILE.text(), document.getElementById('email').value, document.getElementById('pass').value);
      D = unpack(payload); render();
    }
    function unpack(payload) { calls.unpack++; return payload.rows; }
    function render() { calls.render++; }
    gate();
  `, context);
  new Script(getPersonalDashboardAdapterScript()).runInContext(context);
  const send = (data: Record<string, unknown>, source: unknown = parent) => {
    for (const handler of handlers.get('message') ?? []) handler({ source, data });
  };
  return { context, elements, outbound, send, handlers, parent };
}

const EMAIL = 'manager@example.test';
const PASSWORD = 'synthetic-fixture-password';

function encryptedFixture(payloadOverride: Record<string, unknown> = {}, envelopeOverride: Record<string, unknown> = {}, gzip = true) {
  const payload = { email: EMAIL, issued: '2026-09-14', expires: '2099-12-31', cols: ['client', 'revenue'], rows: [['Synthetic client', 1250]], ...payloadOverride };
  const salt = Buffer.alloc(16, 4);
  const iv = Buffer.alloc(12, 7);
  const key = pbkdf2Sync(`${EMAIL}:${PASSWORD}`, salt, 200000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload));
  const ct = Buffer.concat([cipher.update(gzip ? gzipSync(plaintext) : plaintext), cipher.final(), cipher.getAuthTag()]);
  const envelope = {
    fmt: 'kts-personal', v: 1, gz: gzip,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 200000, salt: salt.toString('base64') },
    iv: iv.toString('base64'), ct: ct.toString('base64'),
    emailHash: createHash('sha256').update(EMAIL).digest('base64'),
    issued: payload.issued, expires: payload.expires, ...envelopeOverride,
  };
  const text = JSON.stringify(envelope);
  const bytes = new TextEncoder().encode(text).buffer;
  return { text, bytes, payload };
}

function bind(harness: ReturnType<typeof adapterHarness>, fixture: ReturnType<typeof encryptedFixture>) {
  harness.send({ marker: 'kts-personal-dashboard-v1', type: 'snapshot', bytes: fixture.bytes, email: ` ${EMAIL.toUpperCase()} `, originalName: 'synthetic.ktsp' });
}

async function decrypt(context: Context, text: string, email = EMAIL, password = PASSWORD) {
  Object.assign(context, { fixtureText: text, fixtureEmail: email, fixturePassword: password });
  return await runInContext('decryptFile(fixtureText, fixtureEmail, fixturePassword)', context) as Record<string, unknown>;
}

test('personal adapter only binds one snapshot from its parent and does not unlock before delivery', async () => {
  const fixture = encryptedFixture();
  const harness = adapterHarness();
  assert.equal(harness.elements.go.disabled, true);
  harness.send({ marker: 'kts-personal-dashboard-v1', type: 'snapshot', bytes: fixture.bytes, email: EMAIL, originalName: 'wrong.ktsp' }, {});
  await assert.rejects(decrypt(harness.context, fixture.text), /недоступен/);
  bind(harness, fixture);
  assert.equal(harness.elements.email.value, EMAIL);
  assert.equal(harness.elements.email.readOnly, true);
  assert.equal(harness.elements.fileInp.disabled, true);
  harness.send({ marker: 'kts-personal-dashboard-v1', type: 'snapshot', bytes: fixture.bytes, email: 'other@example.test', originalName: 'other.ktsp' });
  assert.equal(harness.elements.email.value, EMAIL);
  assert.equal(runInContext('FILE.name', harness.context), 'synthetic.ktsp');
});

const EMPTY_REASONS: PersonalDashboardEmptyState[] = ['missing_email', 'ambiguous_email', 'no_snapshot', 'expired'];

test('personal adapter displays the HTML gate without credentials or data in each empty state', async () => {
  const fixture = encryptedFixture();
  for (const reason of EMPTY_REASONS) {
    const harness = adapterHarness();
    const message = { marker: 'kts-personal-dashboard-v1', type: 'empty', reason };
    harness.send(message, {});
    harness.send({ ...message, reason: '__proto__' });
    assert.equal(runInContext('calls.gate', harness.context), 1);
    harness.elements.pass.value = PASSWORD;
    harness.send(message);
    assert.equal(runInContext('calls.gate', harness.context), 2);
    for (const field of ['email', 'pass', 'fileInp', 'go']) assert.equal(harness.elements[field].disabled, true, `${reason}/${field}`);
    assert.equal(harness.elements.pass.value, '');
    assert.equal(harness.elements.email.value, '');
    assert.match(harness.elements.note.textContent, /HTML дашборда доступен/);
    bind(harness, fixture);
    harness.send(message);
    assert.equal(runInContext('calls.gate', harness.context), 2);
    assert.equal(runInContext('FILE', harness.context), null);
    assert.equal(runInContext('D', harness.context), null);
    await assert.rejects(decrypt(harness.context, fixture.text), /недоступен/);
    assert.equal(runInContext('calls.render', harness.context), 0);
  }
});

test('personal adapter decrypts real AES-GCM/PBKDF2 gzip fixtures, preserves unpack/render and clears the entered password', async () => {
  for (const gzip of [true, false]) {
    const fixture = encryptedFixture({}, {}, gzip);
    const harness = adapterHarness();
    bind(harness, fixture);
    harness.elements.pass.value = PASSWORD;
    await runInContext('tryOpen()', harness.context);
    assert.equal(runInContext('calls.unpack', harness.context), 1);
    assert.equal(runInContext('calls.render', harness.context), 1);
    assert.equal(JSON.stringify(runInContext('D', harness.context)), JSON.stringify(fixture.payload.rows));
    assert.equal(harness.elements.pass.value, '');
    assert.equal(JSON.stringify(harness.outbound).includes(PASSWORD), false);
    assert.equal(JSON.stringify(harness.outbound).includes('Synthetic client'), false);
  }
});

test('personal adapter rejects wrong passwords and header/payload recipient or date mismatches', async () => {
  const fixture = encryptedFixture();
  const harness = adapterHarness();
  bind(harness, fixture);
  await assert.rejects(decrypt(harness.context, fixture.text, EMAIL, 'wrong'), /Пароль снимка/);
  await assert.rejects(decrypt(harness.context, fixture.text, 'other@example.test'), /недоступен/);
  const weakKdf = JSON.parse(fixture.text);
  weakKdf.kdf.iter = 199999;
  await assert.rejects(decrypt(harness.context, JSON.stringify(weakKdf)), /Неподдерживаемые параметры/);
  for (const [payload, envelope] of [
    [{ email: 'other@example.test' }, {}],
    [{}, { issued: '2026-09-15' }],
    [{}, { expires: '2099-12-30' }],
    [{}, { emailHash: createHash('sha256').update('other@example.test').digest('base64') }],
    [{ expires: '2001-01-01' }, {}],
  ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
    const bad = encryptedFixture(payload, envelope);
    const isolated = adapterHarness();
    bind(isolated, bad);
    await assert.rejects(decrypt(isolated.context, bad.text), /не совпадают|другого email|истёк/);
  }
});

test('personal adapter rejects dangerous columns and malformed row layouts before rendering', async () => {
  for (const payload of [
    { cols: ['__proto__'], rows: [['x']] },
    { cols: ['constructor'], rows: [['x']] },
    { cols: ['client', 'client'] },
    { rows: [{ client: 'x' }] },
    { rows: [['x', 1, 'extra']] },
  ]) {
    const fixture = encryptedFixture(payload);
    const harness = adapterHarness();
    bind(harness, fixture);
    await assert.rejects(decrypt(harness.context, fixture.text), /структура/);
    assert.equal(runInContext('calls.render', harness.context), 0);
  }
});

test('personal adapter drops decrypted state on pagehide', async () => {
  const fixture = encryptedFixture();
  const harness = adapterHarness();
  bind(harness, fixture);
  harness.elements.pass.value = PASSWORD;
  await runInContext('tryOpen()', harness.context);
  for (const callback of harness.handlers.get('pagehide') ?? []) callback({ source: null, data: {} });
  assert.equal(runInContext('FILE', harness.context), null);
  assert.equal(runInContext('D', harness.context), null);
  await assert.rejects(decrypt(harness.context, fixture.text), /недоступен/);
});

test('outer frame keeps trusted network fetch separate from opaque content and emits parseable scripts', () => {
  for (const preview of [true, false]) {
    const frame = buildPersonalDashboardFrame({ versionId: 7, snapshotId: 23, preview });
    assert.match(frame.html, /sandbox="allow-scripts"/);
    assert.doesNotMatch(frame.html, /sandbox="[^"]*(?:allow-same-origin|allow-popups)/);
    assert.match(frame.csp, /connect-src 'self'/);
    assert.match(frame.csp, /default-src 'none'/);
    assert.match(frame.html, /event\.source !== frame\.contentWindow \|\| event\.origin !== 'null'/);
    assert.match(frame.html, /snapshots\?snapshot=23/);
    for (const script of frame.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new Script(script[1]);
  }
});

test('outer frame delivers once regardless of snapshot/iframe readiness order and ignores other origins', async () => {
  for (const readyFirst of [true, false]) {
    const frameOutput = buildPersonalDashboardFrame({ versionId: 7, snapshotId: 23, preview: false });
    const source = [...frameOutput.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)][0][1];
    const listeners: Array<(event: Message) => void> = [];
    const delivered: Array<Record<string, unknown>> = [];
    const contentWindow = { postMessage: (value: Record<string, unknown>) => delivered.push(value) };
    const status = { hidden: false, textContent: '' };
    let resolveFetch: (response: Response) => void = () => {};
    const responsePromise = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const context = createContext({
      document: { getElementById: (id: string) => id === 'personal' ? { contentWindow } : status },
      window: {
        location: { origin: 'https://example.test' },
        parent: { postMessage() {} },
        addEventListener: (_type: string, callback: (event: Message) => void) => listeners.push(callback),
      },
      fetch: (url: string) => { assert.equal(url, '/api/admin/manager-dashboard/snapshots?snapshot=23'); return responsePromise; },
      Blob, navigator: { userActivation: { isActive: false } },
    });
    new Script(source).runInContext(context);
    const sendReady = (origin = 'null', sender: unknown = contentWindow) => {
      for (const listener of listeners) listener({ source: sender, origin, data: { marker: 'kts-personal-dashboard-v1', type: 'ready' } });
    };
    sendReady('https://other.example');
    sendReady('null', {});
    if (readyFirst) sendReady();
    resolveFetch(new Response(new Uint8Array([1, 2, 3]), { headers: { 'x-personal-email': EMAIL, 'x-personal-filename': 'synthetic.ktsp' } }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(delivered.length, readyFirst ? 1 : 0);
    sendReady();
    sendReady();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].email, EMAIL);
    assert.equal(status.hidden, true);
  }
});

test('HTML-only frames never request or deliver personal bytes, even with a snapshot ID in their input', () => {
  for (const emptyState of EMPTY_REASONS) {
    for (const snapshotId of [undefined, 23]) {
      const output = buildPersonalDashboardFrame({ versionId: 7, snapshotId, preview: false, emptyState });
      const source = [...output.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)][0][1];
      const listeners: Array<(event: Message) => void> = [];
      const delivered: Array<Record<string, unknown>> = [];
      const contentWindow = { postMessage: (value: Record<string, unknown>) => delivered.push(value) };
      const status = { hidden: false, textContent: '' };
      new Script(source).runInContext(createContext({
        document: { getElementById: (id: string) => id === 'personal' ? { contentWindow } : status },
        window: {
          location: { origin: 'https://example.test' }, parent: { postMessage() {} },
          addEventListener: (_type: string, callback: (event: Message) => void) => listeners.push(callback),
        },
        fetch: () => { assert.fail('Empty HTML frame must not fetch personal data'); },
        Blob, navigator: { userActivation: { isActive: false } },
      }));
      assert.equal(delivered.length, 0);
      assert.match(status.textContent, /HTML дашборда доступен/);
      const ready = { marker: 'kts-personal-dashboard-v1', type: 'ready' };
      for (const listener of listeners) {
        listener({ source: {}, origin: 'null', data: ready });
        listener({ source: contentWindow, origin: 'https://other.test', data: ready });
      }
      assert.equal(delivered.length, 0);
      for (let i = 0; i < 2; i++) for (const listener of listeners) listener({ source: contentWindow, origin: 'null', data: ready });
      assert.equal(delivered.length, 1);
      assert.equal(JSON.stringify(delivered[0]), JSON.stringify({ marker: 'kts-personal-dashboard-v1', type: 'empty', reason: emptyState }));
      assert.equal(status.hidden, false);
    }
  }
});
