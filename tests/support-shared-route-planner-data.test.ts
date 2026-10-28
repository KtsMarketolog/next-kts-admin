import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createGzip, gzipSync } from 'node:zlib';
import test from 'node:test';

import { PersonalDashboardError } from '../src/shared/lib/managerDashboardDomain';
import {
  openVerifiedSupportSharedRoutePlannerFile,
  prepareSupportSharedRoutePlannerUpload,
  SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES,
  SUPPORT_SHARED_JSON_MAX_BYTES,
  SUPPORT_SHARED_JSON_MAX_VERSIONS,
  SUPPORT_SHARED_JSON_TOTAL_MAX_BYTES,
} from '../src/shared/lib/supportSharedRoutePlannerData';
import { deleteTopDashboardDataFiles } from '../src/shared/lib/topDashboardDataStorage';
import { createUploadRequestGuard } from '../src/shared/lib/uploadRequestGuard';
import { prepareSharedJsonUpload } from '../src/features/admin/manager-dashboard/sharedJsonUpload';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: true, app: 'компоновщик', savedAt: '2026-09-17T08:00:00.000Z',
    orders: [{ id: 'synthetic', infoParts: [{ date: null }] }], confirmed: [], zones: [], addrs: [],
    aliases: {}, contacts: [], tk: [], nomen: [], depots: [],
    opt: { maxPoints: 6, maxWeight: 0, maxVol: 0, innerKm: 15, splitByOrg: false, splitByWh: false },
    winding: 1.3, rate: 0,
    f: { from: '', to: '', ordFrom: '', ordTo: '', zone: [], org: [], dir: [], wh: [], author: [], onlyConfirmed: true },
    files: [], diag: {}, ...overrides,
  };
}

function request(bytes: Uint8Array = gzipSync(JSON.stringify(snapshot())), headers: Record<string, string> = {}) {
  return new Request('http://localhost/upload', {
    method: 'POST', headers: { 'content-type': 'application/gzip', ...headers }, body: new Uint8Array(bytes),
  });
}

