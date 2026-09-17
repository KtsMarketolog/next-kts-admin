import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import { MAX_SHARED_JSON_BYTES, MAX_SHARED_JSON_GZIP_BYTES, prepareSharedJsonUpload } from '../src/features/admin/manager-dashboard/sharedJsonUpload';

test('shared JSON upload streams gzip bytes without reading the full source as text or arrayBuffer', async () => {
  const source = '{"snapshot":true,"orders":[],"app":"компоновщик"}';
  const file = new File([source], 'общий_снимок.json');
  Object.defineProperties(file, {
    text: { value: () => { throw new Error('full text read is forbidden'); } },
    arrayBuffer: { value: () => { throw new Error('full arrayBuffer read is forbidden'); } },
  });
  const body = await prepareSharedJsonUpload(file);
  assert.equal(body.type, 'application/gzip');
  assert.equal(gunzipSync(Buffer.from(await body.arrayBuffer())).toString('utf8'), source);
});

test('shared JSON upload rejects empty, wrong extension and oversized sources before reading', async () => {
  for (const file of [new File([], 'empty.json'), new File(['{}'], 'personal.ktsp'),
    { name: 'large.json', size: MAX_SHARED_JSON_BYTES + 1, stream() { throw new Error('must not read'); } } as unknown as File]) {
    await assert.rejects(prepareSharedJsonUpload(file), /JSON-снимок.*100 МБ/);
  }
});

test('shared JSON upload explains unsupported browser capability without falling back to full JSON buffering', async () => {
  const original = globalThis.CompressionStream;
  try {
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, writable: true, value: undefined });
    await assert.rejects(prepareSharedJsonUpload(new File(['{}'], 'snapshot.json')), /браузер.*Chrome, Firefox или Safari/);
  } finally {
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, writable: true, value: original });
  }
});

test('shared JSON compressed-body bound aborts streaming before an oversized request is produced', async () => {
  const original = globalThis.CompressionStream;
  let cancelled = false;
  try {
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, writable: true,
      value: class extends TransformStream<Uint8Array, Uint8Array> { constructor() { super(); } } });
    let sent = 0;
    const file = { name: 'snapshot.json', size: MAX_SHARED_JSON_BYTES, stream() {
      return new ReadableStream<Uint8Array>({
        pull(controller) { sent++; controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled = true; },
      });
    } } as unknown as File;
    await assert.rejects(prepareSharedJsonUpload(file), /После сжатия JSON превышает 16 МБ/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
    assert.ok(sent < MAX_SHARED_JSON_BYTES / (1024 * 1024));
    assert.equal(MAX_SHARED_JSON_GZIP_BYTES, 16 * 1024 * 1024);
  } finally {
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, writable: true, value: original });
  }
});
