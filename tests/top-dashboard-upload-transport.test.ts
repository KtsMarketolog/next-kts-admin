import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import * as nativeUpload from '../src/app/api/admin/top-dashboard/blocks/dataUpload';
import * as multiUpload from '../src/app/api/admin/top-dashboard/blocks/multiFileDataUpload';
import * as routeUtils from '../src/app/api/admin/top-dashboard/blocks/routeUtils';
import * as streamUpload from '../src/app/api/admin/top-dashboard/blocks/streamDataUpload';
import * as dashboardErrors from '../src/shared/lib/db/topDashboardDomain';
import { TopDashboardBlockNotFoundError, TopDashboardDataStorageLimitError } from '../src/shared/lib/db/topDashboardBlocksRepo';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';
import * as contentSecurity from '../src/shared/lib/topDashboardContentSecurity';
import { writeTopDashboardRequestToPendingFile, type PendingTopDashboardDataFile } from '../src/shared/lib/topDashboardDataStorage';
import * as uploadLimits from '../src/shared/lib/topDashboardLimits';
import { encodeTopDashboardMultiFileSnapshot } from '../src/shared/lib/topDashboardMultiFileSnapshot';
import { detectTopDashboardUploadTargets } from '../src/shared/lib/topDashboardUploadTargets';
import * as requestGuard from '../src/shared/lib/uploadRequestGuard';

const url = 'https://kts-impex.ru/api/admin/top-dashboard/blocks/4/data';
const modes = [
  { name: 'native multipart', generic: false, streamed: false, direct: false },
  { name: 'universal multipart', generic: true, streamed: false, direct: false },
  { name: 'native raw', generic: false, streamed: true, direct: false },
  { name: 'universal raw', generic: true, streamed: true, direct: false },
  { name: 'direct universal raw', generic: true, streamed: true, direct: true },
] as const;
type Mode = typeof modes[number];

const nativeBytes = Buffer.from(JSON.stringify({
  format: 'kts-bundle', version: 1, n: 1, dict: {}, cols: {},
  extra: { reserve: {}, futureSection: { allowed: true } },
}));
const genericBytes = Buffer.from(encodeTopDashboardMultiFileSnapshot({ targets: [{
  target: { id: 'file', index: 0 },
  files: [{ name: 'future.json', bytes: Buffer.from('{"future":"unchanged"}') }],
}] }));

function validRequest(mode: Mode) {
  const headers: Record<string, string> = { origin: 'https://kts-impex.ru' };
  if (mode.generic) headers['x-kts-top-dashboard-multi-file'] = '1';
  if (mode.direct) headers['x-kts-top-dashboard-direct-files'] = '1';
  const bytes = mode.generic ? genericBytes : nativeBytes;
  if (mode.streamed) {
    headers['x-kts-top-data-protocol'] = 'stream-v1';
    headers['x-kts-top-data-name'] = mode.generic ? 'dashboard-files.ktsmf' : 'snapshot.json';
    headers['x-kts-top-data-expected-version'] = '84';
    headers[streamUpload.TOP_DASHBOARD_STREAM_HTML_VERSION_HEADER] = '66';
    return new Request(url, { method: 'PUT', headers, body: bytes });
  }
  const form = new FormData();
  form.set('file', new File([bytes], mode.generic ? 'dashboard-files.ktsmf' : 'snapshot.json'));
  form.set('expectedActiveVersionId', '84');
  if (mode.generic) form.set('expectedActiveHtmlVersionId', '66');
  return new Request(url, { method: 'PUT', headers, body: form });
}

function withBody(original: Request, body: ReadableStream<Uint8Array>, contentLength?: string, signal?: AbortSignal) {
  const headers = new Headers(original.headers);
  headers.delete('content-length');
  if (contentLength !== undefined) headers.set('content-length', contentLength);
  return new Request(original.url, {
    method: original.method, headers, body, signal, duplex: 'half',
  } as RequestInit);
}

