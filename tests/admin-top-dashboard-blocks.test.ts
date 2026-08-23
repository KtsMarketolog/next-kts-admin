import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePositiveId } from '../src/app/api/admin/top-dashboard/blocks/routeUtils';
import type {
  ActivateTopDashboardBlockVersionInput,
  CreateTopDashboardBlockVersionInput,
} from '../src/shared/lib/db/topDashboardBlocksRepo';
import {
  normalizeTopDashboardBlockTitle,
  TopDashboardBlockStateNotFoundError,
} from '../src/shared/lib/db/topDashboardBlocksRepo';
import { isTopDashboardBlockFrameRequest } from '../src/shared/lib/topDashboardContentSecurity';

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
  } satisfies CreateTopDashboardBlockVersionInput;
  const activation = {
    blockId: 7,
    versionId: 13,
    expectedActiveVersionId: null,
    adminUserId: null,
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
          referer: `https://kts-impex.ru/api/admin/top-dashboard/versions/${versionId}/frame`,
        },
      }),
      blockId,
      versionId,
    ),
    false,
  );
});
