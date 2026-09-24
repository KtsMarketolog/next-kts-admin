import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
import * as contentSecurity from '../src/shared/lib/topDashboardContentSecurity';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';

function bundle(extra: Record<string, unknown>) {
  return { format: 'kts-bundle', version: 1, n: 1, dict: {}, cols: {}, extra };
}

// Synthetic schema from modern sales exports; never include customer rows.
const sales = bundle({
  stock: { rows: [], months: [], hasWh: true, hasCode: true },
  actual: { rows: [], months: [], hasWh: true, hasCode: true },
  plan: { rows: [] }, hr: { rows: [] }, timesheets: [], opex: [], alloc: 'rev',
});
const assortment = bundle({ actual: {}, reserve: {}, transit: {}, otherWh: {} });
const purchases = { v: 1, raw: { orders: [] }, meta: {}, params: {} };
const url = 'https://kts-impex.ru/api/admin/top-dashboard/blocks/4/data';

function uploadRequest(snapshot: unknown, compressed: boolean, streamed: boolean) {
  const json = Buffer.from(JSON.stringify(snapshot));
  const bytes = compressed ? gzipSync(json) : json;
  const name = compressed ? 'snapshot.json.gz' : 'snapshot.json';
  if (streamed) {
    return {
      bytes, json,
      request: new Request(url, {
        method: 'PUT',
        headers: {
          origin: 'https://kts-impex.ru',
          'x-kts-top-data-protocol': 'stream-v1',
          'x-kts-top-data-name': encodeURIComponent(name),
          'x-kts-top-data-expected-version': '84',
        },
        body: bytes,
      }),
    };
  }
  const body = new FormData();
  body.set('file', new File([bytes], name));
  body.set('expectedActiveVersionId', '84');
  return {
    bytes, json,
    request: new Request(url, {
      method: 'PUT', body, headers: { origin: 'https://kts-impex.ru' },
    }),
  };
}

