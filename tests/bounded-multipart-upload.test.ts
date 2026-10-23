import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BoundedMultipartUploadError,
  readBoundedMultipartUpload,
  type BoundedMultipartUploadOptions,
} from '../src/shared/lib/boundedMultipartUpload';
import { UploadRequestError } from '../src/shared/lib/uploadRequestGuard';

const url = 'https://example.test/api/admin/uploads';
const limits: BoundedMultipartUploadOptions = {
  maxBodyBytes: 4096, maxFileBytes: 64, maxFields: 1,
  maxFieldBytes: 32, allowedTextFields: ['title'],
};

function multipart(file = new File(['hello'], 'Инструкция.pdf', { type: 'application/pdf' }), title?: string) {
  const body = new FormData();
  body.append('file', file);
  if (title !== undefined) body.append('title', title);
  return new Request(url, { method: 'POST', body });
}

async function requestFromForm(body: FormData) {
  // Materialize the client encoder, as HTTP does in production. Cancelling an
  // in-process Undici FormData encoder mid-file triggers its own enqueue race.
  const encoded = new Request(url, { method: 'POST', body });
  return new Request(url, { method: 'POST', body: await encoded.arrayBuffer(), headers: encoded.headers });
}

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let reads = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[reads++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return {
    request: new Request(url, { method: 'POST', headers, body, duplex: 'half' } as RequestInit),
    reads: () => reads, cancelled: () => cancelled,
  };
}

function hasCode(code: string) {
  return (error: unknown) => (error instanceof BoundedMultipartUploadError || error instanceof UploadRequestError) && error.code === code;
}

test('streamed multipart preserves Unicode file names, file bytes and text at exact limits', async () => {
  const file = new File([new Uint8Array(64).fill(97)], 'Инструкция.pdf', { type: 'application/pdf' });
  const request = multipart(file, 'a'.repeat(32));
  request.formData = async () => { throw new Error('The unbounded formData parser must never be used'); };
  const result = await readBoundedMultipartUpload(request, limits);
  assert.equal(result.get('title'), 'a'.repeat(32));
  const parsed = result.get('file');
  assert.ok(parsed instanceof File);
  assert.equal(parsed.name, file.name);
  assert.equal(parsed.type, 'application/pdf');
  assert.equal(parsed.size, 64);
  assert.equal(await parsed.text(), 'a'.repeat(64));
});

test('multipart envelope exact byte limit is inclusive', async () => {
  const original = multipart();
  const bytes = new Uint8Array(await original.arrayBuffer());
  const h = streamed([bytes], { 'content-type': original.headers.get('content-type')!, 'content-length': String(bytes.length) });
  const result = await readBoundedMultipartUpload(h.request, { ...limits, maxBodyBytes: bytes.length });
  assert.equal((result.get('file') as File).size, 5);
});

test('known oversized Content-Length is rejected without consuming any body bytes', async () => {
  const h = streamed([new Uint8Array(100)], {
    'content-type': 'multipart/form-data; boundary=x', 'content-length': '10000',
  });
  await assert.rejects(readBoundedMultipartUpload(h.request, limits), hasCode('TOO_LARGE'));
  assert.equal(h.reads(), 0);
});

for (const declared of [undefined, '1']) {
  test(`actual body is capped with Content-Length ${declared ?? 'absent'}`, async () => {
    const prefix = Buffer.from('--x\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\n');
    const h = streamed([prefix, Buffer.alloc(128), Buffer.alloc(128), Buffer.alloc(128)], {
      'content-type': 'multipart/form-data; boundary=x', ...(declared ? { 'content-length': declared } : {}),
    });
    await assert.rejects(readBoundedMultipartUpload(h.request, { ...limits, maxFileBytes: 1000, maxBodyBytes: prefix.length + 128 }), hasCode('TOO_LARGE'));
    assert.equal(h.reads(), 3);
    assert.equal(h.cancelled(), true);
  });
}

test('file payload cap stops an unfinished stream before reading its entire body', async () => {
  const prefix = Buffer.from('--x\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\n');
  const h = streamed([prefix, Buffer.alloc(65), ...Array.from({ length: 100 }, () => Buffer.alloc(64))], {
    'content-type': 'multipart/form-data; boundary=x',
  });
  await assert.rejects(readBoundedMultipartUpload(h.request, limits), hasCode('TOO_LARGE'));
  assert.ok(h.reads() < 5, `read ${h.reads()} chunks`);
  assert.equal(h.cancelled(), true);
});

test('empty file is preserved for route-specific validation without creating any temporary file', async () => {
  const result = await readBoundedMultipartUpload(multipart(new File([], 'empty.pdf')), limits);
  assert.equal((result.get('file') as File).size, 0);
});

