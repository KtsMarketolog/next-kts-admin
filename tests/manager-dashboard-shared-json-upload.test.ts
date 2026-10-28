import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync, gunzipSync } from 'node:zlib';

import { MAX_SHARED_JSON_BYTES, MAX_SHARED_JSON_GZIP_BYTES, prepareSharedJsonUpload, validateSharedJsonFile } from '../src/features/admin/manager-dashboard/sharedJsonUpload';

function observeCancellation() {
  let notify!: () => void;
  const completed = new Promise<void>((resolve) => { notify = resolve; });
  return {
    notify,
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Observe actual upstream cancellation, not just the returned rejection.
        // Keep a bounded deadline so a lost cancellation fails rather than hangs.
        await Promise.race([completed, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Source stream was not cancelled within 2 seconds')), 2_000);
        })]);
      } finally { clearTimeout(timer); }
    },
  };
}

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

test('existing JSON.gz is sent byte-for-byte without compression, decompression or full source reads', async () => {
  const json = JSON.stringify({ snapshot: true, app: 'компоновщик', orders: [], label: 'данные '.repeat(2000) });
  const gzip = gzipSync(json);
  const file = new File([gzip], 'общий_снимок.JSON.GZ', { type: 'application/octet-stream' });
  const nativeSlice = file.slice.bind(file);
  const slices: Array<[number | undefined, number | undefined, string | undefined]> = [];
  Object.defineProperties(file, {
    text: { value: () => { throw new Error('full text read is forbidden'); } },
    arrayBuffer: { value: () => { throw new Error('full arrayBuffer read is forbidden'); } },
    stream: { value: () => { throw new Error('full archive stream read is unnecessary'); } },
    slice: { value: (start?: number, end?: number, type?: string) => {
      slices.push([start, end, type]);
      return nativeSlice(start, end, type);
    } },
  });
  const compression = globalThis.CompressionStream, decompression = globalThis.DecompressionStream;
  try {
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, writable: true, value: undefined });
    Object.defineProperty(globalThis, 'DecompressionStream', { configurable: true, writable: true, value: undefined });
    const progress: number[] = [];
    const body = await prepareSharedJsonUpload(file, { onProgress: value => progress.push(value) });
    assert.equal(body.type, 'application/gzip');
    assert.equal(body.size, gzip.length);
    const bytes = Buffer.from(await body.arrayBuffer());
    assert.deepEqual(bytes, gzip, 'no second layer of compression and no archive rewrite');
    assert.equal(gunzipSync(bytes).toString('utf8'), json);
    assert.deepEqual(slices, [[0, 3, undefined], [0, file.size, 'application/gzip']]);
    assert.deepEqual(progress, [100]);
  } finally {
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, writable: true, value: compression });
    Object.defineProperty(globalThis, 'DecompressionStream', { configurable: true, writable: true, value: decompression });
  }
});

test('existing JSON.gz rejects empty, renamed JSON, ZIP and non-gzip compression signatures', async () => {
  await assert.rejects(prepareSharedJsonUpload(new File([], 'empty.json.gz')), /непустой JSON-снимок/);
  for (const bytes of [Buffer.from('{}'), Buffer.from([0x1f, 0x8b]), Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from([0x1f, 0x8b, 0])]) {
    await assert.rejects(prepareSharedJsonUpload(new File([bytes], 'wrong.json.gz')), /не является архивом gzip.*Файл не отправлен/);
  }
  await assert.rejects(prepareSharedJsonUpload(new File([gzipSync('{}')], 'snapshot.gz')), /непустой JSON-снимок/);
});

test('existing JSON.gz keeps the 500 MiB input limit before inspecting any bytes', async () => {
  for (const size of [MAX_SHARED_JSON_BYTES - 1, MAX_SHARED_JSON_BYTES]) {
    assert.doesNotThrow(() => validateSharedJsonFile({ name: 'snapshot.json.gz', size }));
  }
  const file = { name: 'large.json.gz', size: MAX_SHARED_JSON_BYTES + 1,
    slice() { throw new Error('must not read'); } } as unknown as File;
  await assert.rejects(prepareSharedJsonUpload(file), /Допустимо до 500 МиБ.*Файл не отправлен/);
});

test('existing JSON.gz honors cancellation before and during its bounded signature read', async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(prepareSharedJsonUpload({ name: 'cancel.json.gz', size: 100,
    slice() { throw new Error('must not read'); } } as unknown as File, { signal: before.signal }), /Подготовка JSON прервана/);
  let resume!: (value: ArrayBuffer) => void;
  const signature = new Promise<ArrayBuffer>(resolve => { resume = resolve; });
  const controller = new AbortController();
  let slices = 0, progress = 0;
  const file = { name: 'cancel.json.gz', size: 100, slice(start: number, end: number) {
    slices++; assert.equal(start, 0); assert.equal(end, 3);
    return { arrayBuffer: () => signature };
  } } as unknown as File;
  const pending = prepareSharedJsonUpload(file, { signal: controller.signal, onProgress: () => { progress++; } });
  controller.abort();
  await assert.rejects(pending, /Подготовка JSON прервана.*не отправлен/);
  resume(new Uint8Array([0x1f, 0x8b, 8]).buffer);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(slices, 1, 'cancelled signature read must not prepare the full body later');
  assert.equal(progress, 0);
});