async function withStorage(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kts-upload-transport-'));
  const previousDirectory = process.env.TOP_DASHBOARD_DATA_DIR;
  process.env.TOP_DASHBOARD_DATA_DIR = directory;
  // Test an unresponsive source without depending on whether guard timers keep
  // the otherwise idle test process alive.
  const keepAlive = setInterval(() => {}, 100);
  try {
    const oldBytes = Buffer.from('existing working snapshot: never replace after rejected upload');
    const old = await writeTopDashboardRequestToPendingFile(new Request(url, { method: 'PUT', body: oldBytes }), oldBytes.length);
    const oldPath = path.join(directory, await old.commit());
    old.preserve();
    await run(directory);
    assert.deepEqual(await readFile(oldPath), oldBytes);
    assert.deepEqual(await readdir(path.join(directory, '.incoming')), []);
  } finally {
    clearInterval(keepAlive);
    if (previousDirectory === undefined) delete process.env.TOP_DASHBOARD_DATA_DIR;
    else process.env.TOP_DASHBOARD_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
}

function routeHarness(mode: Mode, directory: string, options: {
  maxBytes?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  afterReadDelayMs?: number;
  commitDelayMs?: number;
  databaseDelayMs?: number;
} = {}) {
  let held = false;
  let activations = 0;
  let releases = 0;
  let expectedVersion = 84;
  const selectedLimits: number[] = [];
  const calls: string[] = [];
  const stored: Array<{ content: Buffer | null; storagePath: string | null }> = [];
  const afterRead = async <T extends { parsed?: { upload: { pendingFile?: PendingTopDashboardDataFile } } }>(result: T): Promise<T> => {
    const pending = result.parsed?.upload.pendingFile;
    if (pending) {
      const commit = pending.commit.bind(pending);
      const discard = pending.discard.bind(pending);
      pending.commit = async () => {
        calls.push('commit');
        const result = await commit();
        if (options.commitDelayMs) await delay(options.commitDelayMs);
        return result;
      };
      pending.discard = async () => { calls.push('discard'); await discard(); };
    }
    if (result.parsed && options.afterReadDelayMs) await delay(options.afterReadDelayMs);
    return result;
  };
  const dependencies: Record<string, unknown> = {
    'node:stream': { Readable },
    '@/shared/lib/dashboardAccess': {},
    '@/shared/lib/adminAuth': {
      async requireTopDashboardManagementSession() { return { denied: null, session: { role: 'admin', adminUserId: 1 } }; },
      getTopDashboardActor() { return { adminUserId: 1, managerId: null }; },
    },
    '@/shared/lib/adminSecurity': { async enforceAdminActionRateLimit() { return null; } },
    '@/shared/lib/db': {
      ...dashboardErrors, TopDashboardBlockNotFoundError, TopDashboardDataStorageLimitError,
      async getTopDashboardBlockOverview() { return { activeVersionId: 66 }; },
      async getTopDashboardBlockVersionContent() {
        return { htmlContent: mode.generic
          ? '<input id="file" type="file" multiple>'
          : '<script>const DASH_NAME="аналитика_продаж"; const snapshot={format:"kts-bundle"};</script>' };
      },
      async createAndActivateTopDashboardBlockDataVersion(input: { content: Buffer | null; storagePath: string | null }) {
        if (options.databaseDelayMs) await delay(options.databaseDelayMs);
        calls.push('activate');
        activations += 1;
        stored.push(input);
        expectedVersion += 1;
        return { version: { id: expectedVersion, ...input }, activeVersionId: expectedVersion,
          previousVersionId: expectedVersion - 1, prunedStoragePaths: [], prunedVersionIds: [], updatedAt: '2026-10-18' };
      },
    },
    '@/shared/lib/db/securityAuditRepo': { async recordSecurityEvent() {} },
    '@/shared/lib/dashboardUploadUsage': { getDashboardUploadUsageActor: () => ({actorKey: 'admin:1', actorRole: 'admin'}), scheduleDashboardUploadUsageDrain() {} },
    '@/shared/lib/originProtection': { enforceSameOriginRequest },
    '@/shared/lib/rateLimit': { getClientIp() { return '127.0.0.1'; } },
    '@/shared/lib/topDashboardDataStorage': {},
    '@/shared/lib/topDashboardContentSecurity': { ...contentSecurity, isTopDashboardBlockDataMutationFrameRequest() { return true; } },
    '@/shared/lib/topDashboardLimits': uploadLimits,
    '@/shared/lib/topDashboardUploadConcurrency': {
      async acquireDistributedTopDashboardDataUploadSlot() {
        if (held) return null;
        held = true;
        calls.push('slot');
        return async () => {
          assert.deepEqual(await readdir(path.join(directory, '.incoming')), [], 'cleanup must finish BEFORE unlocking');
          calls.push('release'); releases += 1; held = false;
        };
      },
    },
    '@/shared/lib/uploadRequestGuard': {
      ...requestGuard,
      createUploadRequestGuard(request: Request, settings: requestGuard.UploadRequestGuardOptions) {
        selectedLimits.push(settings.maxBytes);
        return requestGuard.createUploadRequestGuard(request, {
          ...settings,
          maxBytes: options.maxBytes ?? settings.maxBytes,
          idleTimeoutMs: options.idleTimeoutMs ?? 500,
          totalTimeoutMs: options.totalTimeoutMs ?? 5_000,
        });
      },
    },
    '@/shared/lib/topDashboardUploadTargets': { detectTopDashboardUploadTargets },
    '../../dataUpload': {
      ...nativeUpload,
      async readTopDashboardDataUpload(...args: Parameters<typeof nativeUpload.readTopDashboardDataUpload>) { return afterRead(await nativeUpload.readTopDashboardDataUpload(...args)); },
      async readTopDashboardDataStreamUpload(...args: Parameters<typeof nativeUpload.readTopDashboardDataStreamUpload>) { return afterRead(await nativeUpload.readTopDashboardDataStreamUpload(...args)); },
    },
    '../../multiFileDataUpload': {
      ...multiUpload,
      async readTopDashboardMultiFileDataUpload(...args: Parameters<typeof multiUpload.readTopDashboardMultiFileDataUpload>) { return afterRead(await multiUpload.readTopDashboardMultiFileDataUpload(...args)); },
      async readTopDashboardMultiFileDataStreamUpload(...args: Parameters<typeof multiUpload.readTopDashboardMultiFileDataStreamUpload>) { return afterRead(await multiUpload.readTopDashboardMultiFileDataStreamUpload(...args)); },
    },
    '../../routeUtils': routeUtils,
    '../../streamDataUpload': streamUpload,
  };
  const exports: { PUT?: (request: Request, context: { params: Promise<{ blockId: string }> }) => Promise<Response> } = {};
  const source = readFileSync(path.join(process.cwd(), 'src/app/api/admin/top-dashboard/blocks/[blockId]/data/route.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, {
    exports, Response, console: { ...console, error() {} },
    require(name: string) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; },
  });
  return {
    calls, selectedLimits, stored,
    state: () => ({ held, activations, releases, expectedVersion }),
    put: (request: Request) => exports.PUT!(request, { params: Promise.resolve({ blockId: '4' }) }),
  };
}

