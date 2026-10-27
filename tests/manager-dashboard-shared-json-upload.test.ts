import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

import { MAX_SHARED_JSON_BYTES, MAX_SHARED_JSON_GZIP_BYTES, prepareSharedJsonUpload, validateSharedJsonFile } from '../src/features/admin/manager-dashboard/sharedJsonUpload';

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

test('shared JSON upload rejects empty and wrong extension before reading', async () => {
  for (const file of [new File([], 'empty.json'), new File(['{}'], 'personal.ktsp')]) {
    await assert.rejects(prepareSharedJsonUpload(file), /непустой JSON-снимок/);
  }
});

test('shared JSON source boundary is 500 MiB; oversize explains actual size and never reads', async () => {
  assert.equal(MAX_SHARED_JSON_BYTES, 500 * 1024 * 1024);
  assert.equal(MAX_SHARED_JSON_GZIP_BYTES, 501 * 1024 * 1024);
  for (const size of [100 * 1024 * 1024 + 499 * 1024, MAX_SHARED_JSON_BYTES - 1, MAX_SHARED_JSON_BYTES]) {
    assert.doesNotThrow(() => validateSharedJsonFile({ name: 'snapshot.json', size }));
  }
  const file = { name: 'large.json', size: MAX_SHARED_JSON_BYTES + 1, stream() { throw new Error('must not read'); } } as unknown as File;
  await assert.rejects(prepareSharedJsonUpload(file), /Размер файла.*500.*524\D*288\D*001.*Допустимо до 500 МиБ.*Файл не отправлен/);
});

test('shared JSON compression reports bounded progress without parsing source', async () => {
  const progress: number[] = [];
  await prepareSharedJsonUpload(new File(['a'.repeat(200000)], 'snapshot.json'), {onProgress: (percent) => progress.push(percent)});
  assert.equal(progress.at(-1), 100);
  assert.ok(progress.every((value, index) => value >= 0 && value <= 100 && (index === 0 || value > progress[index - 1])));
  assert.ok(progress.length <= 101);
});

test('shared JSON source stream cannot exceed its announced size limit', async () => {
  const file = {name: 'snapshot.json', size: 1, stream() {
    return new ReadableStream<Uint8Array>({start(controller) {controller.enqueue({byteLength: MAX_SHARED_JSON_BYTES + 1} as Uint8Array); controller.close();}});
  }} as unknown as File;
  await assert.rejects(prepareSharedJsonUpload(file), /JSON превышает 500 МиБ.*Файл не отправлен/);
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
      value: class extends TransformStream<Uint8Array, Uint8Array> { constructor() { super({transform(_chunk, controller) {
        // Exercise the guard without allocating a half-gigabyte test buffer.
        controller.enqueue({byteLength: MAX_SHARED_JSON_GZIP_BYTES + 1} as Uint8Array);
      }}); } } });
    let sent = 0;
    const file = { name: 'snapshot.json', size: MAX_SHARED_JSON_BYTES, stream() {
      return new ReadableStream<Uint8Array>({
        pull(controller) { sent++; controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled = true; },
      });
    } } as unknown as File;
    await assert.rejects(prepareSharedJsonUpload(file), /После сжатия JSON превышает 501 МиБ/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
    assert.ok(sent < MAX_SHARED_JSON_BYTES / (1024 * 1024));
  } finally {
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, writable: true, value: original });
  }
});

test('shared JSON preparation times out a stalled source, cancels reading and permits a new upload', async () => {
  let cancelled = false;
  const file = { name: 'snapshot.json', size: 100, stream() {
    return new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  } } as unknown as File;
  await assert.rejects(prepareSharedJsonUpload(file, { timeoutMs: 15 }), /Подготовка JSON.*слишком много времени.*не отправлен/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.ok((await prepareSharedJsonUpload(new File(['{}'], 'next.json'))).size > 0);
});

test('shared JSON preparation supports explicit abort without sending any source bytes to a server', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const file = { name: 'snapshot.json', size: 100, stream() {
    return new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  } } as unknown as File;
  const pending = prepareSharedJsonUpload(file, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /Подготовка JSON прервана.*не отправлен/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});