test('existing JSON.gz signature timeout releases the operation and ignores a late read result', async () => {
  let resume!: (value: ArrayBuffer) => void;
  const signature = new Promise<ArrayBuffer>(resolve => { resume = resolve; });
  let slices = 0, progress = 0;
  const file = { name: 'stalled.json.gz', size: 100, slice(start: number, end: number) {
    slices++; assert.equal(start, 0); assert.equal(end, 3);
    return { arrayBuffer: () => signature };
  } } as unknown as File;
  await assert.rejects(prepareSharedJsonUpload(file, { timeoutMs: 15, onProgress: () => { progress++; } }), /Подготовка JSON.*слишком много времени/);
  resume(new Uint8Array([0x1f, 0x8b, 8]).buffer);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(slices, 1);
  assert.equal(progress, 0);
  const next = await prepareSharedJsonUpload(new File([gzipSync('{}')], 'next.json.gz'));
  assert.equal(gunzipSync(Buffer.from(await next.arrayBuffer())).toString(), '{}');
});

test('existing JSON.gz keeps read and progress failures without sending a body', async () => {
  const failure = new Error('Synthetic signature read error');
  const file = { name: 'read-failure.json.gz', size: 100, slice() {
    return { arrayBuffer: () => Promise.reject(failure) };
  } } as unknown as File;
  await assert.rejects(prepareSharedJsonUpload(file), error => error === failure);
  await assert.rejects(prepareSharedJsonUpload(new File([gzipSync('{}')], 'progress.json.gz'), {
    onProgress() { throw failure; },
  }), error => error === failure);
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
  const cancellation = observeCancellation();
  let cancelled = false;
  try {
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, writable: true,
      value: class extends TransformStream<Uint8Array, Uint8Array> { constructor() { super({transform(_chunk, controller) {
        // Exercise the guard without allocating a half-gigabyte test buffer.
        const chunk = new Uint8Array(1);
        Object.defineProperty(chunk, 'byteLength', { value: MAX_SHARED_JSON_GZIP_BYTES + 1 });
        controller.enqueue(chunk);
      }}); } } });
    let sent = 0;
    const file = { name: 'snapshot.json', size: MAX_SHARED_JSON_BYTES, stream() {
      return new ReadableStream<Uint8Array>({
        pull(controller) { sent++; controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled = true; cancellation.notify(); },
      });
    } } as unknown as File;
    await assert.rejects(prepareSharedJsonUpload(file), /После сжатия JSON превышает 501 МиБ/);
    await cancellation.wait();
    assert.equal(cancelled, true);
    assert.ok(sent < MAX_SHARED_JSON_BYTES / (1024 * 1024));
    const sentAtCancellation = sent;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent, sentAtCancellation, 'the rejected upload must not keep reading the file');
  } finally {
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, writable: true, value: original });
  }
});

test('shared JSON preparation times out a stalled source, cancels reading and permits a new upload', async () => {
  const cancellation = observeCancellation();
  let cancelled = false;
  const file = { name: 'snapshot.json', size: 100, stream() {
    return new ReadableStream<Uint8Array>({ cancel() { cancelled = true; cancellation.notify(); } });
  } } as unknown as File;
  await assert.rejects(prepareSharedJsonUpload(file, { timeoutMs: 15 }), /Подготовка JSON.*слишком много времени.*не отправлен/);
  await cancellation.wait();
  assert.equal(cancelled, true);
  assert.ok((await prepareSharedJsonUpload(new File(['{}'], 'next.json'))).size > 0);
});

test('shared JSON preparation supports explicit abort without sending any source bytes to a server', async () => {
  const controller = new AbortController();
  const cancellation = observeCancellation();
  let cancelled = false;
  const file = { name: 'snapshot.json', size: 100, stream() {
    return new ReadableStream<Uint8Array>({ cancel() { cancelled = true; cancellation.notify(); } });
  } } as unknown as File;
  const pending = prepareSharedJsonUpload(file, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /Подготовка JSON прервана.*не отправлен/);
  await cancellation.wait();
  assert.equal(cancelled, true);
});

