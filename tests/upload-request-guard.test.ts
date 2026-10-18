import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  createUploadRequestGuard,
  UploadRequestError,
  type UploadRequestErrorCode,
} from '../src/shared/lib/uploadRequestGuard';

const url = 'https://kts-impex.ru/api/admin/top-dashboard/blocks/4/data';

function requestFromStream(body: ReadableStream<Uint8Array>, init: RequestInit = {}) {
  return new Request(url, { method: 'PUT', ...init, body, duplex: 'half' } as RequestInit);
}

function hasCode(code: UploadRequestErrorCode) {
  return (error: unknown) => error instanceof UploadRequestError && error.code === code;
}

test('upload guard preserves body, request metadata, and exact size boundary', async () => {
  const bytes = Buffer.from('снимок: Резервы / arbitrary additional business fields');
  const original = new Request(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'x-kts-test': 'preserved' },
    body: bytes,
  });
  const guard = createUploadRequestGuard(original, { maxBytes: bytes.length });
  try {
    assert.equal(guard.request.url, original.url);
    assert.equal(guard.request.method, 'PUT');
    assert.equal(guard.request.headers.get('x-kts-test'), 'preserved');
    assert.deepEqual(Buffer.from(await guard.request.arrayBuffer()), bytes);
    guard.assertActive();
    assert.equal(guard.error, null);
  } finally {
    guard.dispose();
  }
  assert.equal(guard.request.signal.aborted, false);
});

for (const declaredLength of [undefined, '1', '4']) {
  test(`upload guard enforces actual streamed bytes with content-length ${declaredLength ?? 'missing'}`, async () => {
    let reads = 0;
    let cancellations = 0;
    const original = requestFromStream(new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(4));
      },
      cancel() { cancellations += 1; },
    }, { highWaterMark: 0 }), {
      headers: declaredLength ? { 'content-length': declaredLength } : undefined,
    });
    const guard = createUploadRequestGuard(original, { maxBytes: 6 });
    try {
      await assert.rejects(guard.request.arrayBuffer(), hasCode('TOO_LARGE'));
      assert.equal(guard.error?.status, 413);
      assert.equal(reads, 2);
      assert.equal(cancellations, 1);
      assert.throws(() => guard.assertActive(), hasCode('TOO_LARGE'));
      assert.equal(guard.request.signal.reason, guard.error);
    } finally {
      guard.dispose();
    }
  });
}

test('multipart parser is stopped at the transport cap even with a lying length header', async () => {
  let chunks = 0;
  let cancellations = 0;
  const prefix = Buffer.from('--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="snapshot.json"\r\nContent-Type: application/json\r\n\r\n');
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks += 1;
      controller.enqueue(chunks === 1 ? prefix : Buffer.alloc(64, 97));
    },
    cancel() { cancellations += 1; },
  }, { highWaterMark: 0 });
  const guard = createUploadRequestGuard(requestFromStream(body, {
    headers: { 'content-type': 'multipart/form-data; boundary=test-boundary', 'content-length': '1' },
  }), { maxBytes: prefix.length + 64 });
  try {
    await assert.rejects(guard.request.formData());
    assert.equal(guard.error?.code, 'TOO_LARGE');
    assert.equal(chunks, 3);
    assert.equal(cancellations, 1);
  } finally {
    guard.dispose();
  }
});

test('valid multipart body retains fields and file bytes', async () => {
  const body = new FormData();
  body.set('expectedActiveVersionId', '84');
  body.set('file', new File(['{"extra":{"Резервы":[]}}'], 'snapshot.json'));
  const guard = createUploadRequestGuard(new Request(url, { method: 'PUT', body }), { maxBytes: 4096 });
  try {
    const parsed = await guard.request.formData();
    assert.equal(parsed.get('expectedActiveVersionId'), '84');
    const file = parsed.get('file');
    assert.ok(file instanceof File);
    assert.equal(file.name, 'snapshot.json');
    assert.equal(await file.text(), '{"extra":{"Резервы":[]}}');
  } finally {
    guard.dispose();
  }
});

for (const firstChunk of [false, true]) {
  test(`idle timeout cancels a source stalled ${firstChunk ? 'after a chunk' : 'before its first chunk'}`, async () => {
    let reads = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (firstChunk && reads === 1) controller.enqueue(Buffer.from('a'));
      },
      cancel() { cancellations += 1; },
    }, { highWaterMark: 0 });
    const guard = createUploadRequestGuard(requestFromStream(body), {
      maxBytes: 100, idleTimeoutMs: 25, totalTimeoutMs: 2_000,
    });
    try {
      await assert.rejects(guard.request.arrayBuffer(), hasCode('IDLE_TIMEOUT'));
      assert.equal(guard.error?.status, 408);
      assert.equal(cancellations, 1);
    } finally {
      guard.dispose();
    }
  });
}

