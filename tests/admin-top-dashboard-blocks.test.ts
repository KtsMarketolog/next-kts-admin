import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import {
  inspectGzipJsonWithLimit,
  readTopDashboardDataUpload,
} from '../src/app/api/admin/top-dashboard/blocks/dataUpload';
import { parsePositiveId } from '../src/app/api/admin/top-dashboard/blocks/routeUtils';
import type {
  ActivateTopDashboardBlockVersionInput,
  CreateTopDashboardBlockVersionInput,
  DeleteTopDashboardBlockResult,
  RenameTopDashboardBlockResult,
} from '../src/shared/lib/db/topDashboardBlocksRepo';
import {
  normalizeTopDashboardBlockTitle,
  TopDashboardBlockStateNotFoundError,
} from '../src/shared/lib/db/topDashboardBlocksRepo';
import {
  TopDashboardActiveHtmlRequiredError,
  TopDashboardDataCompatibilityError,
  type ActivateTopDashboardBlockDataVersionInput,
  type CreateAndActivateTopDashboardBlockDataVersionInput,
} from '../src/shared/lib/db/topDashboardDomain';
import { isTopDashboardBlockFrameRequest } from '../src/shared/lib/topDashboardContentSecurity';
import {
  TOP_DASHBOARD_DATA_MAX_BYTES,
  TOP_DASHBOARD_DATA_MAX_MEGABYTES,
  TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_BYTES,
  TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_MEGABYTES,
  TOP_DASHBOARD_DATA_MULTIPART_OVERHEAD_BYTES,
  TOP_DASHBOARD_DATA_STORAGE_LIMIT_BYTES,
} from '../src/shared/lib/topDashboardLimits';
import { acquireTopDashboardDataUploadSlot } from '../src/shared/lib/topDashboardUploadConcurrency';

test('TOP dashboard block titles are normalized and strictly bounded', () => {
  assert.equal(normalizeTopDashboardBlockTitle('  Отчет   по продажам  '), 'Отчет по продажам');
  assert.equal(normalizeTopDashboardBlockTitle('Ａналитика'), 'Aналитика');
  assert.equal(normalizeTopDashboardBlockTitle(''), null);
  assert.equal(normalizeTopDashboardBlockTitle('   '), null);
  assert.equal(normalizeTopDashboardBlockTitle('x'.repeat(121)), null);
  assert.equal(normalizeTopDashboardBlockTitle('отчет\nскрытый'), null);
  assert.equal(normalizeTopDashboardBlockTitle('отчет\u200b'), null);
  assert.equal(normalizeTopDashboardBlockTitle(42), null);
});

