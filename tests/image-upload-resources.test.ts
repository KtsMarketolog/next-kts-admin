import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import sanitizeHtml from 'sanitize-html';
import ts from 'typescript';

import * as multipart from '../src/shared/lib/boundedMultipartUpload';
import * as origin from '../src/shared/lib/originProtection';
import * as uploadGuard from '../src/shared/lib/uploadRequestGuard';

const url = 'https://example.test/api/admin/uploads';
const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function png(size = 32) {
  const bytes = new Uint8Array(size);
  bytes.set(pngHeader);
  return new File([bytes], 'рисунок.png', { type: 'image/png' });
}

async function uploadRequest(file = png(), kind?: string) {
  const form = new FormData();
  form.set('file', file);
  if (kind) form.set('kind', kind);
  const encoded = new Request(url, { method: 'POST', body: form });
  encoded.headers.set('origin', new URL(url).origin);
  return new Request(url, { method: 'POST', body: await encoded.arrayBuffer(), headers: encoded.headers });
}

function harness(options: { denied?: boolean; busy?: boolean; releaseFailure?: boolean; writeFailure?: boolean; waitWrite?: Promise<void>; slotController?: AbortController } = {}) {
  const writes: { name: string; bytes: Buffer }[] = [];
  const removed: string[] = [];
  let admitted = 0;
  let released = 0;
  let mkdirs = 0;
  let notifyStarted: () => void = () => undefined;
  const writeStarted = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const dependencies: Record<string, unknown> = {
    crypto,
    path,
    'sanitize-html': sanitizeHtml,
    'fs/promises': {
      mkdir: async () => { mkdirs += 1; },
      open: async (name: string, flags: string) => {
        assert.equal(flags, 'wx');
        return {
          writeFile: async (bytes: Buffer, { signal }: { signal: AbortSignal }) => {
            notifyStarted();
            await options.waitWrite;
            signal.throwIfAborted();
            if (options.writeFailure) throw new Error('synthetic storage unavailable');
            writes.push({ name, bytes });
          },
          close: async () => undefined,
        };
      },
      unlink: async (name: string) => { removed.push(name); },
    },
    '@/shared/lib/adminAuth': { requireAdmin: async () => options.denied ? Response.json({}, { status: 401 }) : null },
    '@/shared/lib/boundedMultipartUpload': multipart,
    '@/shared/lib/originProtection': origin,
    '@/shared/lib/uploadRequestGuard': uploadGuard,
    '@/shared/lib/resourceUploadConcurrency': {
      acquireResourceUploadSlot: async (kind: string) => {
        assert.equal(kind, 'image');
        admitted += 1;
        return options.busy ? null : Object.assign(async () => {
          released += 1;
          if (options.releaseFailure) throw new Error('synthetic unlock unavailable');
        }, { signal: (options.slotController ?? new AbortController()).signal });
      },
    },
  };
  const code = ts.transpileModule(readFileSync(new URL('../src/app/api/admin/uploads/route.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, loaded, loaded.exports);
  return {
    route: loaded.exports as typeof import('../src/app/api/admin/uploads/route'),
    writes, removed, writeStarted, admitted: () => admitted, released: () => released, mkdirs: () => mkdirs,
  };
}

test('image authentication and busy admission reject before consuming the request or creating files', async () => {
  for (const options of [{ denied: true }, { busy: true }]) {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({ pull() { reads += 1; } }, { highWaterMark: 0 });
    const request = new Request(url, { method: 'POST', body, headers: { origin: new URL(url).origin }, duplex: 'half' } as RequestInit);
    const h = harness(options);
    const response = await h.route.POST(request);
    assert.equal(response.status, options.denied ? 401 : 503);
    assert.equal(reads, 0);
    assert.equal(h.mkdirs(), 0);
    assert.equal(h.writes.length, 0);
    assert.equal(h.admitted(), options.denied ? 0 : 1);
  }
});

test('valid PNG is saved while preserving existing URL format and admission is released', async () => {
  const h = harness();
  const response = await h.route.POST(await uploadRequest());
  assert.equal(response.status, 200);
  assert.match((await response.json()).url, /^\/uploads\/hero\/[\d]+-[a-f\d-]+\.png$/);
  assert.equal(h.writes.length, 1);
  assert.deepEqual([...h.writes[0].bytes.subarray(0, 8)], pngHeader);
  assert.equal(h.released(), 1);
});

test('image origin protection runs before admission and body reading independently of proxy', async () => {
  const h = harness();
  const request = await uploadRequest();
  request.headers.set('origin', 'https://other.example');
  assert.equal((await h.route.POST(request)).status, 403);
  assert.equal(h.admitted(), 0);
  assert.equal(h.mkdirs(), 0);
  assert.equal(request.bodyUsed, false);
});

test('image slot is held until the actual asynchronous file write has completed', async () => {
  let finishWrite: () => void = () => undefined;
  const waitWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
  const h = harness({ waitWrite });
  const pending = h.route.POST(await uploadRequest());
  await h.writeStarted;
  assert.equal(h.released(), 0);
  finishWrite();
  assert.equal((await pending).status, 200);
  assert.equal(h.released(), 1);
});

test('8 MiB remains a valid inclusive image limit; exceeding it does not reach storage', async () => {
  for (const additional of [0, 1]) {
    const h = harness();
    const response = await h.route.POST(await uploadRequest(png(8 * 1024 * 1024 + additional)));
    assert.equal(response.status, additional ? 413 : 200);
    assert.equal(h.writes.length, additional ? 0 : 1);
    assert.equal(h.released(), 1);
  }
});

test('category icon limit stays 500 KiB including exact boundary', async () => {
  for (const additional of [0, 1]) {
    const h = harness();
    const response = await h.route.POST(await uploadRequest(png(500 * 1024 + additional), 'categoryIcon'));
    assert.equal(response.status, additional ? 400 : 200);
    assert.equal(h.writes.length, additional ? 0 : 1);
  }
});

test('SVG sanitization, restricted locations and external-reference checks remain in force', async () => {
  const source = '<svg width="100" height="50"><script>alert(1)</script><path d="M1 1" onclick="alert(1)"/></svg>';
  const h = harness();
  const response = await h.route.POST(await uploadRequest(new File([source], 'logo.svg', { type: 'image/svg+xml' }), 'brandLogo'));
  assert.equal(response.status, 200);
  assert.doesNotMatch(h.writes[0].bytes.toString(), /script|onclick/);
  for (const [kind, content] of [['image', source], ['brandLogo', '<svg><image href="https://evil.test/x.png"/></svg>']]) {
    const rejected = harness();
    assert.equal((await rejected.route.POST(await uploadRequest(new File([content], 'logo.svg', { type: 'image/svg+xml' }), kind))).status, 400);
    assert.equal(rejected.writes.length, 0);
    assert.equal(rejected.released(), 1);
  }
});

test('unlock failure does not turn a completed upload into an error', async (t) => {
  t.mock.method(console, 'warn', () => undefined);
  const h = harness({ releaseFailure: true });
  assert.equal((await h.route.POST(await uploadRequest())).status, 200);
  assert.equal(h.writes.length, 1);
  assert.equal(h.released(), 1);
});

test('lost upload admission cancels an in-progress file write and cleans only its newly created file', async () => {
  let finishWrite: () => void = () => undefined;
  const waitWrite = new Promise<void>((resolve) => { finishWrite = resolve; });
  const slotController = new AbortController();
  const h = harness({ waitWrite, slotController });
  const pending = h.route.POST(await uploadRequest());
  await h.writeStarted;
  slotController.abort();
  finishWrite();
  assert.equal((await pending).status, 400);
  assert.equal(h.writes.length, 0);
  assert.equal(h.removed.length, 1);
  assert.match(h.removed[0], /\/hero\/[\d]+-[a-f\d-]+\.png$/);
  assert.equal(h.released(), 1);
});

test('storage error and malformed multipart return safe responses and release admission', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const failed = harness({ writeFailure: true });
  const response = await failed.route.POST(await uploadRequest());
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /synthetic|storage unavailable/);
  assert.equal(failed.released(), 1);
  assert.equal(failed.removed.length, 1);
  const malformed = harness();
  assert.equal((await malformed.route.POST(new Request(url, {
    method: 'POST', body: 'broken', headers: { origin: new URL(url).origin, 'content-type': 'multipart/form-data; boundary=x' },
  }))).status, 400);
  assert.equal(malformed.mkdirs(), 0);
  assert.equal(malformed.released(), 1);
});
