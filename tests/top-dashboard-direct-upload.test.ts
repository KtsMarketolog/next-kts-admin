import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import {
  isTopDashboardDirectFilesUpload,
  isTopDashboardDirectFilesUploadPayload,
  readTopDashboardMultiFileDataStreamUpload,
  TOP_DASHBOARD_DIRECT_FILES_UPLOAD_HEADER,
} from '../src/app/api/admin/top-dashboard/blocks/multiFileDataUpload';
import * as multiFileUploadModule from '../src/app/api/admin/top-dashboard/blocks/multiFileDataUpload';
import * as streamUploadModule from '../src/app/api/admin/top-dashboard/blocks/streamDataUpload';
import { parsePositiveId } from '../src/app/api/admin/top-dashboard/blocks/routeUtils';
import * as dashboardErrors from '../src/shared/lib/db/topDashboardDomain';
import * as dashboardAccess from '../src/shared/lib/dashboardAccess';
import {
  TopDashboardBlockNotFoundError,
  TopDashboardDataStorageLimitError,
} from '../src/shared/lib/db/topDashboardBlocksRepo';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';
import * as contentSecurity from '../src/shared/lib/topDashboardContentSecurity';
import {
  decodeTopDashboardMultiFileSnapshot,
  encodeTopDashboardMultiFileSnapshot,
  inspectTopDashboardMultiFileSnapshot,
  type TopDashboardMultiFileSnapshotTargetSummary,
} from '../src/shared/lib/topDashboardMultiFileSnapshot';
import { detectTopDashboardUploadTargets } from '../src/shared/lib/topDashboardUploadTargets';

const html = `<label for="file">Продажи и остатки</label>
  <input id="file" type="file" accept=".json,.json.gz,.xlsx" multiple>
  <input type="file" name="plan" aria-label="План продаж" accept=".json">
  <input type="file" id="folder" webkitdirectory title="Папка отчётов">`;

function upload(targets: TopDashboardMultiFileSnapshotTargetSummary[]) {
  return {
    targets,
    targetCount: targets.length,
    fileCount: targets.reduce((sum, target) => sum + target.fileCount, 0),
  };
}

test('direct targets include multi-file, separate and directory fields in static DOM order', () => {
  assert.deepEqual(detectTopDashboardUploadTargets(html), [
    {
      target: { id: 'file', name: null, index: 0 },
      multiple: true,
      directory: false,
      accept: '.json,.json.gz,.xlsx',
      label: 'Продажи и остатки',
    },
    {
      target: { id: null, name: 'plan', index: 1 },
      multiple: false,
      directory: false,
      accept: '.json',
      label: 'План продаж',
    },
    {
      target: { id: 'folder', name: null, index: 2 },
      multiple: false,
      directory: true,
      accept: '',
      label: 'Папка отчётов',
    },
  ]);
});

test('real Strategic Overview file input stays available despite bundled runtime input helpers', () => {
  const targets = detectTopDashboardUploadTargets(`
    <input type="file" id="file" accept=".json,.json.gz,.xlsx,.csv" multiple>
    <script>function save() { const x = document.createElement('input'); x.type = 'file'; }
      const example = '<input type="file" id="unreal">';</script>
    <template><input type="file" id="template"></template>
    <noscript><input type="file" id="noscript"></noscript>
    <textarea><input type="file" id="textarea"></textarea>
    <!-- <input type="file" id="comment"> -->
  `);
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0]?.target, { id: 'file', name: null, index: 0 });
  assert.equal(targets[0]?.multiple, true);
  assert.equal(targets[0]?.accept, '.json,.json.gz,.xlsx,.csv');
});

test('runtime-only inputs are not invented as static upload targets', () => {
  assert.deepEqual(detectTopDashboardUploadTargets(`
    <script>const x = document.createElement('input'); x.type = 'file'; document.body.append(x);</script>
  `), []);
});