test('shared JSON native gzip stops reading and releases the file on a downstream bound error', async () => {
  const NativeTransform = globalThis.TransformStream;
  const cancellation = observeCancellation();
  let transforms = 0;
  let sent = 0;
  let source!: ReadableStream<Uint8Array>;
  try {
    Object.defineProperty(globalThis, 'TransformStream', { configurable: true, writable: true,
      value: class extends NativeTransform<Uint8Array, Uint8Array> {
        constructor(transformer: Transformer<Uint8Array, Uint8Array>) {
          // Keep the native CompressionStream. Simulate the output-size counter
          // reaching its limit at the first real gzip chunk, without 501 MiB RAM.
          const bounded = ++transforms === 2;
          super({ ...transformer, transform(chunk, controller) {
            if (bounded) Object.defineProperty(chunk, 'byteLength', { value: MAX_SHARED_JSON_GZIP_BYTES + 1 });
            return transformer.transform?.(chunk, controller);
          } });
        }
      } });
    const file = { name: 'snapshot.json', size: MAX_SHARED_JSON_BYTES, stream() {
      source = new ReadableStream<Uint8Array>({
        pull(controller) { sent++; controller.enqueue(new Uint8Array(1024 * 1024)); },
        cancel: cancellation.notify,
      });
      return source;
    } } as unknown as File;
    await assert.rejects(prepareSharedJsonUpload(file), /После сжатия JSON превышает 501 МиБ/);
    await cancellation.wait();
    assert.equal(transforms, 2);
    assert.equal(source.locked, false);
    const sentAtCancellation = sent;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent, sentAtCancellation);
    assert.ok(sent < 10, `native gzip read ${sent} MiB instead of stopping promptly`);
  } finally {
    Object.defineProperty(globalThis, 'TransformStream', { configurable: true, writable: true, value: NativeTransform });
  }
});

test('shared JSON timeout directly cancels the file even when a compression transform is stalled', async () => {
  const NativeCompression = globalThis.CompressionStream;
  const cancellation = observeCancellation();
  let resume!: () => void;
  const stalled = new Promise<void>((resolve) => { resume = resolve; });
  let source!: ReadableStream<Uint8Array>;
  let sent = 0;
  try {
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, writable: true,
      value: class extends TransformStream<Uint8Array, Uint8Array> {
        constructor() { super({ transform: () => stalled }); }
      } });
    const file = { name: 'snapshot.json', size: MAX_SHARED_JSON_BYTES, stream() {
      source = new ReadableStream<Uint8Array>({
        pull(controller) { sent++; controller.enqueue(new Uint8Array(16)); },
        cancel: cancellation.notify,
      });
      return source;
    } } as unknown as File;
    await assert.rejects(prepareSharedJsonUpload(file, { timeoutMs: 15 }), /Подготовка JSON.*слишком много времени/);
    await cancellation.wait();
    assert.equal(source.locked, false, 'cleanup must not wait for the stalled transform');
    const sentAtCancellation = sent;
    resume();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sent, sentAtCancellation);
  } finally {
    resume();
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, writable: true, value: NativeCompression });
  }
});

test('shared JSON preserves the original failure if source cancellation rejects', async () => {
  const failure = new Error('Synthetic progress failure');
  let cancellations = 0;
  let source!: ReadableStream<Uint8Array>;
  const file = { name: 'snapshot.json', size: MAX_SHARED_JSON_BYTES, stream() {
    source = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(16)); },
      cancel() { cancellations++; return Promise.reject(new Error('Synthetic cancellation failure')); },
    });
    return source;
  } } as unknown as File;
  await assert.rejects(prepareSharedJsonUpload(file, { onProgress() { throw failure; } }), (error) => error === failure);
  assert.equal(source.locked, false);
  assert.equal(cancellations, 1);
  assert.ok((await prepareSharedJsonUpload(new File(['{}'], 'next.json'))).size > 0);
});

test('shared JSON preserves source read errors and permits another upload', async () => {
  const failure = new Error('Synthetic read failure');
  const source = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure); } });
  const file = { name: 'snapshot.json', size: 100, stream: () => source } as unknown as File;
  await assert.rejects(prepareSharedJsonUpload(file), (error) => error === failure);
  assert.equal(source.locked, false);
  assert.ok((await prepareSharedJsonUpload(new File(['{}'], 'next.json'))).size > 0);
});

test('shared JSON keeps a specific stream failure when Response.blob masks it as Failed to fetch', async () => {
  const NativeResponse = globalThis.Response;
  const failure = new Error('Synthetic file read error');
  try {
    Object.defineProperty(globalThis, 'Response', { configurable: true, writable: true,
      value: class extends NativeResponse {
        async blob() {
          try { return await super.blob(); }
          catch { throw new TypeError('Failed to fetch'); }
        }
      } });
    const file = { name: 'snapshot.json', size: 100, stream() {
      return new ReadableStream<Uint8Array>({ pull(controller) { controller.error(failure); } });
    } } as unknown as File;
    await assert.rejects(prepareSharedJsonUpload(file), (error) => error === failure);
  } finally {
    Object.defineProperty(globalThis, 'Response', { configurable: true, writable: true, value: NativeResponse });
  }
});

test('shared JSON timeout does not wait for an unresponsive source cancellation callback', async () => {
  let cancellations = 0;
  const source = new ReadableStream<Uint8Array>({
    cancel() { cancellations++; return new Promise<void>(() => undefined); },
  });
  const file = { name: 'snapshot.json', size: 100, stream: () => source } as unknown as File;
  await assert.rejects(prepareSharedJsonUpload(file, { timeoutMs: 15 }), /Подготовка JSON.*слишком много времени/);
  assert.equal(cancellations, 1);
  assert.equal(source.locked, false);
  assert.ok((await prepareSharedJsonUpload(new File(['{}'], 'next.json'))).size > 0);
});