function streamed(chunks: AsyncIterable<Buffer> | Iterable<Buffer>, compress = false) {
  const input = Readable.from(chunks);
  return new Request('http://localhost/upload', {
    method: 'POST', headers: { 'content-type': 'application/gzip' },
    body: Readable.toWeb(compress ? input.pipe(createGzip()) : input), duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

async function inStorage(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'support-route-json-'));
  const previous = process.env.TOP_DASHBOARD_DATA_DIR;
  process.env.TOP_DASHBOARD_DATA_DIR = directory;
  try { await action(directory); }
  finally {
    if (previous === undefined) delete process.env.TOP_DASHBOARD_DATA_DIR;
    else process.env.TOP_DASHBOARD_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function rejectsUpload(input: Request, code = 'INVALID_SNAPSHOT') {
  await assert.rejects(() => prepareSupportSharedRoutePlannerUpload(input), (error: unknown) => {
    assert.ok(error instanceof PersonalDashboardError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /synthetic|Unexpected|position|ENOENT|\/private\//);
    return true;
  });
}

test('route planner storage limits match the upload and retention contract', () => {
  assert.equal(SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES, 501 * 1024 * 1024);
  assert.equal(SUPPORT_SHARED_JSON_MAX_BYTES, 500 * 1024 * 1024);
  assert.equal(SUPPORT_SHARED_JSON_MAX_VERSIONS, 2);
  assert.equal(SUPPORT_SHARED_JSON_TOTAL_MAX_BYTES, 2 * 1024 * 1024 * 1024);
  assert.ok(SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES > SUPPORT_SHARED_JSON_MAX_BYTES, 'Gzip overhead must not reject valid incompressible source JSON');
  assert.ok(SUPPORT_SHARED_JSON_TOTAL_MAX_BYTES >= 2 * SUPPORT_SHARED_JSON_MAX_VERSIONS * SUPPORT_SHARED_JSON_MAX_BYTES,
    'Both the current and previous HTML publication can retain their current and previous JSON');
});

test('gzip upload preserves JSON bytes, uses private files, and supports commit/preserve/delete', async () => {
  await inStorage(async (directory) => {
    const plain = Buffer.from(` \n${JSON.stringify(snapshot(), null, 2)}\n`);
    const { pending, savedAt } = await prepareSupportSharedRoutePlannerUpload(request(gzipSync(plain)));
    assert.equal(savedAt, '2026-09-17T08:00:00.000Z');
    assert.equal(pending.fileSize, plain.length);
    assert.equal(pending.sha256, createHash('sha256').update(plain).digest('hex'));
    assert.deepEqual(await readFile(pending.temporaryPath), plain);
    assert.equal((await stat(pending.temporaryPath)).mode & 0o777, 0o600);
    const storagePath = await pending.commit();
    assert.equal(await pending.commit(), storagePath);
    pending.preserve();
    await pending.discard();
    const stream = await openVerifiedSupportSharedRoutePlannerFile(storagePath, pending.fileSize, pending.sha256);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), plain);
    await deleteTopDashboardDataFiles([storagePath]);
    await assert.rejects(stat(path.join(directory, storagePath)), { code: 'ENOENT' });
  });
});

test('supports one-byte transport chunks and valid UTC timestamps without milliseconds', async () => {
  await inStorage(async () => {
    const bytes = gzipSync(JSON.stringify(snapshot({ savedAt: '2026-09-17T08:00:00Z', orders: [{ text: 'Тест 🚚' }] })));
    const prepared = await prepareSupportSharedRoutePlannerUpload(streamed(Array.from(bytes, (byte) => Buffer.from([byte]))));
    assert.equal(prepared.savedAt, '2026-09-17T08:00:00Z');
    await prepared.pending.discard();
  });
});

test('ordinary JSON and ready json.gz reach private storage as the same original JSON bytes', async () => {
  await inStorage(async () => {
    const plain = Buffer.from(` \n${JSON.stringify(snapshot({ orders: [{ id: 'gzip-fixture', label: 'Снимок 🚚' }] }), null, 2)}\n`);
    const archive = gzipSync(plain);
    for (const [name, bytes] of [['снимок.json', plain], ['снимок.JSON.GZ', archive]] as const) {
      const body = await prepareSharedJsonUpload(new File([new Uint8Array(bytes)], name, { type: 'application/octet-stream' }));
      if (/\.gz$/i.test(name)) assert.deepEqual(Buffer.from(await body.arrayBuffer()), archive, 'ready archive is never recompressed');
      const prepared = await prepareSupportSharedRoutePlannerUpload(new Request('http://localhost/upload', {
        method: 'POST', headers: { 'content-type': 'application/gzip' }, body,
      }));
      assert.equal(prepared.pending.fileSize, plain.length);
      assert.equal(prepared.pending.sha256, createHash('sha256').update(plain).digest('hex'));
      assert.deepEqual(await readFile(prepared.pending.temporaryPath), plain);
      await prepared.pending.discard();
    }
  });
});

test('ready archives with damaged CRC, truncation or nested gzip cannot replace the retained JSON', async () => {
  await inStorage(async directory => {
    const previous = await prepareSupportSharedRoutePlannerUpload(request());
    const previousPath = await previous.pending.commit();
    previous.pending.preserve();
    const previousBytes = await readFile(path.join(directory, previousPath));
    const archive = gzipSync(JSON.stringify(snapshot()));
    const badCrc = Buffer.from(archive);
    badCrc[badCrc.length - 8] ^= 1;
    for (const bytes of [badCrc, archive.subarray(0, archive.length - 4), gzipSync(archive)]) {
      const body = await prepareSharedJsonUpload(new File([new Uint8Array(bytes)], 'повреждённый.json.gz'));
      await rejectsUpload(new Request('http://localhost/upload', {
        method: 'POST', headers: { 'content-type': 'application/gzip' }, body,
      }));
      assert.deepEqual(await readdir(path.join(directory, '.incoming')), []);
      assert.deepEqual(await readFile(path.join(directory, previousPath)), previousBytes);
    }
  });
});

test('guarded shared uploads settle decompression and file cleanup on stalls, aborts and lying lengths', {timeout: 5_000}, async () => {
  await inStorage(async (directory) => {
    const existing = await prepareSupportSharedRoutePlannerUpload(request());
    const existingPath = await existing.pending.commit();
    existing.pending.preserve();
    const previousBytes = await readFile(path.join(directory, existingPath));
    const gzip = gzipSync(JSON.stringify(snapshot()));
    for (const scenario of ['initial-stall', 'midstream-stall', 'disconnect', 'oversize'] as const) {
      let canceled = false;
      const abort = new AbortController();
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          if (scenario === 'midstream-stall') controller.enqueue(gzip.subarray(0, gzip.length - 4));
          if (scenario === 'oversize') controller.enqueue(gzip);
        },
        cancel() {
          canceled = true;
          // A broken producer must not keep the validated-file pipeline or slot alive.
          return new Promise<void>(() => {});
        },
      });
      const guarded = createUploadRequestGuard(new Request('http://localhost/upload', {
        method: 'POST', headers: {'content-type': 'application/gzip', 'content-length': '1'},
        body: source, signal: abort.signal, duplex: 'half',
      } as RequestInit & {duplex: 'half'}), {
        maxBytes: scenario === 'oversize' ? 16 : SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES,
        idleTimeoutMs: 30, totalTimeoutMs: 2_000,
      });
      const abortTimer = scenario === 'disconnect' ? setTimeout(() => abort.abort(), 10) : undefined;
      try {
        await assert.rejects(prepareSupportSharedRoutePlannerUpload(guarded.request));
        assert.equal(guarded.error?.code, scenario === 'oversize' ? 'TOO_LARGE' : scenario === 'disconnect' ? 'ABORTED' : 'IDLE_TIMEOUT');
        assert.equal(canceled, true);
        assert.deepEqual(await readdir(path.join(directory, '.incoming')), []);
        assert.deepEqual(await readFile(path.join(directory, existingPath)), previousBytes);
      } finally {
        if (abortTimer !== undefined) clearTimeout(abortTimer);
        guarded.dispose();
      }
      // The next valid upload still completes using the same storage.
      const next = await prepareSupportSharedRoutePlannerUpload(request());
      await next.pending.discard();
    }
  });
});

