import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import ts from 'typescript';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'kts-firmware-download-'));
  const bytes = Buffer.from('synthetic-firmware-0123456789');
  const filename = path.join(root, 'source');
  await writeFile(filename, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let lastHandle: Awaited<ReturnType<typeof open>>;
  const exports: Record<string, (request: Request, kind: string) => Promise<Response>> = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/shared/lib/firmwareDownload.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'exports', code)((name: string) => {
    if (name === 'node:stream') return { Readable };
    assert.equal(name, './firmwareStorage');
    return { openFirmwareDownload: async () => {
      lastHandle = await open(filename, 'r');
      return { handle: lastHandle, size: bytes.length, sha256, modifiedAt: new Date('2026-01-01T00:00:00Z'), fileName: 'hse_gen_1.c23' };
    } };
  }, exports);
  return { bytes, sha256,
    get: (headers: Record<string, string> = {}, method = 'GET') => exports.firmwareDownloadResponse(new Request('http://test/firmware', { method, headers }), 'c23'),
    closed: () => assert.equal(lastHandle.fd, -1), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('firmware download streams full bytes with matching length/hash and no-store', async () => {
  const f = await fixture();
  try {
    const response = await f.get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(f.bytes.length));
    assert.equal(response.headers.get('etag'), `"${f.sha256}"`);
    assert.match(response.headers.get('cache-control')!, /no-store/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  } finally { await f.cleanup(); }
});

test('firmware HEAD and 304 close their descriptor without a body', async () => {
  const f = await fixture();
  try {
    const head = await f.get({}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('content-length'), String(f.bytes.length));
    f.closed();
    const unchanged = await f.get({ 'if-none-match': `W/"${f.sha256}"` });
    assert.equal(unchanged.status, 304);
    f.closed();
  } finally { await f.cleanup(); }
});

test('firmware single byte ranges support fixed, open and suffix forms', async () => {
  const f = await fixture();
  try {
    for (const [range, start, end] of [['bytes=2-5', 2, 5], ['bytes=10-', 10, f.bytes.length - 1], ['bytes=-4', f.bytes.length - 4, f.bytes.length - 1]] as const) {
      const response = await f.get({ range });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${f.bytes.length}`);
      assert.equal(Number(response.headers.get('content-length')), end - start + 1);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.subarray(start, end + 1));
    }
    const stale = await f.get({ range: 'bytes=2-5', 'if-range': '"old"' });
    assert.equal(stale.status, 200);
    assert.deepEqual(Buffer.from(await stale.arrayBuffer()), f.bytes);
  } finally { await f.cleanup(); }
});

test('firmware invalid/unsatisfiable ranges return 416 and close the descriptor', async () => {
  const f = await fixture();
  try {
    for (const range of ['bytes=-0', 'bytes=-', 'bytes=8-2', 'bytes=999-', 'bytes=0-1,5-6', 'bytes=9007199254740992-']) {
      const response = await f.get({ range });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get('content-range'), `bytes */${f.bytes.length}`);
      f.closed();
    }
  } finally { await f.cleanup(); }
});