for (const mode of modes) {
  test(`transport caps and unchanged successful bytes: ${mode.name}`, async () => {
    await withStorage(async (directory) => {
      const route = routeHarness(mode, directory);
      const response = await route.put(validRequest(mode));
      assert.equal(response.status, 201, await response.text());
      assert.deepEqual(route.selectedLimits, [mode.streamed
        ? mode.generic ? uploadLimits.TOP_DASHBOARD_DATA_STORED_MAX_BYTES : uploadLimits.TOP_DASHBOARD_DATA_MAX_BYTES
        : uploadLimits.TOP_DASHBOARD_DATA_MULTIPART_MAX_BYTES + uploadLimits.TOP_DASHBOARD_DATA_MULTIPART_OVERHEAD_BYTES]);
      const saved = route.stored[0]!;
      assert.deepEqual(saved.storagePath ? await readFile(path.join(directory, saved.storagePath)) : saved.content,
        mode.generic ? genericBytes : nativeBytes);
      assert.deepEqual(route.state(), { held: false, activations: 1, releases: 1, expectedVersion: 85 });
    });
  });

  for (const contentLength of [undefined, '1']) {
    test(`actual bytes override ${contentLength ? 'false' : 'missing'} Content-Length: ${mode.name}`, async () => {
      await withStorage(async (directory) => {
        const valid = validRequest(mode);
        const encoded = new Uint8Array(await valid.arrayBuffer());
        let cancelled = false;
        const route = routeHarness(mode, directory, { maxBytes: encoded.length - 1 });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(encoded); },
          cancel() { cancelled = true; },
        });
        const response = await route.put(withBody(valid, stream, contentLength));
        assert.equal(response.status, 413, await response.text());
        assert.equal(cancelled, true);
        assert.deepEqual(route.state(), { held: false, activations: 0, releases: 1, expectedVersion: 84 });
      });
    });
  }

  test(`stalled upload releases slot only after cleanup; following admin can upload: ${mode.name}`, async () => {
    await withStorage(async (directory) => {
      const valid = validRequest(mode);
      const encoded = new Uint8Array(await valid.arrayBuffer());
      let cancelled = false;
      const route = routeHarness(mode, directory, { idleTimeoutMs: 40 });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(encoded.subarray(0, Math.max(1, encoded.length - 4))); },
        cancel() { cancelled = true; return new Promise<void>(() => {}); },
      });
      const first = route.put(withBody(valid, stream));
      await delay(10);
      assert.equal((await route.put(validRequest(mode))).status, 409, 'parallel heavy upload remains blocked');
      const response = await first;
      assert.equal(response.status, 408, await response.text());
      assert.equal(cancelled, true);
      assert.deepEqual(route.state(), { held: false, activations: 0, releases: 1, expectedVersion: 84 });
      assert.equal((await route.put(validRequest(mode))).status, 201);
      assert.deepEqual(route.state(), { held: false, activations: 1, releases: 2, expectedVersion: 85 });
    });
  });

  test(`client disconnect aborts without changing active data: ${mode.name}`, async () => {
    await withStorage(async (directory) => {
      const controller = new AbortController();
      const route = routeHarness(mode, directory);
      const stream = new ReadableStream<Uint8Array>({});
      const result = route.put(withBody(validRequest(mode), stream, undefined, controller.signal));
      await delay(10);
      controller.abort();
      const response = await result;
      const payload = await response.json();
      assert.equal(response.status, 400, JSON.stringify(payload));
      assert.equal(payload.code, 'ABORTED');
      assert.deepEqual(route.state(), { held: false, activations: 0, releases: 1, expectedVersion: 84 });
    });
  });
}

