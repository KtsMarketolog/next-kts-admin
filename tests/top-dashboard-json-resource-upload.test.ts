import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import ts from 'typescript';

import * as dataUpload from '../src/app/api/admin/top-dashboard/blocks/dataUpload';
import * as multiFileUpload from '../src/app/api/admin/top-dashboard/blocks/multiFileDataUpload';
import * as routeUtils from '../src/app/api/admin/top-dashboard/blocks/routeUtils';
import * as streamUpload from '../src/app/api/admin/top-dashboard/blocks/streamDataUpload';
import * as dashboardErrors from '../src/shared/lib/db/topDashboardDomain';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';
import * as contentSecurity from '../src/shared/lib/topDashboardContentSecurity';
import { writeTopDashboardRequestToPendingFile } from '../src/shared/lib/topDashboardDataStorage';
import { TOP_DASHBOARD_JSON_RESOURCE_LIMITS as limits } from '../src/shared/lib/topDashboardLimits';
import * as dashboardLimits from '../src/shared/lib/topDashboardLimits';
import * as uploadRequestGuard from '../src/shared/lib/uploadRequestGuard';

const url = 'https://kts-impex.ru/api/admin/top-dashboard/blocks/4/data';
const modes = [
  { compressed: false, streamed: false, label: 'plain multipart' },
  { compressed: true, streamed: false, label: 'gzip multipart' },
  { compressed: false, streamed: true, label: 'plain stream' },
  { compressed: true, streamed: true, label: 'gzip stream' },
] as const;
type Mode = typeof modes[number];

function snapshotJson(extra: string) {
  return Buffer.from(`{"format":"kts-bundle","version":1,"n":1,"dict":{},"cols":{},"extra":${extra}}`);
}

function makeUpload(json: Buffer<ArrayBuffer>, mode: Mode) {
  const bytes = mode.compressed ? gzipSync(json) : json;
  const name = mode.compressed ? 'snapshot.json.gz' : 'snapshot.json';
  let request: Request;
  if (mode.streamed) {
    request = new Request(url, {
      method: 'PUT',
      headers: {
        origin: 'https://kts-impex.ru',
        'x-kts-top-data-protocol': 'stream-v1',
        'x-kts-top-data-name': name,
        'x-kts-top-data-expected-version': '84',
      },
      body: bytes,
    });
  } else {
    const body = new FormData();
    body.set('file', new File([bytes], name));
    body.set('expectedActiveVersionId', '84');
    request = new Request(url, {
      method: 'PUT', body, headers: { origin: 'https://kts-impex.ru' },
    });
  }
  return { bytes, request };
}

async function inspectUpload(json: Buffer<ArrayBuffer>, mode: Mode) {
  const { bytes, request } = makeUpload(json, mode);
  const result = mode.streamed
    ? await dataUpload.readTopDashboardDataStreamUpload(request)
    : await dataUpload.readTopDashboardDataUpload(request);
  return { bytes, result };
}