test('rejects incomplete documents, malformed gzip/JSON, invalid UTF-8 and trailing documents; clears pending storage', async () => {
  await inStorage(async (directory) => {
    const json = JSON.stringify(snapshot());
    const gzip = gzipSync(json);
    for (const bytes of [Buffer.alloc(0), Buffer.from(json), gzip.subarray(0, gzip.length - 6),
      gzipSync(json.slice(0, -1)), gzipSync(`${json}{}`), gzipSync(json.replace('"snapshot":true', '"snapshot":true,')),
      gzipSync(Buffer.concat([Buffer.from('{"bad":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')])),
      gzipSync('[]'), gzipSync('null'), gzipSync('{}')]) {
      await rejectsUpload(request(bytes));
      assert.deepEqual(await readdir(path.join(directory, '.incoming')), []);
    }
  });
});

test('requires the full export shape including arrays, settings and safe row types', async () => {
  await inStorage(async () => {
    for (const overrides of [
      { snapshot: false }, { app: 'another application' }, { orders: {} }, { orders: [null] },
      { confirmed: [1] }, { zones: 'x' }, { files: null }, { depots: {} }, { aliases: { test: {} } },
      { opt: [] }, { opt: {} }, { opt: { ...snapshot().opt, splitByOrg: 1 } },
      { f: {} }, { f: { ...snapshot().f, org: [1] } }, { diag: { rows: {} } }, { rate: -1 }, { winding: '1' },
    ]) await rejectsUpload(request(gzipSync(JSON.stringify(snapshot(overrides)))));
    for (const key of Object.keys(snapshot())) {
      const incomplete = { ...snapshot() } as Record<string, unknown>;
      delete incomplete[key];
      await rejectsUpload(request(gzipSync(JSON.stringify(incomplete))));
    }
  });
});

test('rejects duplicate control/settings fields and prototype pollution at every nesting level', async () => {
  await inStorage(async () => {
    const json = JSON.stringify(snapshot());
    for (const changed of [
      json.replace('"snapshot":true', '"snapshot":true,"snapshot":true'),
      json.replace('"maxPoints":6', '"maxPoints":6,"maxPoints":6'),
      json.replace('"orders":[', '"orders":[{"__proto__":{}},'),
      json.replace('"orders":[', '"orders":[{"constructor":{}},'),
      json.replace('"orders":[', '"orders":[{"prototype":{}},'),
      json.replace('"rate":0', '"rate":1e999'),
    ]) await rejectsUpload(request(gzipSync(changed)));
  });
});

test('rejects missing, impossible, normalized and non-ISO savedAt dates', async () => {
  await inStorage(async () => {
    for (const savedAt of [null, '', 1, 'yesterday', '2026-09-17', '2026-02-30T08:00:00.000Z',
      '2026-09-17T24:00:00.000Z', '2026-09-17T08:00:00.000', '2026-13-17T08:00:00.000Z']) {
      await rejectsUpload(request(gzipSync(JSON.stringify(snapshot({ savedAt })))), 'INVALID_DATE');
    }
  });
});

test('bounds nesting, individual strings/numbers, properties and array members before retaining large values', async () => {
  await inStorage(async () => {
    const json = JSON.stringify(snapshot());
    for (const extra of ['['.repeat(65) + '0' + ']'.repeat(65), JSON.stringify('x'.repeat(1024 * 1024)),
      '1'.repeat(129), `[${'0,'.repeat(1_000_000)}0]`,
      `{${Array.from({ length: 100_001 }, (_, index) => `"k${index}":0`).join(',')}}`]) {
      await rejectsUpload(request(gzipSync(json.replace('"diag":{}', `"extra":${extra},"diag":{}`))), 'SNAPSHOT_SIZE');
    }
  });
});