for (const phase of ['afterReadDelayMs', 'commitDelayMs'] as const) {
  test(`deadline ${phase} cleans parsed/renamed file before activation and release`, async () => {
    await withStorage(async (directory) => {
      const route = routeHarness(modes[2], directory, { totalTimeoutMs: 100, [phase]: 130 });
      const response = await route.put(validRequest(modes[2]));
      assert.equal(response.status, 408, await response.text());
      assert.deepEqual(route.state(), { held: false, activations: 0, releases: 1, expectedVersion: 84 });
      assert.ok(route.calls.indexOf('discard') < route.calls.indexOf('release'));
      const shards = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^[a-f0-9]{2}$/.test(entry.name));
      const finalFiles = (await Promise.all(shards.map((entry) => readdir(path.join(directory, entry.name))))).flat();
      assert.equal(finalFiles.length, 1, 'only the original preserved snapshot may remain after a rejected rename');
    });
  });
}

test('transport deadline is stopped before database activation, not after an uncertain commit', async () => {
  await withStorage(async (directory) => {
    const route = routeHarness(modes[2], directory, { totalTimeoutMs: 100, databaseDelayMs: 130 });
    const response = await route.put(validRequest(modes[2]));
    assert.equal(response.status, 201, await response.text());
    assert.deepEqual(route.state(), { held: false, activations: 1, releases: 1, expectedVersion: 85 });
    const saved = route.stored[0]!;
    assert.deepEqual(await readFile(path.join(directory, saved.storagePath!)), nativeBytes);
  });
});
