import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as contract from '../src/shared/lib/firmwareContract';

const url = 'https://example.test/api/admin/firmware';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const binary = new Uint8Array([0, 255, 128, 10]);
const version = '1.2.3\r\n';
const current: contract.FirmwareVersion = {
  id: 'a'.repeat(32), createdAt: '2026-09-15T01:00:00.000Z', versionLabel: '1.2.3',
  files: {
    c23: { ...contract.FIRMWARE_FILES.c23, size: binary.byteLength, sha256: sha256(binary) },
    ver: { ...contract.FIRMWARE_FILES.ver, size: Buffer.byteLength(version), sha256: sha256(version) },
  },
};
const overview: contract.FirmwareOverview = {
  revision: 'a'.repeat(64), current, previous: { ...current, id: 'b'.repeat(32) }, storageBytes: 128,
};
const updated: contract.FirmwareOverview = {
  ...overview, revision: 'b'.repeat(64), current: { ...current, id: 'c'.repeat(32) }, previous: current,
};

type PublishInput = { c23: File; ver: File; expectedRevision: string; c23Sha256: string; verSha256: string };
type RollbackInput = { expectedRevision: string; previousId: string };
type Options = { denied?: number; originDenied?: boolean; limited?: boolean; storageError?: Error; auditError?: boolean; beforeCommit?: Promise<void> };
type WorkerState = { __ktsFirmwareUploadInFlight?: boolean };