test('fields are bounded by UTF-8 bytes and never silently truncated', async () => {
  await assert.rejects(readBoundedMultipartUpload(multipart(undefined, 'я'.repeat(17)), limits), hasCode('FIELD_TOO_LARGE'));
  const valid = await readBoundedMultipartUpload(multipart(undefined, 'я'.repeat(16)), limits);
  assert.equal(valid.get('title'), 'я'.repeat(16));
});

test('extra files, text fields and duplicate field names are rejected instead of silently ignored', async () => {
  for (const kind of ['file', 'field', 'duplicate'] as const) {
    const body = new FormData();
    body.append('file', new File(['a'], 'a.pdf'));
    body.append('title', 'valid');
    if (kind === 'file') body.append('other', new File(['b'], 'b.pdf'));
    else body.append(kind === 'duplicate' ? 'title' : 'other', 'unexpected');
    await assert.rejects(readBoundedMultipartUpload(await requestFromForm(body), limits), hasCode('TOO_MANY_PARTS'));
  }
  const body = new FormData();
  body.append('title', 'one'); body.append('title', 'two');
  await assert.rejects(readBoundedMultipartUpload(await requestFromForm(body), { ...limits, maxFields: 2 }), hasCode('INVALID_FIELD'));
});

test('unknown file and text names are rejected before building the form result', async () => {
  for (const value of ['text', new File(['a'], 'a.pdf')]) {
    const body = new FormData();
    body.append('unrecognized', value);
    await assert.rejects(readBoundedMultipartUpload(await requestFromForm(body), limits), hasCode('INVALID_FIELD'));
  }
});

test('one-byte transport chunks are coalesced without changing file contents', async () => {
  const original = multipart(new File(['a'.repeat(128 * 1024 + 7)], 'many-chunks.txt'));
  const bytes = new Uint8Array(await original.arrayBuffer());
  const h = streamed(Array.from(bytes, (byte) => new Uint8Array([byte])), {
    'content-type': original.headers.get('content-type')!,
  });
  const result = await readBoundedMultipartUpload(h.request, { ...limits, maxBodyBytes: 256 * 1024, maxFileBytes: 128 * 1024 + 7 });
  assert.equal(await (result.get('file') as File).text(), 'a'.repeat(128 * 1024 + 7));
});

test('invalid headers and unfinished multipart return a safe validation error', async () => {
  const headerCases: Record<string, string>[] = [
    { 'content-type': 'application/json' },
    { 'content-type': 'multipart/form-data;' },
    { 'content-type': 'multipart/form-data; boundary=x', 'content-length': 'not-a-number' },
  ];
  for (const headers of headerCases) {
    const h = streamed([Buffer.from('broken')], headers);
    await assert.rejects(readBoundedMultipartUpload(h.request, limits), hasCode('INVALID_MULTIPART'));
    assert.equal(h.reads(), 0);
  }
  const h = streamed([Buffer.from('--x\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\nunclosed')], {
    'content-type': 'multipart/form-data; boundary=x',
  });
  await assert.rejects(readBoundedMultipartUpload(h.request, limits), hasCode('INVALID_MULTIPART'));
});

test('oversized multipart headers are rejected by the streaming parser', async () => {
  const body = `--x\r\nContent-Disposition: form-data; name="file"; filename="${'a'.repeat(20_000)}"\r\n\r\nx\r\n--x--\r\n`;
  await assert.rejects(readBoundedMultipartUpload(new Request(url, {
    method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body,
  }), { ...limits, maxBodyBytes: 30_000 }), hasCode('INVALID_MULTIPART'));
});

test('idle stalled multipart is cancelled and the guard timeout survives parser wrapping', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const request = new Request(url, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body, duplex: 'half' } as RequestInit);
  await assert.rejects(readBoundedMultipartUpload(request, { ...limits, idleTimeoutMs: 20, totalTimeoutMs: 1000 }), hasCode('IDLE_TIMEOUT'));
  assert.equal(cancelled, true);
});

test('original request abort cancels multipart while retaining the explicit aborted error', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const request = new Request(url, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body, signal: controller.signal, duplex: 'half' } as RequestInit);
  const promise = readBoundedMultipartUpload(request, limits);
  controller.abort();
  await assert.rejects(promise, hasCode('ABORTED'));
  assert.equal(cancelled, true);
});

test('lost admission signal stops streaming even when the HTTP request is still connected', async () => {
  const admission = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const request = new Request(url, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body, duplex: 'half' } as RequestInit);
  const promise = readBoundedMultipartUpload(request, { ...limits, signal: admission.signal });
  admission.abort();
  await assert.rejects(promise, hasCode('ABORTED'));
  assert.equal(request.signal.aborted, false);
  assert.equal(cancelled, true);
});