test('rejects unsupported transport and enforces compressed limits with and without Content-Length', async () => {
  await inStorage(async () => {
    await rejectsUpload(request(undefined, { 'content-type': 'application/json' }));
    await rejectsUpload(request(undefined, { 'content-encoding': 'gzip' }));
    await rejectsUpload(request(undefined, { 'content-length': String(SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES + 1) }), 'SNAPSHOT_SIZE');
    function* paddedGzip() {
      yield gzipSync(JSON.stringify(snapshot()));
      const padding = Buffer.alloc(64 * 1024);
      for (let size = 0; size <= SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES; size += padding.length) yield padding;
    }
    await rejectsUpload(streamed(paddedGzip()), 'SNAPSHOT_SIZE');
  });
});

test('accepts exactly 500 MiB, then stops a gzip expansion at the next byte without touching the retained file', async () => {
  await inStorage(async (directory) => {
    function* paddedSnapshot(size: number) {
      const json = Buffer.from(JSON.stringify(snapshot()));
      yield json;
      const spaces = Buffer.alloc(64 * 1024, 0x20);
      for (let offset = json.length; offset < size; offset += spaces.length) yield spaces.subarray(0, Math.min(spaces.length, size - offset));
    }
    const { pending } = await prepareSupportSharedRoutePlannerUpload(streamed(paddedSnapshot(SUPPORT_SHARED_JSON_MAX_BYTES), true));
    assert.equal(pending.fileSize, SUPPORT_SHARED_JSON_MAX_BYTES);
    const storagePath = await pending.commit();
    pending.preserve();
    await rejectsUpload(streamed(paddedSnapshot(SUPPORT_SHARED_JSON_MAX_BYTES + 1), true), 'SNAPSHOT_SIZE');
    assert.deepEqual(await readdir(path.join(directory, '.incoming')), []);
    assert.equal((await stat(path.join(directory, storagePath))).size, SUPPORT_SHARED_JSON_MAX_BYTES);
    const verified = await openVerifiedSupportSharedRoutePlannerFile(storagePath, pending.fileSize, pending.sha256);
    verified.destroy();
  });
});

test('streams a synthetic export above the old 100 MiB limit without materializing its document', async () => {
  await inStorage(async () => {
    const template = JSON.stringify(snapshot({ orders: [] }));
    const [before, after] = template.split('"orders":[]');
    function* rows() {
      yield Buffer.from(`${before}"orders":[`);
      const row = JSON.stringify({ id: 'synthetic', label: 'x'.repeat(2600) });
      for (let index = 0; index < 42_568; index++) yield Buffer.from((index ? ',' : '') + row);
      yield Buffer.from(`]${after}`);
    }
    const { pending } = await prepareSupportSharedRoutePlannerUpload(streamed(rows(), true));
    assert.ok(pending.fileSize > 100 * 1024 * 1024);
    await pending.discard();
  });
});

test('integrity reads reject wrong size/hash, tampering, missing files and unsafe storage paths', async () => {
  await inStorage(async (directory) => {
    const { pending } = await prepareSupportSharedRoutePlannerUpload(request());
    const storagePath = await pending.commit();
    for (const [filename, size, hash] of [[storagePath, pending.fileSize + 1, pending.sha256],
      [storagePath, pending.fileSize, '0'.repeat(64)], ['../outside', pending.fileSize, pending.sha256]] as const) {
      await assert.rejects(openVerifiedSupportSharedRoutePlannerFile(filename, size, hash), { code: 'SNAPSHOT_INTEGRITY' });
    }
    const bytes = await readFile(path.join(directory, storagePath));
    bytes[0] ^= 1;
    await writeFile(path.join(directory, storagePath), bytes);
    await assert.rejects(openVerifiedSupportSharedRoutePlannerFile(storagePath, pending.fileSize, pending.sha256), { code: 'SNAPSHOT_INTEGRITY' });
    await pending.discard();
    await assert.rejects(openVerifiedSupportSharedRoutePlannerFile(storagePath, pending.fileSize, pending.sha256), { code: 'SNAPSHOT_INTEGRITY' });
  });
});

test('verified response keeps its original descriptor when the storage pathname is replaced', async () => {
  await inStorage(async (directory) => {
    const { pending } = await prepareSupportSharedRoutePlannerUpload(request());
    const storagePath = await pending.commit();
    const stream = await openVerifiedSupportSharedRoutePlannerFile(storagePath, pending.fileSize, pending.sha256);
    const absolutePath = path.join(directory, storagePath);
    await rename(absolutePath, `${absolutePath}.original`);
    await writeFile(absolutePath, 'replacement');
    const hash = createHash('sha256');
    for await (const chunk of stream) hash.update(chunk);
    assert.equal(hash.digest('hex'), pending.sha256);
    await pending.discard();
  });
});