test('nested TOP dashboard route IDs accept only canonical positive safe integers', () => {
  assert.equal(parsePositiveId('1'), 1);
  assert.equal(parsePositiveId(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.equal(parsePositiveId('0'), null);
  assert.equal(parsePositiveId('-1'), null);
  assert.equal(parsePositiveId('01'), null);
  assert.equal(parsePositiveId('1.5'), null);
  assert.equal(parsePositiveId('1e3'), null);
  assert.equal(parsePositiveId(String(Number.MAX_SAFE_INTEGER + 1)), null);
});

test('native TOP block inputs require both block and version identifiers', () => {
  const upload = {
    blockId: 7,
    originalName: 'dashboard.html',
    htmlContent: '<!doctype html><html></html>',
    fileSize: 35,
    sha256: '0'.repeat(64),
    uploadedByAdminUserId: null,
    uploadedByManagerId: null,
  } satisfies CreateTopDashboardBlockVersionInput;
  const activation = {
    blockId: 7,
    versionId: 13,
    expectedActiveVersionId: null,
    expectedSnapshotFormat: 'kts-bundle-v1',
    expectedProfile: 'sales-analytics',
    adminUserId: null,
    managerId: null,
  } satisfies ActivateTopDashboardBlockVersionInput;

  assert.equal(upload.blockId, 7);
  assert.equal(activation.versionId, 13);
  assert.equal(activation.adminUserId, null);
});

test('missing native block state has a dedicated fail-closed error', () => {
  const error = new TopDashboardBlockStateNotFoundError();
  assert.equal(error.name, 'TopDashboardBlockStateNotFoundError');
  assert.match(error.message, /Состояние блока не найдено/);
});

test('TOP data mutations are bound to one HTML version and exact dashboard contract', () => {
  const upload = {
    blockId: 7,
    expectedActiveVersionId: null,
    expectedActiveHtmlVersionId: 13,
    expectedHtmlSnapshotFormat: 'kts-bundle-v1',
    expectedHtmlProfile: 'sales-analytics',
    originalName: 'sales.json.gz',
    content: Buffer.from('gzip'),
    fileSize: 4,
    uncompressedSize: 128,
    sha256: '0'.repeat(64),
    snapshotFormat: 'kts-bundle-v1',
    dashboardProfile: 'sales-analytics',
    uploadedByAdminUserId: null,
    uploadedByManagerId: 5,
  } satisfies CreateAndActivateTopDashboardBlockDataVersionInput;
  const rollback = {
    blockId: upload.blockId,
    versionId: 9,
    expectedActiveVersionId: 10,
    expectedActiveHtmlVersionId: upload.expectedActiveHtmlVersionId,
    expectedHtmlSnapshotFormat: upload.expectedHtmlSnapshotFormat,
    expectedHtmlProfile: upload.expectedHtmlProfile,
    adminUserId: null,
    managerId: 5,
  } satisfies ActivateTopDashboardBlockDataVersionInput;

  assert.equal(upload.dashboardProfile, rollback.expectedHtmlProfile);
  assert.equal(rollback.expectedActiveHtmlVersionId, 13);
});

test('TOP data compatibility failures have dedicated safe errors', () => {
  const missingHtml = new TopDashboardActiveHtmlRequiredError();
  const mismatch = new TopDashboardDataCompatibilityError();

  assert.equal(missingHtml.name, 'TopDashboardActiveHtmlRequiredError');
  assert.match(missingHtml.message, /Сначала опубликуйте HTML/);
  assert.equal(mismatch.name, 'TopDashboardDataCompatibilityError');
  assert.match(mismatch.message, /несовместимы/);
});

test('TOP block rename and deletion results keep block identity and deletion metadata', () => {
  const renamed = {
    block: {
      id: 7,
      title: 'Аналитика продаж',
      createdAt: '2026-08-23T00:00:00.000Z',
    },
    previousTitle: 'Тест',
    changed: true,
  } satisfies RenameTopDashboardBlockResult;
  const deleted = {
    deletedBlock: {
      ...renamed.block,
      activeVersionId: 13,
      previousVersionId: 12,
      versionCount: 4,
      storedBytes: 188_000,
      dataVersionCount: 3,
      dataStoredBytes: 8_400_000,
    },
  } satisfies DeleteTopDashboardBlockResult;

  assert.equal(renamed.block.id, deleted.deletedBlock.id);
  assert.equal(deleted.deletedBlock.versionCount, 4);
  assert.equal(deleted.deletedBlock.storedBytes, 188_000);
});

test('block HTML content accepts only its exact nested block-version frame pair', () => {
  const blockId = 7;
  const versionId = 13;
  const contentUrl = `http://127.0.0.1:3000/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/content`;
  const headers = {
    'sec-fetch-dest': 'iframe',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    referer: `https://kts-impex.ru/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/frame?revision=2`,
  };

  assert.equal(
    isTopDashboardBlockFrameRequest(new Request(contentUrl, { headers }), blockId, versionId),
    true,
  );
  assert.equal(
    isTopDashboardBlockFrameRequest(new Request(contentUrl, { headers }), blockId + 1, versionId),
    false,
  );
  assert.equal(
    isTopDashboardBlockFrameRequest(new Request(contentUrl, { headers }), blockId, versionId + 1),
    false,
  );
  assert.equal(
    isTopDashboardBlockFrameRequest(
      new Request(contentUrl, {
        headers: {
          ...headers,
          referer: `https://kts-impex.ru/api/admin/top-dashboard/blocks/${blockId + 1}/versions/${versionId}/frame`,
        },
      }),
      blockId,
      versionId,
    ),
    false,
  );
});

function dataUploadRequest(file: File, expectedActiveVersionId = '') {
  const body = new FormData();
  body.set('file', file);
  body.set('expectedActiveVersionId', expectedActiveVersionId);
  return new Request('https://kts-impex.ru/api/admin/top-dashboard/blocks/7/data', {
    method: 'PUT',
    body,
  });
}

test('TOP dashboard data limits allow 100 MiB while bounding unpacked data and history', () => {
  assert.equal(TOP_DASHBOARD_DATA_MAX_MEGABYTES, 100);
  assert.equal(TOP_DASHBOARD_DATA_MAX_BYTES, 100 * 1024 * 1024);
  assert.equal(TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_MEGABYTES, 256);
  assert.equal(TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_BYTES, 256 * 1024 * 1024);
  assert.ok(TOP_DASHBOARD_DATA_STORAGE_LIMIT_BYTES >= TOP_DASHBOARD_DATA_MAX_BYTES * 3);
});

test('TOP dashboard rejects oversized multipart requests before parsing the body', async () => {
  const request = new Request('https://kts-impex.ru/api/admin/top-dashboard/blocks/7/data', {
    method: 'PUT',
    headers: {
      'content-length': String(
        TOP_DASHBOARD_DATA_MAX_BYTES + TOP_DASHBOARD_DATA_MULTIPART_OVERHEAD_BYTES + 1
      ),
    },
  });
  const result = await readTopDashboardDataUpload(request);

  assert.equal(result.error?.status, 413);
  assert.match(await result.error!.text(), /не больше 100 МБ/i);
});

test('TOP dashboard gzip inspection enforces its real unpacked-byte limit', async () => {
  const source = Buffer.from(JSON.stringify({
    format: 'kts-bundle',
    version: 1,
    n: 1,
    dict: {},
    cols: {},
    extra: {},
    padding: 'x'.repeat(4096),
  }));
  const compressed = gzipSync(source);

  await assert.rejects(
    inspectGzipJsonWithLimit(compressed, source.length - 1),
    /UNCOMPRESSED_TOO_LARGE/,
  );
  const inspection = await inspectGzipJsonWithLimit(compressed, source.length);
  assert.equal(inspection.size, source.length);
});

test('TOP dashboard permits only one large data upload per server process', () => {
  const release = acquireTopDashboardDataUploadSlot();
  assert.ok(release);
  assert.equal(acquireTopDashboardDataUploadSlot(), null);

  release();
  release();
  const releaseNext = acquireTopDashboardDataUploadSlot();
  assert.ok(releaseNext);
  releaseNext();
});

test('TOP dashboard accepts and identifies a bounded gzip KTS snapshot', async () => {
  const source = Buffer.from(JSON.stringify({
    format: 'kts-bundle',
    version: 1,
    n: 2,
    dict: {},
    cols: {},
    extra: {},
  }));
  const compressed = gzipSync(source);
  const result = await readTopDashboardDataUpload(dataUploadRequest(
    new File([compressed], `${'д'.repeat(230)}.json.gz`, { type: 'application/gzip' }),
    '12',
  ));

  assert.equal(result.error, undefined);
  if (!result.parsed) return assert.fail('Expected a parsed dashboard snapshot');
  assert.equal(result.parsed.expectedActiveVersionId, 12);
  assert.equal(result.parsed.upload.snapshotFormat, 'kts-bundle-v1');
  assert.equal(result.parsed.upload.fileSize, compressed.length);
  assert.equal(result.parsed.upload.uncompressedSize, source.length);
  assert.ok(result.parsed.upload.originalName.length <= 220);
  assert.match(result.parsed.upload.originalName, /\.json\.gz$/i);
  assert.match(result.parsed.upload.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.parsed.upload.dashboardProfile, null);
});

test('TOP dashboard accepts the purchases snapshot contract as plain JSON', async () => {
  const source = `\ufeff${JSON.stringify({
    v: 1,
    savedAt: Date.now(),
    raw: { orders: [] },
    meta: {},
    params: {},
  })}`;
  const result = await readTopDashboardDataUpload(dataUploadRequest(
    new File([source], 'снимок закупки.json', { type: 'application/json' }),
  ));

  assert.equal(result.error, undefined);
  if (!result.parsed) return assert.fail('Expected a parsed purchases snapshot');
  assert.equal(result.parsed.expectedActiveVersionId, null);
  assert.equal(result.parsed.upload.snapshotFormat, 'purchases-v1');
  assert.equal(result.parsed.upload.dashboardProfile, 'purchases');
});

test('TOP dashboard rejects disguised gzip and unrelated JSON data', async () => {
  const disguised = await readTopDashboardDataUpload(dataUploadRequest(
    new File(['{"v":1}'], 'fake.json.gz', { type: 'application/gzip' }),
  ));
  assert.equal(disguised.error?.status, 400);
  assert.match(await disguised.error!.text(), /не является корректным gzip/i);

  const unrelated = await readTopDashboardDataUpload(dataUploadRequest(
    new File(['{"hello":"world"}'], 'unrelated.json', { type: 'application/json' }),
  ));
  assert.equal(unrelated.error?.status, 400);
  assert.match(await unrelated.error!.text(), /поддерживаемый снимок данных КТС/i);

  const corrupted = await readTopDashboardDataUpload(dataUploadRequest(
    new File([Buffer.from([0x1f, 0x8b, 0x08])], 'corrupted.json.gz', {
      type: 'application/gzip',
    }),
  ));
  assert.equal(corrupted.error?.status, 400);
  assert.match(await corrupted.error!.text(), /повреждён/i);
});

test('TOP dashboard streaming parser rejects invalid JSON grammar', async () => {
  const invalidSources = [
    '{"format":"kts-bundle" "version":1,"n":1,"dict":{},"cols":{},"extra":{}}',
    '{"format":"kts-bundle","version":truth,"n":1,"dict":{},"cols":{},"extra":{}}',
    '{"format":"kts-bundle",,"version":1,"n":1,"dict":{},"cols":{},"extra":{}}',
  ];

  for (const [index, source] of invalidSources.entries()) {
    const payload = index === 1 ? gzipSync(Buffer.from(source)) : source;
    const extension = index === 1 ? '.json.gz' : '.json';
    const result = await readTopDashboardDataUpload(dataUploadRequest(
      new File([payload], `invalid-${index}${extension}`),
    ));
    assert.equal(result.error?.status, 400);
    assert.match(await result.error!.text(), /некорректный JSON/i);
  }
});

test('TOP dashboard snapshot signatures must be complete and at the top level', async () => {
  const nestedOnly = JSON.stringify({
    payload: {
      format: 'kts-bundle',
      version: 1,
      n: 1,
      dict: {},
      cols: {},
      extra: {},
    },
  });
  const incompleteOrWrong = [
    JSON.stringify({ format: 'kts-bundle', version: 1, n: 1, dict: {}, extra: {} }),
    JSON.stringify({ format: 'kts-bundle', version: 1, n: 1, dict: [], cols: {}, extra: {} }),
    JSON.stringify({ v: 1, raw: {}, params: {} }),
  ];

  for (const [index, source] of [nestedOnly, ...incompleteOrWrong].entries()) {
    const result = await readTopDashboardDataUpload(dataUploadRequest(
      new File([source], `unsupported-${index}.json`, { type: 'application/json' }),
    ));
    assert.equal(result.error?.status, 400);
    assert.match(await result.error!.text(), /поддерживаемый снимок данных КТС/i);
  }
});

test('TOP dashboard finds a gzip snapshot signature beyond the first 64 KiB', async () => {
  const source = Buffer.from(JSON.stringify({
    padding: 'x'.repeat(70 * 1024),
    format: 'kts-bundle',
    version: 1,
    n: 3,
    dict: {},
    cols: {},
    extra: { plan: {}, hr: {} },
  }));
  const compressed = gzipSync(source);
  const result = await readTopDashboardDataUpload(dataUploadRequest(
    new File([compressed], 'analytics.json.gz', { type: 'application/gzip' }),
  ));

  assert.equal(result.error, undefined);
  if (!result.parsed) return assert.fail('Expected a parsed dashboard snapshot');
  assert.equal(result.parsed.upload.snapshotFormat, 'kts-bundle-v1');
  assert.equal(result.parsed.upload.dashboardProfile, 'sales-analytics');
  assert.equal(result.parsed.upload.uncompressedSize, source.length);
});

test('TOP dashboard profiles KTS bundles by direct extra keys and fails ambiguous profiles closed', async () => {
  const assortment = await readTopDashboardDataUpload(dataUploadRequest(new File([
    JSON.stringify({
      format: 'kts-bundle',
      version: 1,
      n: 1,
      dict: {},
      cols: {},
      extra: { actual: {}, reserve: {}, nested: { plan: {} } },
    }),
  ], 'assortment.json')));
  assert.equal(assortment.error, undefined);
  assert.equal(assortment.parsed?.upload.dashboardProfile, 'assortment-optimization');

  const ambiguous = await readTopDashboardDataUpload(dataUploadRequest(new File([
    JSON.stringify({
      format: 'kts-bundle',
      version: 1,
      n: 1,
      dict: {},
      cols: {},
      extra: { plan: {}, actual: {} },
    }),
  ], 'ambiguous.json')));
  assert.equal(ambiguous.error, undefined);
  assert.equal(ambiguous.parsed?.upload.dashboardProfile, null);
});