test('empty chunks do not keep an idle upload alive', async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array()); },
  }, { highWaterMark: 0 });
  const guard = createUploadRequestGuard(requestFromStream(body), {
    maxBytes: 100, idleTimeoutMs: 25, totalTimeoutMs: 2_000,
  });
  try {
    await assert.rejects(guard.request.arrayBuffer(), hasCode('IDLE_TIMEOUT'));
  } finally {
    guard.dispose();
  }
});

test('a continuously progressing upload still reaches its total deadline', async () => {
  let cancelled = false;
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await delay(5);
      if (cancelled) return;
      reads += 1;
      controller.enqueue(Buffer.from('a'));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const guard = createUploadRequestGuard(requestFromStream(body), {
    maxBytes: 1000, idleTimeoutMs: 2_000, totalTimeoutMs: 50,
  });
  try {
    await assert.rejects(guard.request.arrayBuffer(), hasCode('TOTAL_TIMEOUT'));
    assert.equal(guard.error?.status, 408);
    assert.ok(reads >= 1);
    assert.ok(cancelled);
  } finally {
    guard.dispose();
  }
});

test('original request abort stops reading with a safe upload error', async () => {
  const abortController = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; },
  });
  const guard = createUploadRequestGuard(requestFromStream(body, { signal: abortController.signal }), {
    maxBytes: 100, idleTimeoutMs: 2_000, totalTimeoutMs: 3_000,
  });
  try {
    const result = assert.rejects(guard.request.arrayBuffer(), hasCode('ABORTED'));
    abortController.abort(new Error('do not expose source error details'));
    await result;
    assert.ok(cancelled);
    assert.equal(guard.error?.status, 400);
    assert.ok(!guard.error?.message.includes('source error details'));
  } finally {
    guard.dispose();
  }
});

test('an already aborted request is rejected before consuming a chunk', async () => {
  const abortController = new AbortController();
  abortController.abort();
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull() { reads += 1; },
  }, { highWaterMark: 0 });
  const guard = createUploadRequestGuard(requestFromStream(body, { signal: abortController.signal }), { maxBytes: 100 });
  try {
    await assert.rejects(guard.request.arrayBuffer(), hasCode('ABORTED'));
    assert.equal(reads, 0);
  } finally {
    guard.dispose();
  }
});

test('a never-settling source cancellation cannot hold the failed consumer', async () => {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancellations += 1;
      return new Promise<void>(() => {});
    },
  });
  const guard = createUploadRequestGuard(requestFromStream(body), {
    maxBytes: 100, idleTimeoutMs: 25, totalTimeoutMs: 2_000,
  });
  try {
    await assert.rejects(guard.request.arrayBuffer(), hasCode('IDLE_TIMEOUT'));
    assert.equal(cancellations, 1);
  } finally {
    guard.dispose();
  }
});

test('downstream cancellation is prompt even when source cancellation never settles', async () => {
  let cancellations = 0;
  const guard = createUploadRequestGuard(requestFromStream(new ReadableStream<Uint8Array>({
    cancel() {
      cancellations += 1;
      return new Promise<void>(() => {});
    },
  })), { maxBytes: 100 });
  try {
    await guard.request.body!.cancel();
    assert.equal(cancellations, 1);
  } finally {
    guard.dispose();
  }
});

test('deadline remains active during validation after EOF', async () => {
  const guard = createUploadRequestGuard(new Request(url, { method: 'PUT', body: 'ok' }), {
    maxBytes: 2, idleTimeoutMs: 10, totalTimeoutMs: 40,
  });
  try {
    assert.equal(await guard.request.text(), 'ok');
    await delay(65);
    assert.throws(() => guard.assertActive(), hasCode('TOTAL_TIMEOUT'));
    assert.ok(guard.request.signal.aborted);
  } finally {
    guard.dispose();
  }
});

test('dispose clears deadline and abort listener without aborting completed success', async () => {
  const originalAbort = new AbortController();
  const guard = createUploadRequestGuard(new Request(url, {
    method: 'PUT', body: 'ok', signal: originalAbort.signal,
  }), { maxBytes: 2, idleTimeoutMs: 10, totalTimeoutMs: 30 });
  assert.equal(await guard.request.text(), 'ok');
  guard.dispose();
  guard.dispose();
  originalAbort.abort();
  await delay(50);
  guard.assertActive();
  assert.equal(guard.error, null);
  assert.equal(guard.request.signal.aborted, false);
});

test('dispose cancels an unread body once and prevents subsequent timer errors', async () => {
  let cancellations = 0;
  const guard = createUploadRequestGuard(requestFromStream(new ReadableStream<Uint8Array>({
    cancel() {
      cancellations += 1;
      return new Promise<void>(() => {});
    },
  })), { maxBytes: 100, idleTimeoutMs: 10, totalTimeoutMs: 20 });
  guard.dispose();
  guard.dispose();
  assert.equal(cancellations, 1);
  assert.equal((await guard.request.arrayBuffer()).byteLength, 0);
  await delay(40);
  assert.equal(guard.error, null);
});