test('disabled static fields are omitted without shifting the remaining DOM indexes', () => {
  const targets = detectTopDashboardUploadTargets(`
    <input type="file" id="unavailable" disabled>
    <input type="file" id="available" accept="${'x'.repeat(1024)}">
  `);
  assert.equal(targets.length, 1);
  assert.deepEqual(targets[0]?.target, { id: 'available', name: null, index: 1 });
  assert.equal(targets[0]?.accept.length, 512);
});

test('field discovery is independent of the selected snapshot target limit and stays bounded', () => {
  const manyFields = (count: number) => Array.from({ length: count }, (_, index) => (
    `<input type="file" id="file-${index}">`
  )).join('');
  assert.equal(detectTopDashboardUploadTargets(manyFields(33)).length, 33);
  const bounded = detectTopDashboardUploadTargets(`<input type="file" disabled>${manyFields(257)}`);
  assert.equal(bounded.length, 256);
  assert.equal(bounded[0]?.target.index, 1);
  assert.equal(bounded.at(-1)?.target.index, 256);
});

test('duplicate and unsafe attributes fall back to their exact index without invalid target metadata', () => {
  const targets = detectTopDashboardUploadTargets(`
    <input type="file" id="same" name="repeated">
    <input type="file" id="same" name="repeated">
    <input type="file" id=" é " name="safe-é">
    <input type="file" id="${'x'.repeat(513)}" name="bad&#10;name">
  `);
  assert.deepEqual(targets.map((entry) => entry.target), [
    { id: null, name: null, index: 0 },
    { id: null, name: null, index: 1 },
    { id: null, name: 'safe-é', index: 2 },
    { id: null, name: null, index: 3 },
  ]);
});

test('direct files protocol requires its explicit header', () => {
  const request = new Request('https://kts-impex.ru/api/admin/top-dashboard/blocks/7/data');
  assert.equal(isTopDashboardDirectFilesUpload(request), false);
  request.headers.set(TOP_DASHBOARD_DIRECT_FILES_UPLOAD_HEADER, '1');
  assert.equal(isTopDashboardDirectFilesUpload(request), true);
  request.headers.set(TOP_DASHBOARD_DIRECT_FILES_UPLOAD_HEADER, 'true');
  assert.equal(isTopDashboardDirectFilesUpload(request), false);
});

test('direct payload accepts one or many files for the matching multi-file field and selected subsets', () => {
  const targets = detectTopDashboardUploadTargets(html);
  for (const fileCount of [1, 2, 64]) {
    assert.equal(isTopDashboardDirectFilesUploadPayload(upload([
      { target: targets[0]!.target, fileCount },
    ]), targets), true);
  }
  assert.equal(isTopDashboardDirectFilesUploadPayload(upload([
    { target: targets[0]!.target, fileCount: 4 },
    { target: targets[1]!.target, fileCount: 1 },
    { target: targets[2]!.target, fileCount: 10 },
  ]), targets), true);
  assert.equal(isTopDashboardDirectFilesUploadPayload(upload([
    { target: targets[2]!.target, fileCount: 2 },
  ]), targets), true);
});

test('direct payload rejects forged destinations, duplicate fields, empty/oversized selections and extra single files', () => {
  const targets = detectTopDashboardUploadTargets(html);
  const valid = { target: targets[0]!.target, fileCount: 2 };
  const invalid = [
    upload([]),
    upload([{ ...valid, target: { ...valid.target, id: 'forged' } }]),
    upload([{ ...valid, target: { ...valid.target, name: 'forged' } }]),
    upload([{ ...valid, target: { ...valid.target, index: 12 } }]),
    upload([valid, valid]),
    upload([{ ...valid, fileCount: 0 }]),
    upload([{ ...valid, fileCount: 1.5 }]),
    upload([{ ...valid, fileCount: 65 }]),
    upload([{ ...valid, target: targets[1]!.target }]),
    { ...upload([valid]), targetCount: 2 },
    { ...upload([valid]), fileCount: 3 },
  ];
  for (const entry of invalid) {
    assert.equal(isTopDashboardDirectFilesUploadPayload(entry, targets), false);
  }
  assert.equal(isTopDashboardDirectFilesUploadPayload(upload([valid]), []), false);
});