async function withStoredSnapshot(
  run: (storage: { directory: string; previousPath: string; previousBytes: Buffer }) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kts-top-json-resource-'));
  const previousDirectory = process.env.TOP_DASHBOARD_DATA_DIR;
  process.env.TOP_DASHBOARD_DATA_DIR = directory;
  try {
    const previousBytes = snapshotJson('{"plan":{},"workingSnapshot":"preserve-me"}');
    const previous = await writeTopDashboardRequestToPendingFile(
      new Request(url, { method: 'PUT', body: previousBytes }),
      previousBytes.length,
    );
    const previousPath = path.join(directory, await previous.commit());
    previous.preserve();
    await run({ directory, previousPath, previousBytes });
    assert.deepEqual(await readFile(previousPath), previousBytes, 'the stored working snapshot stays byte-identical');
    assert.deepEqual(await readdir(path.join(directory, '.incoming')), [], 'temporary files are cleaned up');
  } finally {
    if (previousDirectory === undefined) delete process.env.TOP_DASHBOARD_DATA_DIR;
    else process.env.TOP_DASHBOARD_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
}

async function assertAccepted(json: Buffer<ArrayBuffer>, mode: Mode) {
  const { bytes, result } = await inspectUpload(json, mode);
  assert.equal(result.error, undefined, mode.label);
  assert.ok(result.parsed, mode.label);
  const { upload } = result.parsed;
  try {
    assert.equal(result.parsed.expectedActiveVersionId, 84);
    assert.equal(upload.snapshotFormat, 'kts-bundle-v1');
    assert.equal(upload.fileSize, bytes.length);
    assert.equal(upload.uncompressedSize, json.length);
    assert.equal(upload.sha256, createHash('sha256').update(bytes).digest('hex'));
    const storedBytes = upload.pendingFile
      ? await readFile(upload.pendingFile.temporaryPath)
      : upload.content;
    assert.deepEqual(storedBytes, bytes, 'inspection must never rewrite snapshot data');
  } finally {
    await upload.pendingFile?.discard();
  }
}

const rejectedCases = [
  {
    label: 'single string value', code: 'JSON_STRING_TOO_LARGE',
    json: () => snapshotJson(`{"futureSection":"${'x'.repeat(limits.maxStringBytes + 1)}"}`),
  },
  {
    label: 'object key', code: 'JSON_KEY_TOO_LARGE',
    json: () => snapshotJson(`{"${'k'.repeat(limits.maxKeyBytes + 1)}":null}`),
  },
  {
    label: 'single numeric token', code: 'JSON_NUMBER_TOO_LARGE',
    json: () => snapshotJson(`{"futureNumber":${'1'.repeat(limits.maxNumberBytes + 1)}}`),
  },
  {
    label: 'deep nesting', code: 'JSON_TOO_DEEP',
    json: () => snapshotJson(`{"futureSection":${'['.repeat(limits.maxDepth)}0${']'.repeat(limits.maxDepth)}}`),
  },
] as const;

for (const mode of modes) {
  for (const scenario of rejectedCases) {
    test(`TOP JSON resource guard rejects ${scenario.label}: ${mode.label}; keeps old data and allows retry`, async () => {
      await withStoredSnapshot(async ({ directory, previousPath, previousBytes }) => {
        const { result } = await inspectUpload(scenario.json(), mode);
        assert.equal(result.parsed, undefined);
        assert.ok(result.error);
        assert.equal(result.error.status, 413);
        const payload = await result.error.json() as { code?: string; error?: string };
        assert.equal(payload.code, scenario.code);
        assert.match(payload.error ?? '', /предыдущий снимок не измен[её]н/i);
        assert.deepEqual(await readFile(previousPath), previousBytes);
        assert.deepEqual(await readdir(path.join(directory, '.incoming')), [], 'rejected stream leaves no incoming file');
        await assertAccepted(snapshotJson('{"plan":{},"reserve":{"rows":[]},"futureSection":{"enabled":true}}'), mode);
      });
    });
  }

  test(`TOP JSON resource guard keeps extensible sections and an exact-limit string intact: ${mode.label}`, async () => {
    await withStoredSnapshot(async () => {
      const json = snapshotJson(JSON.stringify({
        plan: {},
        reserve: { rows: [{ futureColumn: 'reserved' }] },
        futureSection: { rows: [], notes: 'x'.repeat(limits.maxStringBytes) },
      }));
      await assertAccepted(json, mode);
    });
  });

  test(`TOP JSON resource guard permits safe nesting, escaped text, Unicode and exponent numbers: ${mode.label}`, async () => {
    await withStoredSnapshot(async () => {
      const safeNested = `${'['.repeat(limits.maxDepth - 2)}null${']'.repeat(limits.maxDepth - 2)}`;
      const text = `${'a'.repeat(65_500)}\\\" / Резервы 😃 ${'b'.repeat(65_500)}`;
      const json = snapshotJson(`{"reserve":{},"futureText":${JSON.stringify(text)},"futureNumber":-1.2345e+18,"futureNested":${safeNested}}`);
      await assertAccepted(json, mode);
    });
  });
}

function dataRoute() {
  let created = 0;
  let audit = 0;
  let usage = 0;
  let slots = 0;
  const dependencies: Record<string, unknown> = {
    'node:stream': { Readable },
    '@/shared/lib/dashboardAccess': {},
    '@/shared/lib/adminAuth': {
      async requireTopDashboardManagementSession() { return { denied: null, session: { role: 'admin', adminUserId: 1 } }; },
      getTopDashboardActor() { return { adminUserId: 1, managerId: null }; },
    },
    '@/shared/lib/adminSecurity': { async enforceAdminActionRateLimit() { return null; } },
    '@/shared/lib/db': {
      ...dashboardErrors,
      async getTopDashboardBlockOverview() { return { activeVersionId: 66 }; },
      async getTopDashboardBlockVersionContent() {
        return { htmlContent: '<script>const DASH_NAME="аналитика_продаж"; const snapshot={format:"kts-bundle"};</script>' };
      },
      async createAndActivateTopDashboardBlockDataVersion() { created += 1; throw new Error('Rejected input must never reach activation'); },
    },
    '@/shared/lib/db/securityAuditRepo': { async recordSecurityEvent() { audit += 1; } },
    '@/shared/lib/dashboardUploadUsage': { getDashboardUploadUsageActor: () => ({actorKey: 'admin:1', actorRole: 'admin'}), scheduleDashboardUploadUsageDrain() { usage += 1; } },
    '@/shared/lib/originProtection': { enforceSameOriginRequest },
    '@/shared/lib/rateLimit': { getClientIp() { return '127.0.0.1'; } },
    '@/shared/lib/topDashboardDataStorage': {},
    '@/shared/lib/topDashboardContentSecurity': contentSecurity,
    '@/shared/lib/topDashboardLimits': dashboardLimits,
    '@/shared/lib/uploadRequestGuard': uploadRequestGuard,
    '@/shared/lib/topDashboardUploadConcurrency': {
      async acquireDistributedTopDashboardDataUploadSlot() {
        slots += 1;
        return async () => { slots -= 1; };
      },
    },
    '@/shared/lib/topDashboardUploadTargets': {},
    '../../dataUpload': dataUpload,
    '../../multiFileDataUpload': multiFileUpload,
    '../../routeUtils': routeUtils,
    '../../streamDataUpload': streamUpload,
  };
  const exports: {
    PUT?: (request: Request, context: { params: Promise<{ blockId: string }> }) => Promise<Response>;
  } = {};
  const source = readFileSync(path.join(process.cwd(), 'src/app/api/admin/top-dashboard/blocks/[blockId]/data/route.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(compiled, {
    exports, Response, console,
    require(name: string) {
      assert.ok(name in dependencies, `Unexpected infrastructure dependency: ${name}`);
      return dependencies[name];
    },
  });
  return {
    counters: () => ({ created, audit, usage, slots }),
    put: (request: Request) => exports.PUT!(request, { params: Promise.resolve({ blockId: '4' }) }),
  };
}

test('TOP upload route never activates rejected JSON and releases its upload slot in every input mode', async () => {
  await withStoredSnapshot(async ({ directory }) => {
    for (const mode of modes) {
      const route = dataRoute();
      const { request } = makeUpload(rejectedCases[1].json(), mode);
      const response = await route.put(request);
      assert.equal(response.status, 413, mode.label);
      assert.equal((await response.json()).code, 'JSON_KEY_TOO_LARGE');
      assert.deepEqual(route.counters(), { created: 0, audit: 0, usage: 0, slots: 0 });
      assert.deepEqual(await readdir(path.join(directory, '.incoming')), []);
    }
  });
});
