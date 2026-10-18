import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { createGunzip, gzipSync, type Gunzip } from 'node:zlib';
import test from 'node:test';
import * as streamParser from '@streamparser/json';
import ts from 'typescript';

import type * as dataUpload from '../src/app/api/admin/top-dashboard/blocks/dataUpload';
import { parsePositiveId } from '../src/app/api/admin/top-dashboard/blocks/routeUtils';
import * as dates from '../src/shared/lib/dashboardSnapshotDate';
import * as resourceGuard from '../src/shared/lib/snapshotJsonResourceGuard';
import * as dashboardLimits from '../src/shared/lib/topDashboardLimits';

const url = 'https://kts-impex.ru/api/admin/top-dashboard/blocks/4/data';
const source = readFileSync(path.join(process.cwd(), 'src/app/api/admin/top-dashboard/blocks/dataUpload.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function snapshotJson(noteLength = 0) {
  return Buffer.from(JSON.stringify({
    format: 'kts-bundle', version: 1, n: 1, dict: {}, cols: {},
    extra: { reserve: { rows: [] }, futureSection: { notes: 'x'.repeat(noteLength) } },
  }));
}

function loadUpload(options: {
  bytes: Buffer;
  compressed?: boolean;
  input?: Readable;
  processingClock?: () => number;
  processingLimit?: number;
  yieldEveryChunk?: boolean;
  onYield?: () => void;
}) {
  const name = options.compressed ? 'snapshot.json.gz' : 'snapshot.json';
  const input = options.input ?? Readable.from([options.bytes]);
  let discards = 0;
  let commits = 0;
  let yields = 0;
  let yieldClock = 0;
  const decompressors: Gunzip[] = [];
  const pending = {
    firstBytes: options.bytes.subarray(0, 2),
    fileSize: options.bytes.length,
    sha256: createHash('sha256').update(options.bytes).digest('hex'),
    temporaryPath: '/unused-synthetic-pending-snapshot',
    async discard() { discards += 1; },
    async commit() { commits += 1; throw new Error('Inspection must never activate data'); },
    preserve() { throw new Error('Inspection must never preserve data'); },
  };
  const dependencies: Record<string, unknown> = {
    crypto: { createHash },
    'node:fs': { createReadStream: () => input },
    'node:stream': { Readable },
    'node:stream/promises': { pipeline },
    'node:timers/promises': {
      async setImmediate() {
        yields += 1;
        options.onYield?.();
        await setImmediate();
      },
    },
    zlib: {
      createGunzip() {
        const decompressor = createGunzip();
        decompressors.push(decompressor);
        return decompressor;
      },
    },
    '@streamparser/json': streamParser,
    '@/shared/lib/topDashboardLimits': {
      ...dashboardLimits,
      TOP_DASHBOARD_JSON_RESOURCE_LIMITS: {
        ...dashboardLimits.TOP_DASHBOARD_JSON_RESOURCE_LIMITS,
        maxProcessingMs: options.processingLimit ?? dashboardLimits.TOP_DASHBOARD_JSON_RESOURCE_LIMITS.maxProcessingMs,
      },
    },
    '@/shared/lib/dashboardSnapshotDate': dates,
    '@/shared/lib/snapshotJsonResourceGuard': {
      ...resourceGuard,
      createSnapshotJsonResourceGuard(limits: resourceGuard.SnapshotJsonResourceLimits) {
        return resourceGuard.createSnapshotJsonResourceGuard(limits, { now: options.processingClock });
      },
    },
    './routeUtils': { parsePositiveId },
    './streamDataUpload': {
      readStreamOriginalName: () => name,
      readStreamExpectedActiveVersionId: () => ({ value: 84 }),
      receiveTopDashboardDataStream: async () => ({ pending }),
    },
  };
  const exports = {} as typeof dataUpload;
  runInNewContext(compiled, {
    exports, Buffer, File, TextDecoder, Request, Response, Error, console,
    performance: {
      now() {
        if (options.yieldEveryChunk) yieldClock += 10;
        return yieldClock;
      },
    },
    require(name: string) {
      assert.ok(name in dependencies, `Unexpected upload dependency: ${name}`);
      return dependencies[name];
    },
  });
  return {
    exports,
    input,
    decompressors,
    counters: () => ({ discards, commits, yields }),
    stream(signal?: AbortSignal) {
      const request = new Request(url, { method: 'PUT', signal });
      return exports.readTopDashboardDataStreamUpload(request);
    },
    multipart(signal?: AbortSignal) {
      const form = new FormData();
      form.set('expectedActiveVersionId', '84');
      form.set('file', new File([Uint8Array.from(options.bytes)], name));
      const request = new Request(url, { method: 'PUT', body: form, signal });
      return exports.readTopDashboardDataUpload(request);
    },
  };
}

function openStream(bytes: Buffer, error?: Error) {
  let sent = false;
  let destroys = 0;
  const input = new Readable({
    read() {
      if (sent) return;
      sent = true;
      this.push(bytes);
      // Leave the source open until either a real read error or signal abort.
      if (error) queueMicrotask(() => this.destroy(error));
    },
    destroy(error, callback) {
      destroys += 1;
      callback(error);
    },
  });
  return { input, destroys: () => destroys };
}

for (const compressed of [false, true]) {
  const label = compressed ? 'gzip' : 'plain JSON';

  test(`inspection propagates a source read failure and discards only the new pending file: ${label}`, async () => {
    const json = snapshotJson();
    const bytes = compressed ? gzipSync(json) : json;
    const source = openStream(bytes, new Error('synthetic disk read error'));
    const harness = loadUpload({ bytes, compressed, input: source.input });
    const result = await harness.stream();
    assert.equal(result.parsed, undefined);
    assert.ok(result.error);
    assert.equal(result.error.status, 400);
    assert.equal(source.input.destroyed, true);
    assert.equal(source.destroys(), 1);
    assert.deepEqual(harness.counters(), { discards: 1, commits: 0, yields: 0 });
    for (const decompressor of harness.decompressors) assert.equal(decompressor.destroyed, true);
  });

  test(`signal abort during inspection destroys the source and cleans up once: ${label}`, async () => {
    const controller = new AbortController();
    const json = snapshotJson(300_000);
    const bytes = compressed ? gzipSync(json) : json;
    const source = openStream(bytes);
    const harness = loadUpload({
      bytes, compressed, input: source.input, yieldEveryChunk: true,
      onYield: () => controller.abort(new Error('synthetic canceled request')),
    });
    const result = await harness.stream(controller.signal);
    assert.equal(result.parsed, undefined);
    assert.ok(result.error);
    assert.equal(source.input.destroyed, true);
    assert.equal(source.destroys(), 1);
    assert.equal(harness.counters().discards, 1);
    assert.equal(harness.counters().commits, 0);
    assert.ok(harness.counters().yields >= 1);
    for (const decompressor of harness.decompressors) assert.equal(decompressor.destroyed, true);
  });

  for (const streamed of [false, true]) {
    test(`active processing exhaustion maps to a clear 413 without parsing/activation: ${label}, ${streamed ? 'stream' : 'multipart'}`, async () => {
      const json = snapshotJson(20_000);
      const bytes = compressed ? gzipSync(json) : json;
      let clock = 0;
      const harness = loadUpload({
        bytes, compressed, processingLimit: 2,
        processingClock: () => { clock += 1; return clock; },
      });
      const result = streamed ? await harness.stream() : await harness.multipart();
      assert.equal(result.parsed, undefined);
      assert.ok(result.error);
      assert.equal(result.error.status, 413);
      const payload = await result.error.json() as { code: string; error: string };
      assert.equal(payload.code, 'JSON_PROCESSING_LIMIT');
      assert.match(payload.error, /время обработки/i);
      assert.match(payload.error, /Предыдущий снимок не измен[её]н/i);
      assert.equal(harness.counters().discards, streamed ? 1 : 0);
      assert.equal(harness.counters().commits, 0);
      if (streamed) assert.equal(harness.input.destroyed, true);
      for (const decompressor of harness.decompressors) assert.equal(decompressor.destroyed, true);
    });
  }
}

test('a large valid plain multipart snapshot yields the event loop and preserves every byte', async () => {
  const bytes = snapshotJson(resourceGuard.SNAPSHOT_JSON_PROCESSING_CHUNK_BYTES * 4);
  let heartbeatRan = false;
  const heartbeat = setImmediate().then(() => { heartbeatRan = true; });
  const harness = loadUpload({ bytes, yieldEveryChunk: true });
  const result = await harness.multipart();
  assert.equal(result.error, undefined);
  assert.ok(result.parsed);
  assert.equal(heartbeatRan, true, 'other event-loop work runs before inspection resolves');
  assert.ok(harness.counters().yields >= 4);
  assert.deepEqual(result.parsed.upload.content, bytes);
  assert.equal(result.parsed.upload.uncompressedSize, bytes.length);
  assert.equal(result.parsed.upload.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(harness.counters().commits, 0);
  assert.equal(harness.counters().discards, 0);
  await heartbeat;
});