test('directory envelopes preserve paths and reject traversal before a direct payload is accepted', () => {
  const targets = detectTopDashboardUploadTargets(html);
  const envelope = encodeTopDashboardMultiFileSnapshot({
    targets: [{
      target: targets[2]!.target,
      files: [
        { name: 'one.json', webkitRelativePath: 'reports/one.json', bytes: Buffer.from('{}') },
        { name: 'two.json', webkitRelativePath: 'reports/nested/two.json', bytes: Buffer.from('{}') },
      ],
    }],
  });
  const checked = inspectTopDashboardMultiFileSnapshot(envelope);
  assert.equal(checked.ok, true);
  if (!checked.ok) return;
  assert.equal(isTopDashboardDirectFilesUploadPayload(checked, targets), true);
  assert.deepEqual(decodeTopDashboardMultiFileSnapshot(envelope).targets[0]?.files.map((file) => file.webkitRelativePath), [
    'reports/one.json', 'reports/nested/two.json',
  ]);
  assert.throws(() => encodeTopDashboardMultiFileSnapshot({
    targets: [{
      target: targets[2]!.target,
      files: [{ name: 'one.json', webkitRelativePath: '../one.json', bytes: Buffer.from('{}') }],
    }],
  }));
});

test('streamed direct multi-file validation preserves expected versions and keeps temporary files disposable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kts-top-direct-'));
  const previousDirectory = process.env.TOP_DASHBOARD_DATA_DIR;
  process.env.TOP_DASHBOARD_DATA_DIR = directory;
  try {
    const targets = detectTopDashboardUploadTargets(html);
    const envelope = encodeTopDashboardMultiFileSnapshot({
      targets: [{
        target: targets[0]!.target,
        files: [
          { name: 'sales.json', bytes: Buffer.from('{"sales":1}') },
          { name: 'stock.json', bytes: Buffer.from('{"stock":2}') },
        ],
      }],
    });
    const request = new Request('https://kts-impex.ru/api/admin/top-dashboard/blocks/7/data', {
      method: 'PUT',
      headers: {
        [TOP_DASHBOARD_DIRECT_FILES_UPLOAD_HEADER]: '1',
        'x-kts-top-dashboard-multi-file': '1',
        'x-kts-top-data-protocol': 'stream-v1',
        'x-kts-top-data-expected-version': '70',
        'x-kts-top-html-version': '19',
      },
      body: envelope,
    });
    const result = await readTopDashboardMultiFileDataStreamUpload(request);
    assert.equal(result.error, undefined);
    assert.ok(result.parsed);
    const parsed = result.parsed;
    assert.equal(parsed.expectedActiveVersionId, 70);
    assert.equal(parsed.expectedActiveHtmlVersionId, 19);
    assert.equal(parsed.upload.content, null, 'request is not buffered into the database');
    assert.equal(parsed.upload.storagePath, null, 'file is not committed before target validation');
    assert.equal(isTopDashboardDirectFilesUploadPayload(parsed, targets), true);
    assert.equal(isTopDashboardDirectFilesUploadPayload(parsed, []), false);
    await parsed.upload.pendingFile?.discard();
    assert.deepEqual(await readdir(path.join(directory, '.incoming')), []);
  } finally {
    if (previousDirectory === undefined) delete process.env.TOP_DASHBOARD_DATA_DIR;
    else process.env.TOP_DASHBOARD_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

// Run the real route with inert infrastructure dependencies: no database,
// sessions or production files are accessed by these request-level checks.
function directRouteHarness(options: {
  denied?: boolean;
  forgedTarget?: boolean;
  staleHtml?: boolean;
  commitConflict?: boolean;
  databaseError?: Error;
  storageCommitError?: Error;
} = {}) {
  const calls: string[] = [];
  let created: Record<string, unknown> | null = null;
  let preserved = false;
  let discardedFile = false;
  const target = detectTopDashboardUploadTargets(html)[0]!.target;
  const pendingFile = {
    fileSize: 80,
    firstBytes: Buffer.alloc(0),
    sha256: 'a'.repeat(64),
    temporaryPath: '/test/pending',
    async commit() {
      calls.push('commit');
      if (options.storageCommitError) throw options.storageCommitError;
      return 'test.ktsmf';
    },
    async discard() { calls.push('discard'); discardedFile = !preserved; },
    preserve() { calls.push('preserve'); preserved = true; },
  };
  const parsed = {
    expectedActiveVersionId: 70,
    expectedActiveHtmlVersionId: options.staleHtml ? 18 : 19,
    ...upload([{ target: options.forgedTarget ? { ...target, id: 'forged' } : target, fileCount: 2 }]),
    upload: {
      content: null,
      storagePath: null,
      pendingFile,
      originalName: 'dashboard-files.ktsmf',
      fileSize: 80,
      uncompressedSize: 80,
      sha256: 'a'.repeat(64),
      snapshotFormat: 'multi-file-v1',
      dashboardProfile: 'generic',
      boundHtmlVersionId: 19,
    },
  };
  const dependencies: Record<string, unknown> = {
    '@/shared/lib/dashboardAccess': dashboardAccess,
    'node:stream': {},
    '@/shared/lib/adminAuth': {
      async requireTopDashboardManagementSession() {
        return options.denied
          ? { denied: new Response('Unauthorized', { status: 401 }) }
          : { denied: null, session: { role: 'admin', adminUserId: 1 } };
      },
      getTopDashboardActor() { return { adminUserId: 1, managerId: null }; },
    },
    '@/shared/lib/adminSecurity': { async enforceAdminActionRateLimit() { return null; } },
    '@/shared/lib/db': {
      ...dashboardErrors,
      TopDashboardBlockNotFoundError,
      TopDashboardDataStorageLimitError,
      async getTopDashboardBlockOverview() { calls.push('overview'); return { activeVersionId: 19 }; },
      async getTopDashboardBlockVersionContent() { return { htmlContent: html }; },
      async createAndActivateTopDashboardBlockDataVersion(input: Record<string, unknown>) {
        calls.push('create');
        if (options.commitConflict) throw new dashboardErrors.TopDashboardStateConflictError(20);
        if (options.databaseError) throw options.databaseError;
        created = input;
        return {
          version: { id: 71, ...input }, activeVersionId: 71, previousVersionId: 70,
          prunedStoragePaths: [], prunedVersionIds: [], updatedAt: '2026-09-17',
        };
      },
    },
    '@/shared/lib/db/securityAuditRepo': { async recordSecurityEvent() { calls.push('audit'); } },
    '@/shared/lib/originProtection': { enforceSameOriginRequest },
    '@/shared/lib/rateLimit': { getClientIp() { return '127.0.0.1'; } },
    '@/shared/lib/topDashboardDataStorage': {},
    '@/shared/lib/topDashboardContentSecurity': contentSecurity,
    '@/shared/lib/topDashboardUploadConcurrency': {
      async acquireDistributedTopDashboardDataUploadSlot() {
        calls.push('slot'); return async () => { calls.push('release'); };
      },
    },
    '@/shared/lib/topDashboardUploadTargets': { detectTopDashboardUploadTargets },
    '../../dataUpload': {},
    '../../multiFileDataUpload': {
      ...multiFileUploadModule,
      async readTopDashboardMultiFileDataStreamUpload() { calls.push('parse'); return { parsed }; },
    },
    '../../routeUtils': { parsePositiveId },
    '../../streamDataUpload': streamUploadModule,
  };
  const exports: { PUT?: (request: Request, context: { params: Promise<{ blockId: string }> }) => Promise<Response> } = {};
  const source = readFileSync(path.join(process.cwd(), 'src/app/api/admin/top-dashboard/blocks/[blockId]/data/route.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(compiled, {
    exports, Response, console: { ...console, error() {} },
    require: (name: string) => {
      assert.ok(name in dependencies, `Unexpected infrastructure dependency: ${name}`);
      return dependencies[name];
    },
  });
  return {
    calls,
    created: () => created,
    discardedFile: () => discardedFile,
    put(headers: Record<string, string> = {}) {
      return exports.PUT!(new Request('https://kts-impex.ru/api/admin/top-dashboard/blocks/7/data', {
        method: 'PUT',
        headers: {
          origin: 'https://kts-impex.ru',
          'x-kts-top-dashboard-direct-files': '1',
          'x-kts-top-dashboard-multi-file': '1',
          'x-kts-top-data-protocol': 'stream-v1',
          ...headers,
        },
      }), { params: Promise.resolve({ blockId: '7' }) });
    },
  };
}

test('direct route rejects unauthorized/cross-origin or inconsistent protocols before reading upload or acquiring storage', async () => {
  for (const [harness, headers, status] of [
    [directRouteHarness({ denied: true }), {}, 401],
    [directRouteHarness(), { origin: 'https://outside.invalid' }, 403],
    [directRouteHarness(), { 'x-kts-top-dashboard-multi-file': '0' }, 400],
    [directRouteHarness(), { 'x-kts-top-data-protocol': 'multipart' }, 400],
    [directRouteHarness(), { 'x-kts-top-dashboard-direct-single-file': '1' }, 400],
  ] as const) {
    assert.equal((await harness.put(headers)).status, status);
    assert.deepEqual(harness.calls, []);
  }
});

test('direct route validates destinations/HTML binding before commit and always discards rejected pending storage', async () => {
  for (const options of [{ forgedTarget: true }, { staleHtml: true }]) {
    const harness = directRouteHarness(options);
    assert.equal((await harness.put()).status, options.forgedTarget ? 400 : 409);
    assert.deepEqual(harness.calls, ['slot', 'overview', 'parse', 'discard', 'release']);
    assert.equal(harness.created(), null);
  }
});

test('direct route retains prior data version CAS and preserves files after successful activation', async () => {
  const harness = directRouteHarness();
  assert.equal((await harness.put()).status, 201);
  assert.deepEqual(harness.calls, ['slot', 'overview', 'parse', 'commit', 'create', 'preserve', 'audit', 'discard', 'release']);
  assert.equal(harness.created()?.expectedActiveVersionId, 70);
  assert.equal(harness.created()?.expectedActiveHtmlVersionId, 19);
  assert.equal(harness.created()?.boundHtmlVersionId, 19);
  assert.equal(harness.created()?.storagePath, 'test.ktsmf');
  assert.equal('pendingFile' in harness.created()!, false);

  const conflicted = directRouteHarness({ commitConflict: true });
  assert.equal((await conflicted.put()).status, 409);
  assert.deepEqual(conflicted.calls, ['slot', 'overview', 'parse', 'commit', 'create', 'discard', 'release']);
  assert.equal(conflicted.discardedFile(), true);
});

test('direct route keeps possibly committed file bytes when the database COMMIT acknowledgement is lost', async () => {
  const harness = directRouteHarness({ databaseError: new Error('connection lost after COMMIT') });
  assert.equal((await harness.put()).status, 500);
  assert.deepEqual(harness.calls, ['slot', 'overview', 'parse', 'commit', 'create', 'preserve', 'discard', 'release']);
  assert.equal(harness.discardedFile(), false, 'active database references must not lose their file after uncertain commit');
});

test('direct route discards files on known quota rejection and failures before the database attempt', async () => {
  const quota = directRouteHarness({ databaseError: new TopDashboardDataStorageLimitError() });
  assert.equal((await quota.put()).status, 409);
  assert.deepEqual(quota.calls, ['slot', 'overview', 'parse', 'commit', 'create', 'discard', 'release']);
  assert.equal(quota.discardedFile(), true);

  const storage = directRouteHarness({ storageCommitError: new Error('file rename failed') });
  assert.equal((await storage.put()).status, 500);
  assert.deepEqual(storage.calls, ['slot', 'overview', 'parse', 'commit', 'discard', 'release']);
  assert.equal(storage.discardedFile(), true);
});

test('ordinary universal uploads retain the protected-frame request requirement', async () => {
  const harness = directRouteHarness();
  const response = await harness.put({ 'x-kts-top-dashboard-direct-files': '0' });
  assert.equal(response.status, 409);
  assert.deepEqual(harness.calls, ['slot', 'overview', 'parse', 'discard', 'release']);
});