// Execute the actual route and body parser. Only external IO/auth is injected;
// no filesystem/storage module or application database can be loaded by this test.
function route(options: Options = {}, workerState: WorkerState = {}) {
  const order: string[] = [];
  const publications: PublishInput[] = [];
  const rollbacks: RollbackInput[] = [];
  const audits: unknown[] = [];
  let persisted = overview;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const commit = async () => {
    signalStarted();
    await options.beforeCommit;
    if (options.storageError) throw options.storageError;
    persisted = updated;
    order.push('committed');
    return updated;
  };
  const modules: Record<string, unknown> = {
    '@/shared/lib/firmwareContract': contract,
    '@/shared/lib/firmwareStorage': {
      FirmwareError: contract.FirmwareError,
      getFirmwareOverview: async () => { order.push('overview'); if (options.storageError) throw options.storageError; return persisted; },
      publishFirmwarePair: async (input: PublishInput) => { order.push('publish'); publications.push(input); return commit(); },
      rollbackFirmwarePair: async (input: RollbackInput) => { order.push('rollback'); rollbacks.push(input); return commit(); },
    },
    '@/shared/lib/adminAuth': { requireAdminSession: async () => {
      order.push('auth');
      return options.denied ? { denied: Response.json({ error: 'Access denied' }, { status: options.denied }) }
        : { session: { role: 'admin', adminUserId: 1, sessionId: 'synthetic' } };
    } },
    '@/shared/lib/originProtection': { enforceSameOriginRequest: () => {
      order.push('origin'); return options.originDenied ? Response.json({ error: 'Origin denied' }, { status: 403 }) : null;
    } },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => {
      order.push('limit'); return options.limited ? Response.json({ error: 'Rate limited' }, { status: 429 }) : null;
    } },
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async (event: unknown) => {
      order.push('audit'); audits.push(event); if (options.auditError) throw new Error('Synthetic audit outage');
    } },
    '@/shared/lib/rateLimit': { getClientIp: () => '127.0.0.1' },
  };
  const source = readFileSync(new URL('../src/app/api/admin/firmware/route.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const testModule = { exports: {} as { GET: () => Promise<Response>; POST: (request: Request) => Promise<Response> } };
  new Function('require', 'module', 'exports', 'console', 'globalThis', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`); return modules[name];
  }, testModule, testModule.exports, { error: () => {}, warn: () => {} }, workerState);
  return { ...testModule.exports, order, publications, rollbacks, audits, started, persisted: () => persisted };
}

function pair(bytes: Uint8Array = binary) {
  const body = new FormData();
  body.set('action', 'publish');
  body.set('c23', new File([bytes as BlobPart], 'hse_gen_1.c23'));
  body.set('ver', new File([version], 'hse_gen_1.ver'));
  body.set('expectedRevision', overview.revision);
  body.set('c23Sha256', sha256(bytes));
  body.set('verSha256', sha256(version));
  return body;
}
const publishRequest = (body = pair()) => new Request(url, { method: 'POST', body });
const rollbackRequest = (body: unknown = { action: 'rollback', expectedRevision: overview.revision, previousId: overview.previous!.id }) =>
  new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const noStore = (response: Response) => assert.match(response.headers.get('cache-control') ?? '', /no-store/);
const noMutation = (api: ReturnType<typeof route>) => {
  assert.equal(api.publications.length, 0); assert.equal(api.rollbacks.length, 0); assert.equal(api.audits.length, 0);
};

test('GET is admin-only, returns the server overview and never caches it', async () => {
  const denied = route({ denied: 403 });
  const forbidden = await denied.GET();
  assert.equal(forbidden.status, 403); noStore(forbidden);
  assert.deepEqual(denied.order, ['auth']); noMutation(denied);
  const api = route();
  const response = await api.GET();
  assert.equal(response.status, 200); noStore(response);
  assert.deepEqual(await response.json(), overview);
});

test('POST authenticates, checks origin and rate limits before reading or buffering any upload', async () => {
  for (const [options, expected, order] of [
    [{ denied: 401 }, 401, ['auth']], [{ denied: 403 }, 403, ['auth']],
    [{ originDenied: true }, 403, ['auth', 'origin']], [{ limited: true }, 429, ['auth', 'origin', 'limit']],
  ] as const) {
    const api = route(options);
    const request = {
      headers: new Headers({ 'content-type': 'multipart/form-data; boundary=synthetic' }),
      get body() { return assert.fail('Request stream touched before access checks'); },
      formData: () => { assert.fail('Multipart buffered before access checks'); },
      arrayBuffer: () => { assert.fail('Binary buffered before access checks'); },
    } as unknown as Request;
    const response = await api.POST(request);
    assert.equal(response.status, expected); noStore(response);
    assert.deepEqual(api.order, [...order]); noMutation(api);
  }
});

test('publish forwards exactly one unchanged pair, both expected hashes and the revision, then audits after commit', async () => {
  let finish!: () => void;
  const api = route({ beforeCommit: new Promise<void>((resolve) => { finish = resolve; }) });
  const pending = api.POST(publishRequest());
  await api.started;
  assert.equal(api.audits.length, 0);
  assert.equal(api.persisted(), overview);
  finish();
  const response = await pending;
  assert.equal(response.status, 200); noStore(response);
  assert.deepEqual(await response.json(), updated);
  assert.deepEqual(api.order, ['auth', 'origin', 'limit', 'publish', 'committed', 'audit']);
  const input = api.publications[0];
  assert.equal(input.expectedRevision, overview.revision);
  assert.equal(input.c23Sha256, sha256(binary)); assert.equal(input.verSha256, sha256(version));
  assert.deepEqual(new Uint8Array(await input.c23.arrayBuffer()), binary);
  assert.equal(await input.ver.text(), version);
  assert.equal(api.rollbacks.length, 0);
});

test('multipart requires exactly one of every field and rejects unknown fields or legacy single-file updates', async () => {
  for (const field of ['action', 'c23', 'ver', 'expectedRevision', 'c23Sha256', 'verSha256']) {
    for (const change of ['missing', 'duplicate']) {
      const api = route(), body = pair();
      if (change === 'missing') body.delete(field); else body.append(field, body.get(field)!);
      const response = await api.POST(publishRequest(body));
      assert.equal(response.status, 400, `${change} ${field}`); noStore(response); noMutation(api);
    }
  }
  for (const [field, value] of [['target', 'hse_gen_1_c23'], ['destination', '../../outside'], ['unexpected', 'x']]) {
    const api = route(), body = pair(); body.set(field, value);
    assert.equal((await api.POST(publishRequest(body))).status, 400); noMutation(api);
  }
  for (const [field, value] of [['action', 'rollback'], ['c23', 'not a file'], ['ver', 'not a file'], ['expectedRevision', '']]) {
    const api = route(), body = pair(); body.set(field, value);
    assert.equal((await api.POST(publishRequest(body))).status, 400); noMutation(api);
  }
});

test('a declared oversized body is rejected without opening its stream', async () => {
  const api = route();
  const request = {
    headers: new Headers({ 'content-type': 'multipart/form-data; boundary=synthetic', 'content-length': String(contract.MAX_FIRMWARE_BODY_BYTES + 1) }),
    get body() { return assert.fail('Declared oversized upload was read'); },
  } as unknown as Request;
  const response = await api.POST(request);
  assert.equal(response.status, 413); noStore(response); noMutation(api);
});

test('chunked uploads cannot bypass the byte cap with absent or dishonest Content-Length; overflow cancels reading', async () => {
  for (const contentLength of [undefined, '1']) {
    const api = route();
    let remaining = contract.MAX_FIRMWARE_BODY_BYTES + 1, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const length = Math.min(64 * 1024, remaining);
        if (!length) { controller.close(); return; }
        remaining -= length; controller.enqueue(new Uint8Array(length));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const headers = new Headers({ 'content-type': 'multipart/form-data; boundary=synthetic' });
    if (contentLength) headers.set('content-length', contentLength);
    const response = await api.POST(new Request(url, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit));
    assert.equal(response.status, 413); assert.equal(cancelled, true); noStore(response); noMutation(api);
  }
});

test('the exact 25 MiB binary fits alongside the version file and multipart overhead', async () => {
  const api = route();
  const response = await api.POST(publishRequest(pair(new Uint8Array(contract.MAX_FIRMWARE_BYTES))));
  assert.equal(response.status, 200); noStore(response);
  assert.equal(api.publications[0].c23.size, 26_214_400);
  assert.equal(api.publications[0].ver.size, Buffer.byteLength(version));
});

test('file byte limits are inclusive and checked independently after multipart overhead', async () => {
  for (const kind of ['c23', 'ver'] as const) {
    const limit = contract.FIRMWARE_FILES[kind].maxBytes;
    const api = route(), body = pair();
    body.set(kind, new File([new Uint8Array(limit + 1)], `firmware.${kind}`));
    const response = await api.POST(publishRequest(body));
    assert.equal(response.status, 413, `${kind}: limit plus one byte`); noStore(response); noMutation(api);
  }
  const api = route(), body = pair();
  body.set('ver', new File(['v'.repeat(contract.MAX_VERSION_BYTES)], 'firmware.ver'));
  assert.equal((await api.POST(publishRequest(body))).status, 200);
  assert.equal(api.publications[0].ver.size, 4096);
});

test('empty files, wrong extensions and malformed hashes fail without calling storage', async () => {
  for (const kind of ['c23', 'ver'] as const) {
    for (const file of [new File([], `empty.${kind}`), new File(['data'], 'wrong.txt')]) {
      const api = route(), body = pair(); body.set(kind, file);
      assert.equal((await api.POST(publishRequest(body))).status, 400); noMutation(api);
    }
  }
  for (const field of ['c23Sha256', 'verSha256']) {
    for (const invalid of ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ` ${'a'.repeat(64)}`]) {
      const api = route(), body = pair(); body.set(field, invalid);
      assert.equal((await api.POST(publishRequest(body))).status, 400); noMutation(api);
    }
  }
  const api = route(), body = pair();
  body.set('c23Sha256', sha256(binary).toUpperCase());
  assert.equal((await api.POST(publishRequest(body))).status, 200);
  assert.equal(api.publications[0].c23Sha256, sha256(binary));
});

test('unsupported content types are rejected before reading a stream and read errors cancel safely', async () => {
  const unsupported = route();
  const response = await unsupported.POST({
    headers: new Headers({ 'content-type': 'text/plain' }),
    get body() { return assert.fail('Unsupported body should not be buffered'); },
  } as unknown as Request);
  assert.equal(response.status, 415); noStore(response); noMutation(unsupported);
  let cancelled = false;
  const api = route();
  const broken = await api.POST({
    headers: new Headers({ 'content-type': 'multipart/form-data; boundary=synthetic' }),
    body: { getReader: () => ({
      read: async () => { throw new Error('SECRET_STREAM_FAILURE'); },
      cancel: async () => { cancelled = true; }, releaseLock: () => {},
    }) },
  } as unknown as Request);
  assert.equal(broken.status, 400); assert.equal(cancelled, true); noStore(broken); noMutation(api);
  assert.doesNotMatch(await broken.text(), /SECRET_STREAM_FAILURE/);
});

test('rollback forwards only the expected revision and advertised previous ID', async () => {
  const api = route();
  const response = await api.POST(rollbackRequest());
  assert.equal(response.status, 200); noStore(response);
  assert.deepEqual(api.rollbacks, [{ expectedRevision: overview.revision, previousId: overview.previous!.id }]);
  assert.equal(api.publications.length, 0);
  assert.deepEqual(api.order, ['auth', 'origin', 'limit', 'rollback', 'committed', 'audit']);
});

test('rollback rejects missing, mistyped and unknown fields without mutation', async () => {
  const valid = { action: 'rollback', expectedRevision: overview.revision, previousId: overview.previous!.id };
  for (const body of [null, [], {}, { ...valid, action: 'publish' }, { ...valid, expectedRevision: undefined },
    { ...valid, expectedRevision: true }, { ...valid, previousId: [] }, { ...valid, previousId: '' }, { ...valid, unexpected: true }]) {
    const api = route();
    const response = await api.POST(rollbackRequest(body));
    assert.equal(response.status, 400); noStore(response); noMutation(api);
  }
});

test('rollback JSON has a separate exact 4096-byte cap and rejects malformed JSON or UTF-8', async () => {
  const json = JSON.stringify({ action: 'rollback', expectedRevision: overview.revision, previousId: overview.previous!.id });
  const atLimit = json.padEnd(4096, ' ');
  const api = route();
  assert.equal((await api.POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: atLimit }))).status, 200);
  for (const [body, expected] of [[`${atLimit} `, 413], ['{', 400], [new Uint8Array([0xff]), 400]] as const) {
    const rejected = route();
    const response = await rejected.POST(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }));
    assert.equal(response.status, expected); noStore(response); noMutation(rejected);
  }
});

for (const action of ['publish', 'rollback'] as const) {
  const request = () => action === 'publish' ? publishRequest() : rollbackRequest();
  test(`${action} revision conflict remains 409 with no audit or successful state change`, async () => {
    const api = route({ storageError: new contract.FirmwareError('REVISION_CONFLICT', 409, 'Revision changed') });
    const response = await api.POST(request());
    assert.equal(response.status, 409); noStore(response);
    const body = await response.json(); assert.equal(body.code, 'REVISION_CONFLICT');
    assert.equal(api.audits.length, 0); assert.equal(api.persisted(), overview);
  });
  test(`${action} audit outage cannot turn a committed operation into a failed retry`, async () => {
    const api = route({ auditError: true });
    const response = await api.POST(request());
    assert.equal(response.status, 200); noStore(response);
    assert.deepEqual(await response.json(), updated);
    assert.equal(api.persisted(), updated); assert.equal(api.audits.length, 1);
    assert.equal(api.publications.length + api.rollbacks.length, 1);
  });
  test(`${action} unexpected storage errors are safe 500 responses, without sensitive detail`, async () => {
    const api = route({ storageError: new Error('PRIVATE_PATH_AND_SECRET_DO_NOT_EXPOSE') });
    const response = await api.POST(request());
    assert.equal(response.status, 500); noStore(response);
    assert.doesNotMatch(await response.text(), /PRIVATE_PATH_AND_SECRET_DO_NOT_EXPOSE/);
    assert.equal(api.audits.length, 0); assert.equal(api.persisted(), overview);
  });
}

test('GET unexpected errors are also safe, uncached 500 responses', async () => {
  const api = route({ storageError: new Error('PRIVATE_PATH_AND_SECRET_DO_NOT_EXPOSE') });
  const response = await api.GET();
  assert.equal(response.status, 500); noStore(response);
  assert.doesNotMatch(await response.text(), /PRIVATE_PATH_AND_SECRET_DO_NOT_EXPOSE/);
});

test('worker guard claims before buffering, rejects overlapping POSTs unread, and releases after body/storage errors or success', async () => {
  const originalGlobal = globalThis.__ktsFirmwareUploadInFlight;
  for (const outcome of ['body-error', 'storage-error', 'success']) {
    const worker: WorkerState = {};
    let releaseBody!: () => void, releaseCommit!: () => void, reading!: () => void;
    const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve; });
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
    const readingStarted = new Promise<void>((resolve) => { reading = resolve; });
    const api = route({
      beforeCommit: commitGate,
      storageError: outcome === 'storage-error' ? new Error('Synthetic storage failure') : undefined,
    }, worker);
    const encoded = publishRequest();
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        assert.equal(worker.__ktsFirmwareUploadInFlight, true, 'claim must precede the first body read');
        reading();
        await bodyGate;
        if (outcome === 'body-error') controller.error(new Error('Synthetic body failure'));
        else { controller.enqueue(bytes); controller.close(); }
      },
    }, { highWaterMark: 0 });
    const pending = api.POST(new Request(url, { method: 'POST', headers: encoded.headers, body: stream, duplex: 'half' } as RequestInit));
    const assertBusy = async () => {
      // A separately loaded route instance must share this worker's guard.
      const overlapping = route({}, worker);
      const response = await overlapping.POST({
        headers: new Headers({ 'content-type': 'multipart/form-data; boundary=synthetic' }),
        get body() { return assert.fail('BUSY request must not read its body'); },
        formData: () => assert.fail('BUSY request must not buffer files'),
      } as unknown as Request);
      assert.equal(response.status, 409); noStore(response);
      assert.equal((await response.json()).code, 'BUSY'); noMutation(overlapping);
      assert.equal(worker.__ktsFirmwareUploadInFlight, true, 'a rejected contender must not release the owner');
    };
    try {
      await readingStarted;
      await assertBusy();
      releaseBody();
      if (outcome !== 'body-error') {
        await api.started;
        await assertBusy();
      }
      releaseCommit();
      const response = await pending;
      assert.equal(response.status, outcome === 'body-error' ? 400 : outcome === 'storage-error' ? 500 : 200);
      assert.equal(worker.__ktsFirmwareUploadInFlight, false);
      const next = route({}, worker);
      assert.equal((await next.POST(publishRequest())).status, 200, 'a finished request must not poison the next upload');
      assert.equal(worker.__ktsFirmwareUploadInFlight, false);
    } finally {
      releaseBody(); releaseCommit(); await pending;
    }
  }
  assert.equal(globalThis.__ktsFirmwareUploadInFlight, originalGlobal, 'route fixtures must not leak into the test process global state');
});