async function isolatedStorage(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kts-top-profile-test-'));
  const previousDirectory = process.env.TOP_DASHBOARD_DATA_DIR;
  process.env.TOP_DASHBOARD_DATA_DIR = directory;
  try {
    await run(directory);
  } finally {
    if (previousDirectory === undefined) delete process.env.TOP_DASHBOARD_DATA_DIR;
    else process.env.TOP_DASHBOARD_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
}

test('TOP profile detection handles shared actual stock in plain/gzip and multipart/streamed uploads', async () => {
  const cases: Array<[string, unknown, dataUpload.TopDashboardDataProfile | null]> = [
    ['modern sales with actual stock', sales, 'sales-analytics'],
    ['legacy sales', bundle({ plan: {} }), 'sales-analytics'],
    ['assortment', assortment, 'assortment-optimization'],
    ['legacy actual-only assortment', bundle({ actual: {} }), 'assortment-optimization'],
    ['nested sales markers do not change assortment', bundle({ actual: {}, nested: { plan: {} } }), 'assortment-optimization'],
    ['nested stock markers do not conflict with sales', bundle({ plan: {}, nested: { reserve: {} } }), 'sales-analytics'],
    ['purchases', purchases, 'purchases'],
    ['unknown bundle', bundle({ stock: {} }), null],
    ...['reserve', 'transit', 'otherWh'].map((key): [string, unknown, null] => (
      [`conflicting sales and ${key}`, bundle({ ...sales.extra, [key]: {} }), null]
    )),
  ];
  await isolatedStorage(async (directory) => {
    for (const [label, snapshot, profile] of cases) {
      for (const compressed of [false, true]) {
        for (const streamed of [false, true]) {
          const { request, bytes, json } = uploadRequest(snapshot, compressed, streamed);
          const result = streamed
            ? await dataUpload.readTopDashboardDataStreamUpload(request)
            : await dataUpload.readTopDashboardDataUpload(request);
          const context = `${label}; gzip=${compressed}; stream=${streamed}`;
          assert.equal(result.error, undefined, context);
          assert.ok(result.parsed, context);
          try {
            const { upload } = result.parsed;
            assert.equal(upload.dashboardProfile, profile, context);
            assert.equal(upload.snapshotFormat, profile === 'purchases' ? 'purchases-v1' : 'kts-bundle-v1', context);
            assert.equal(upload.fileSize, bytes.length, context);
            assert.equal(upload.uncompressedSize, json.length, context);
            assert.equal(upload.sha256, createHash('sha256').update(bytes).digest('hex'), context);
            assert.equal(result.parsed.expectedActiveVersionId, 84, context);
          } finally {
            await result.parsed.upload.pendingFile?.discard();
          }
        }
      }
    }
    assert.deepEqual(await readdir(path.join(directory, '.incoming')), []);
  });
});

test('TOP profile recognition does not bypass corrupt gzip or foreign JSON validation in either upload protocol', async () => {
  await isolatedStorage(async (directory) => {
    for (const streamed of [false, true]) {
      const foreign = uploadRequest({ unrelated: 'data' }, true, streamed).request;
      const corruptedBytes = Buffer.from([0x1f, 0x8b, 0x08]);
      const body = new FormData();
      body.set('file', new File([corruptedBytes], 'snapshot.json.gz'));
      body.set('expectedActiveVersionId', '84');
      const corrupted = new Request(url, streamed ? {
        method: 'PUT', body: corruptedBytes,
        headers: {
          'x-kts-top-data-protocol': 'stream-v1',
          'x-kts-top-data-name': 'snapshot.json.gz',
          'x-kts-top-data-expected-version': '84',
        },
      } : { method: 'PUT', body });
      for (const [request, message] of [
        [foreign, /поддерживаемый снимок/],
        [corrupted, /повреждён/],
      ] as const) {
        const result = streamed
          ? await dataUpload.readTopDashboardDataStreamUpload(request)
          : await dataUpload.readTopDashboardDataUpload(request);
        assert.equal(result.error?.status, 400);
        assert.match(await result.error!.text(), message);
      }
    }
    assert.deepEqual(await readdir(path.join(directory, '.incoming')), []);
  });
});

function dataRoute(profile: dataUpload.TopDashboardDataProfile) {
  const htmlContent = profile === 'purchases'
    ? '<title>Управление закупками</title><input id="snapInp" type="file">'
    : `<script>const DASH_NAME="${profile === 'sales-analytics' ? 'аналитика_продаж' : 'оптимизация_ассортимента'}"; const snapshot={format:"kts-bundle"};</script>`;
  const created: Array<Record<string, unknown>> = [];
  const audit: Array<Record<string, unknown>> = [];
  let slots = 0;
  const dependencies: Record<string, unknown> = {
    'node:stream': { Readable },
    '@/shared/lib/dashboardAccess': {},
    '@/shared/lib/adminAuth': {
      async requireTopDashboardManagementSession() {
        return { denied: null, session: { role: 'admin', adminUserId: 1 } };
      },
      getTopDashboardActor() { return { adminUserId: 1, managerId: null }; },
    },
    '@/shared/lib/adminSecurity': { async enforceAdminActionRateLimit() { return null; } },
    '@/shared/lib/db': {
      ...dashboardErrors,
      async getTopDashboardBlockOverview() { return { activeVersionId: 66 }; },
      async getTopDashboardBlockVersionContent() { return { htmlContent }; },
      async createAndActivateTopDashboardBlockDataVersion(input: Record<string, unknown>) {
        created.push(input);
        return {
          version: { id: 85, ...input }, activeVersionId: 85, previousVersionId: 84,
          prunedStoragePaths: [], prunedVersionIds: [], updatedAt: '2026-09-24',
        };
      },
    },
    '@/shared/lib/db/securityAuditRepo': {
      async recordSecurityEvent(event: Record<string, unknown>) { audit.push(event); },
    },
    '@/shared/lib/originProtection': { enforceSameOriginRequest },
    '@/shared/lib/rateLimit': { getClientIp() { return '127.0.0.1'; } },
    '@/shared/lib/topDashboardDataStorage': {},
    '@/shared/lib/topDashboardContentSecurity': contentSecurity,
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
    created, audit, slots: () => slots,
    put: (request: Request) => exports.PUT!(request, { params: Promise.resolve({ blockId: '4' }) }),
  };
}

test('TOP data route activates modern sales but rejects cross-profile and ambiguous snapshots before writes', async () => {
  await isolatedStorage(async (directory) => {
    const cases: Array<[dataUpload.TopDashboardDataProfile, unknown, number]> = [
      ['sales-analytics', sales, 201],
      ['assortment-optimization', assortment, 201],
      ['purchases', purchases, 201],
      ['sales-analytics', assortment, 422],
      ['assortment-optimization', sales, 422],
      ['purchases', sales, 422],
      ['sales-analytics', purchases, 422],
      ['sales-analytics', bundle({ ...sales.extra, reserve: {} }), 422],
      ['assortment-optimization', bundle({ ...sales.extra, transit: {} }), 422],
      ['sales-analytics', bundle({}), 422],
      ['sales-analytics', { unrelated: 'json' }, 400],
    ];
    for (const [profile, snapshot, status] of cases) {
      for (const streamed of [false, true]) {
        const route = dataRoute(profile);
        const response = await route.put(uploadRequest(snapshot, true, streamed).request);
        assert.equal(response.status, status, `${profile}; stream=${streamed}`);
        const result = await response.json();
        assert.equal(route.slots(), 0);
        if (status === 201) {
          assert.equal(route.created.length, 1);
          assert.equal(route.audit.length, 1);
          assert.equal(route.created[0]!.dashboardProfile, profile);
          assert.equal(route.created[0]!.expectedActiveVersionId, 84);
          assert.equal(route.created[0]!.expectedActiveHtmlVersionId, 66);
          assert.equal(route.created[0]!.boundHtmlVersionId, null);
          assert.equal(result.state.activeVersionId, 85);
          assert.equal(result.state.previousVersionId, 84);
        } else {
          assert.equal(route.created.length, 0, 'Rejected uploads must not replace the active snapshot');
          assert.equal(route.audit.length, 0);
          assert.match(result.error, status === 422 ? /не подходит/ : /поддерживаемый снимок/);
        }
      }
    }
    assert.deepEqual(await readdir(path.join(directory, '.incoming')), []);
  });
});
