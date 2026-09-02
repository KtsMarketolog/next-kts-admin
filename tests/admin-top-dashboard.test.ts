import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { normalizeSessionRole } from '../src/app/admin/adminSessionClient';
import {
  USER_TABS,
  defaultRoleForTab,
  roleOptionsForTab,
  tabForRole,
} from '../src/features/admin/users/AdminUsersConfig';
import {
  createAdminSession,
  getTopDashboardActor,
  isAdminManagementSession,
  isOperationalEmployeeSessionRole,
  isTopDashboardManagementSession,
  isTopDashboardSession,
} from '../src/shared/lib/adminAuth';
import { shouldRevokeManagerSessionsForUpdate } from '../src/shared/lib/managerSessionPolicy';
import type {
  activateTopDashboardBlockVersion,
  CreateTopDashboardBlockVersionInput,
  deleteTopDashboardBlockVersion,
} from '../src/shared/lib/db/topDashboardBlocksRepo';
import { TopDashboardActiveVersionDeleteError } from '../src/shared/lib/db/topDashboardDomain';
import {
  buildTopDashboardFrameSecurityPolicy,
  buildTopDashboardContentSecurityPolicy,
  createTopDashboardFrameBridgeScript,
  detectTopDashboardDataContract,
  detectTopDashboardExpectedProfile,
  detectTopDashboardExpectedSnapshotFormat,
  getTopDashboardBlockDataFrameVersionId,
  getTopDashboardDataAdapterScript,
  injectTopDashboardDataAdapter,
  isTopDashboardBlockDataFrameRequest,
  isTopDashboardBlockDataMutationFrameRequest,
  isTopDashboardBlockFrameRequest,
  TOP_DASHBOARD_DATA_MAX_BYTES,
} from '../src/shared/lib/topDashboardContentSecurity';
import {
  TOP_DASHBOARD_DOWNLOAD_MAX_BYTES,
  TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER,
  getTopDashboardDownloadMimeType,
  normalizeTopDashboardDownloadName,
  readTopDashboardDownloadMessage,
} from '../src/shared/lib/topDashboardDownloadBridge';

function cspHash(source: string) {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

test('TOP roles are preserved client-side and unknown roles fail closed', () => {
  assert.equal(normalizeSessionRole('top'), 'top');
  assert.equal(normalizeSessionRole('admintop'), 'admintop');
  assert.equal(normalizeSessionRole('admin'), 'admin');
  assert.equal(normalizeSessionRole('manager'), 'manager');
  assert.equal(normalizeSessionRole('unexpected' as never), null);
});

test('TOP-only roles are excluded from operational employee permissions', () => {
  assert.equal(isOperationalEmployeeSessionRole('admin'), true);
  assert.equal(isOperationalEmployeeSessionRole('wholesale_admin'), true);
  assert.equal(isOperationalEmployeeSessionRole('manager'), true);
  assert.equal(isOperationalEmployeeSessionRole('support_manager'), true);
  assert.equal(isOperationalEmployeeSessionRole('top'), false);
  assert.equal(isOperationalEmployeeSessionRole('admintop'), false);
  assert.equal(isOperationalEmployeeSessionRole(null), false);
});

test('break-glass admin can bootstrap users and manage TOP dashboard without a database user id', () => {
  const breakGlassAdmin = { role: 'admin' } as const;

  assert.equal(isAdminManagementSession(breakGlassAdmin), true);
  assert.equal(isTopDashboardSession(breakGlassAdmin), true);
  assert.equal(isTopDashboardManagementSession(breakGlassAdmin), true);
});

test('TOP keeps its primary role and receives dashboard management only through the additive flag', () => {
  assert.equal(isAdminManagementSession({ role: 'top', adminUserId: 1 }), false);
  assert.equal(isTopDashboardSession({ role: 'top' }), false);
  assert.equal(isTopDashboardSession({ role: 'top', adminUserId: -1 }), false);
  assert.equal(isTopDashboardSession({ role: 'top', adminUserId: 1 }), true);
  assert.equal(isTopDashboardManagementSession({ role: 'top', adminUserId: 1 }), false);
  assert.equal(isTopDashboardManagementSession({
    role: 'top',
    adminUserId: 1,
    canManageTopDashboard: false,
  }), false);
  assert.equal(isTopDashboardManagementSession({
    role: 'top',
    adminUserId: 1,
    canManageTopDashboard: true,
  }), true);
  assert.equal(isAdminManagementSession({
    role: 'top',
    adminUserId: 1,
    canManageTopDashboard: true,
  }), false);
  for (const adminUserId of [undefined, 0, -1, 1.5, Number.NaN]) {
    assert.equal(isTopDashboardManagementSession({
      role: 'top',
      adminUserId,
      canManageTopDashboard: true,
    }), false);
  }
});

test('Admin TOP requires a persisted user id and receives TOP management only', () => {
  assert.equal(isAdminManagementSession({ role: 'admintop', adminUserId: 1 }), false);
  assert.equal(isTopDashboardSession({ role: 'admintop' }), false);
  assert.equal(isTopDashboardManagementSession({ role: 'admintop' }), false);
  assert.equal(isTopDashboardSession({ role: 'admintop', adminUserId: -1 }), false);
  assert.equal(isTopDashboardManagementSession({ role: 'admintop', adminUserId: -1 }), false);
  assert.equal(isTopDashboardSession({ role: 'admintop', adminUserId: 1 }), true);
  assert.equal(isTopDashboardManagementSession({ role: 'admintop', adminUserId: 1 }), true);
});

test('manager roles keep their primary permissions and receive TOP only through the additive flag', () => {
  for (const role of ['manager', 'support_manager'] as const) {
    assert.equal(isOperationalEmployeeSessionRole(role), true);
    assert.equal(isAdminManagementSession({ role, managerId: 17 }), false);
    assert.equal(
      isTopDashboardManagementSession({ role, managerId: 17, canAccessTopDashboard: true }),
      false,
    );
    assert.equal(
      isTopDashboardManagementSession({ role, managerId: 17, canManageTopDashboard: true }),
      true,
    );
    assert.equal(isTopDashboardSession({ role, managerId: 17 }), false);
    assert.equal(
      isTopDashboardSession({ role, managerId: 17, canAccessTopDashboard: false }),
      false,
    );
    assert.equal(
      isTopDashboardSession({ role, managerId: 17, canAccessTopDashboard: true }),
      true,
    );
    assert.equal(
      isTopDashboardSession({ role, managerId: 17, canManageTopDashboard: true }),
      true,
    );
    assert.equal(
      isAdminManagementSession({ role, managerId: 17, canManageTopDashboard: true }),
      false,
    );
  }
});

test('manager TOP viewing and management fail closed without a valid positive manager id', () => {
  for (const managerId of [undefined, 0, -1, 1.5, Number.NaN]) {
    assert.equal(
      isTopDashboardSession({
        role: 'manager',
        managerId,
        canAccessTopDashboard: true,
      }),
      false,
    );
    assert.equal(
      isTopDashboardSession({
        role: 'manager',
        managerId,
        canManageTopDashboard: true,
      }),
      false,
    );
    assert.equal(
      isTopDashboardManagementSession({
        role: 'manager',
        managerId,
        canManageTopDashboard: true,
      }),
      false,
    );
  }
});

test('manager sessions are revoked when activity or TOP permissions change', () => {
  assert.equal(shouldRevokeManagerSessionsForUpdate({
    passwordChanged: false,
    permissionsChanged: false,
    activeStateChanged: false,
  }), false);
  assert.equal(shouldRevokeManagerSessionsForUpdate({
    passwordChanged: false,
    permissionsChanged: true,
    activeStateChanged: false,
  }), true);
  assert.equal(shouldRevokeManagerSessionsForUpdate({
    passwordChanged: false,
    permissionsChanged: false,
    activeStateChanged: true,
  }), true);
});

test('TOP management audit attribution distinguishes Admin TOP from the main admin', () => {
  assert.deepEqual(
    getTopDashboardActor({ role: 'admintop', adminUserId: 31 }),
    { actorType: 'admintop', adminUserId: 31, managerId: null },
  );
  assert.deepEqual(
    getTopDashboardActor({ role: 'admin' }),
    { actorType: 'admin', adminUserId: null, managerId: null },
  );
  assert.deepEqual(
    getTopDashboardActor({
      role: 'top',
      adminUserId: 32,
      canManageTopDashboard: true,
    }),
    { actorType: 'top', adminUserId: 32, managerId: null },
  );
  for (const role of ['manager', 'support_manager'] as const) {
    assert.deepEqual(
      getTopDashboardActor({
        role,
        managerId: 33,
        canManageTopDashboard: true,
      }),
      { actorType: 'manager', adminUserId: null, managerId: 33 },
    );
  }
});

test('TOP sessions without a positive user id are rejected before persistence', async () => {
  await assert.rejects(createAdminSession('top'), /requires an admin user id/i);
  await assert.rejects(createAdminSession('admintop'), /requires an admin user id/i);
  await assert.rejects(
    createAdminSession('top', { adminUserId: -1 }),
    /requires an admin user/i,
  );
  await assert.rejects(
    createAdminSession('admintop', { adminUserId: -1 }),
    /requires an admin user/i,
  );
});

test('break-glass admin actions support nullable database attribution', () => {
  const uploadInput = {
    blockId: 7,
    originalName: 'dashboard.html',
    htmlContent: '<!doctype html><html></html>',
    fileSize: 35,
    sha256: '0'.repeat(64),
    uploadedByAdminUserId: null,
    uploadedByManagerId: null,
  } satisfies CreateTopDashboardBlockVersionInput;
  type ActivateInput = Parameters<typeof activateTopDashboardBlockVersion>[0];
  const activateInput = {
    blockId: 7,
    versionId: 1,
    expectedActiveVersionId: null,
    expectedSnapshotFormat: 'kts-bundle-v1',
    expectedProfile: 'sales-analytics',
    adminUserId: null,
    managerId: null,
  } satisfies ActivateInput;
  type DeleteInput = Parameters<typeof deleteTopDashboardBlockVersion>[0];
  const deleteInput = {
    blockId: 7,
    versionId: 2,
    adminUserId: null,
    managerId: null,
  } satisfies DeleteInput;

  assert.equal(uploadInput.uploadedByAdminUserId, null);
  assert.equal(uploadInput.uploadedByManagerId, null);
  assert.equal(activateInput.adminUserId, null);
  assert.equal(activateInput.managerId, null);
  assert.equal(deleteInput.adminUserId, null);
  assert.equal(deleteInput.managerId, null);
});

test('active TOP dashboard versions have a dedicated deletion conflict', () => {
  const error = new TopDashboardActiveVersionDeleteError(42);

  assert.equal(error.name, 'TopDashboardActiveVersionDeleteError');
  assert.equal(error.activeVersionId, 42);
  assert.match(error.message, /Активную версию нельзя удалить/);
});

test('admin users screen exposes separate single-role TOP and Admin TOP tabs', () => {
  assert.deepEqual(USER_TABS.map((tab) => tab.value), ['admin', 'top', 'admintop']);
  assert.equal(tabForRole('top'), 'top');
  assert.equal(tabForRole('admintop'), 'admintop');
  assert.equal(defaultRoleForTab('top'), 'top');
  assert.equal(defaultRoleForTab('admintop'), 'admintop');
  assert.deepEqual(roleOptionsForTab('top'), [{ value: 'top', label: 'TOP — только просмотр' }]);
  assert.deepEqual(roleOptionsForTab('admintop'), [{
    value: 'admintop',
    label: 'Админ TOP — управление',
  }]);
});

test('TOP users expose a separate Admin TOP capability without changing their primary role', () => {
  const viewSource = readFileSync(new URL(
    '../src/features/admin/users/AdminUsersView.tsx',
    import.meta.url,
  ), 'utf8');
  const repositorySource = readFileSync(new URL(
    '../src/shared/lib/db/adminUsersRepo.ts',
    import.meta.url,
  ), 'utf8');
  const sessionRepositorySource = readFileSync(new URL(
    '../src/shared/lib/db/adminSessionsRepo.ts',
    import.meta.url,
  ), 'utf8');
  const panelSource = readFileSync(new URL(
    '../src/app/admin/AdminPanel.tsx',
    import.meta.url,
  ), 'utf8');
  const updateRouteSource = readFileSync(new URL(
    '../src/app/api/admin/users/[id]/route.ts',
    import.meta.url,
  ), 'utf8');

  assert.match(viewSource, /canManageTopDashboard/);
  assert.match(viewSource, /Админ TOP/);
  assert.match(repositorySource, /role === 'top' && value === true/);
  assert.match(sessionRepositorySource, /au\.can_manage_top_dashboard/);
  assert.match(panelSource, /data\.canManageTopDashboard/);
  assert.match(updateRouteSource, /result\.permissionsChanged/);
});

test('wholesale managers expose separate TOP viewing and management capabilities', () => {
  const viewSource = readFileSync(new URL(
    '../src/features/admin/wholesale/WholesaleManagerManagement.tsx',
    import.meta.url,
  ), 'utf8');
  const repositorySource = readFileSync(new URL(
    '../src/shared/lib/db/wholesaleAdminRepo/managerRepo.ts',
    import.meta.url,
  ), 'utf8');
  const sessionRepositorySource = readFileSync(new URL(
    '../src/shared/lib/db/adminSessionsRepo.ts',
    import.meta.url,
  ), 'utf8');
  const schemaSource = readFileSync(new URL(
    '../src/shared/lib/db/schema.ts',
    import.meta.url,
  ), 'utf8');
  const createRouteSource = readFileSync(new URL(
    '../src/app/api/admin/wholesale/managers/route.ts',
    import.meta.url,
  ), 'utf8');
  const updateRouteSource = readFileSync(new URL(
    '../src/app/api/admin/wholesale/managers/[id]/route.ts',
    import.meta.url,
  ), 'utf8');
  const panelSource = readFileSync(new URL(
    '../src/app/admin/AdminPanel.tsx',
    import.meta.url,
  ), 'utf8');

  assert.match(viewSource, /Админ TOP/);
  assert.match(viewSource, /canManageTopDashboard/);
  assert.match(repositorySource, /can_manage_top_dashboard/);
  assert.match(repositorySource, /withTransaction/);
  assert.match(repositorySource, /if \(input\.revokeSessions\)/);
  assert.match(sessionRepositorySource, /wm\.can_manage_top_dashboard/);
  assert.match(schemaSource, /wholesale_managers_top_management_access_check/);
  assert.match(createRouteSource, /typeof body\.canManageTopDashboard !== 'boolean'/);
  assert.match(updateRouteSource, /permissionsChanged/);
  assert.match(updateRouteSource, /shouldRevokeManagerSessionsForUpdate/);
  assert.match(panelSource, /role === 'top' \|\| isManagerRole\(role\)/);
});

test('every TOP mutation route uses the management-only server guard', () => {
  const routePaths = [
    '../src/app/api/admin/top-dashboard/blocks/route.ts',
    '../src/app/api/admin/top-dashboard/blocks/[blockId]/route.ts',
    '../src/app/api/admin/top-dashboard/blocks/[blockId]/versions/route.ts',
    '../src/app/api/admin/top-dashboard/blocks/[blockId]/active/route.ts',
    '../src/app/api/admin/top-dashboard/blocks/[blockId]/versions/[versionId]/route.ts',
    '../src/app/api/admin/top-dashboard/blocks/[blockId]/data/route.ts',
    '../src/app/api/admin/top-dashboard/blocks/[blockId]/data/active/route.ts',
  ];

  for (const path of routePaths) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /requireTopDashboardManagementSession/);
  }
});

test('TOP viewer routes enforce published-only HTML at both frame layers', () => {
  const frameSource = readFileSync(new URL(
    '../src/app/api/admin/top-dashboard/blocks/[blockId]/versions/[versionId]/frame/route.ts',
    import.meta.url,
  ), 'utf8');
  const contentSource = readFileSync(new URL(
    '../src/app/api/admin/top-dashboard/blocks/[blockId]/versions/[versionId]/content/route.ts',
    import.meta.url,
  ), 'utf8');

  assert.match(frameSource, /isPublishedTopDashboardBlockVersion/);
  assert.match(frameSource, /isTopDashboardManagementSession/);
  assert.match(contentSource, /getPublishedTopDashboardBlockVersionContent/);
  assert.match(contentSource, /isTopDashboardManagementSession/);
});

test('TOP viewer exposes only reports with both active HTML and active data', () => {
  const source = readFileSync(new URL(
    '../src/shared/lib/db/topDashboardBlocksRepo.ts',
    import.meta.url,
  ), 'utf8');
  const publishedFunctions = [
    'getPublishedTopDashboardBlocks',
    'getPublishedTopDashboardBlockOverview',
    'isPublishedTopDashboardBlockVersion',
    'getPublishedTopDashboardBlockVersionContent',
  ];

  publishedFunctions.forEach((functionName, index) => {
    const start = source.indexOf(`export async function ${functionName}`);
    const nextFunctionName = publishedFunctions[index + 1];
    const end = nextFunctionName
      ? source.indexOf(`export async function ${nextFunctionName}`, start)
      : source.indexOf('export async function activateTopDashboardBlockVersion', start);
    const section = source.slice(start, end);
    assert.ok(start >= 0 && end > start, `${functionName} source is present`);
    assert.match(section, /top_dashboard_block_data_state/);
    assert.match(section, /active_version_id is not null/);
  });
});

test('TOP viewer component contains no dashboard mutation controls', () => {
  const source = readFileSync(new URL(
    '../src/features/admin/top-dashboard/TopDashboardViewer.tsx',
    import.meta.url,
  ), 'utf8');

  assert.doesNotMatch(source, /method=["'](?:POST|PUT|PATCH|DELETE)["']/);
  assert.doesNotMatch(source, /Загрузить|Удалить|Опубликовать|Откатить/);
  assert.match(source, /Обновить/);
  assert.match(source, /На весь экран/);
});

test('dashboard CSP permits only exact uploaded scripts and handlers', () => {
  const script = "document.body.dataset.ready = 'yes';";
  const handler = "document.querySelector('#file').click()";
  const html = `<!doctype html><script>${script}</script><button onclick="${handler}">Открыть</button>`;
  const csp = buildTopDashboardContentSecurityPolicy(html);

  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /sandbox allow-scripts allow-popups/);
  assert.doesNotMatch(csp, /allow-downloads/);
  assert.doesNotMatch(csp, /allow-popups-to-escape-sandbox/);
  assert.match(csp, /'unsafe-hashes'/);
  assert.ok(csp.includes(cspHash(script)));
  assert.ok(csp.includes(cspHash(handler)));
  const scriptDirective = csp.split(';').find((directive) => directive.trim().startsWith('script-src')) ?? '';
  assert.doesNotMatch(scriptDirective, /'unsafe-inline'/);
  assert.doesNotMatch(scriptDirective, /'unsafe-eval'/);
});

test('dashboard data adapter is injected before application scripts and receives an exact CSP hash', () => {
  const appScript = "document.body.dataset.app = 'ready';";
  const original = `<!doctype html><html><head><script>${appScript}</script></head><body></body></html>`;
  const transformed = injectTopDashboardDataAdapter(original);
  const adapterScript = getTopDashboardDataAdapterScript();

  assert.ok(transformed.indexOf(adapterScript) < transformed.indexOf(appScript));
  assert.match(transformed, /<script data-kts-top-dashboard-data-adapter>/);

  const csp = buildTopDashboardContentSecurityPolicy(transformed);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /sandbox allow-scripts allow-popups/);
  assert.doesNotMatch(csp, /allow-downloads/);
  assert.doesNotMatch(csp, /allow-popups-to-escape-sandbox/);
  assert.ok(csp.includes(cspHash(adapterScript)));
  assert.doesNotMatch(csp, /allow-same-origin/);
});

test('dashboard HTML declares the compatible snapshot family without trusting its filename', () => {
  assert.equal(
    detectTopDashboardExpectedSnapshotFormat(`
      <title>КТС · Управление закупками</title>
      <input id="snapInp" type="file">
      <script>PARSERS.purchases = function () {};</script>
    `),
    'purchases-v1',
  );
  assert.equal(
    detectTopDashboardExpectedSnapshotFormat('return { format: "kts-bundle", version: 1 };'),
    'kts-bundle-v1',
  );
  assert.equal(detectTopDashboardExpectedSnapshotFormat('<input id="anything" type="file">'), null);
  assert.equal(
    detectTopDashboardExpectedProfile('const DASH_NAME = "аналитика_продаж";'),
    'sales-analytics',
  );
  assert.equal(
    detectTopDashboardExpectedProfile('const DASH_NAME = "оптимизация_ассортимента";'),
    'assortment-optimization',
  );
  assert.equal(
    detectTopDashboardExpectedProfile('<input id="snapInp" type="file">'),
    null,
    'a common input id alone must not force the purchases legacy parser',
  );
  assert.deepEqual(
    detectTopDashboardDataContract('<input id="snapInp" type="file">'),
    { mode: 'generic', snapshotFormat: 'multi-file-v1', profile: 'generic' },
  );

  assert.deepEqual(
    detectTopDashboardDataContract(
      '<input type="file" multiple><script>if (value.format !== "kts-bundle") return;</script>',
    ),
    { mode: 'generic', snapshotFormat: 'multi-file-v1', profile: 'generic' },
  );
  assert.deepEqual(
    detectTopDashboardDataContract('<main>Готовый отчёт без файлов</main>'),
    { mode: 'disabled', snapshotFormat: null, profile: null },
  );
  assert.deepEqual(
    detectTopDashboardDataContract(`
      <script>
        const upload = document.createElement('input');
        upload.type = 'file';
        document.body.append(upload);
      </script>
    `),
    { mode: 'generic', snapshotFormat: 'multi-file-v1', profile: 'generic' },
  );
  assert.deepEqual(
    detectTopDashboardDataContract(`
      <script>
        const upload = document.createElement("input");
        upload.setAttribute("type", "file");
        const DASH_NAME = "аналитика_продаж";
        return { format: "kts-bundle", version: 1 };
      </script>
    `),
    { mode: 'legacy', snapshotFormat: 'kts-bundle-v1', profile: 'sales-analytics' },
  );
  assert.deepEqual(
    detectTopDashboardDataContract(`
      <script>
        const upload = document.createElement('div');
        upload.dataset.type = 'file';
      </script>
    `),
    { mode: 'disabled', snapshotFormat: null, profile: null },
  );
});

test('dashboard data adapter hydrates supported file inputs without granting server-write access', () => {
  const adapter = getTopDashboardDataAdapterScript();

  assert.doesNotThrow(() => new Function(adapter));
  assert.match(adapter, /event\.source !== window\.parent/);
  assert.match(adapter, /value instanceof ArrayBuffer/);
  assert.match(adapter, new RegExp(`MAX_BYTES = ${TOP_DASHBOARD_DATA_MAX_BYTES}`));
  assert.match(adapter, /#snapInp/);
  assert.match(adapter, /#file/);
  assert.match(adapter, /new DataTransfer\(\)/);
  assert.match(adapter, /dispatchEvent\(new Event\('change'/);
  assert.match(adapter, /window\.handleFiles/);
  assert.match(adapter, /snapshot-installed/);
  assert.match(adapter, /data\.type === 'bridge-probe'/);
  assert.match(adapter, /window\.open = function openSandboxedWindow/);
  assert.match(adapter, /requestedUrl\.toLowerCase\(\) === 'about:blank'/);
  assert.match(adapter, /URL\.createObjectURL\(new Blob/);
  assert.match(adapter, /nativeOpen\(objectUrl, target, features\)/);
  assert.match(adapter, /URL\.revokeObjectURL/);
  assert.doesNotMatch(adapter, /opened\.opener = null/);
  assert.doesNotMatch(adapter, /snapshot-selected/);
  assert.doesNotMatch(adapter, /method: 'PUT'/);
});

test('dashboard adapter turns a legacy writable noopener popup into one Blob navigation', async () => {
  const adapter = getTopDashboardDataAdapterScript();
  const nativeOpenCalls: unknown[][] = [];
  const createdBlobs: Blob[] = [];
  const revokedUrls: string[] = [];
  const listeners = new Map<string, EventListener>();
  const fakeWindow = {
    open: (...args: unknown[]) => {
      nativeOpenCalls.push(args);
      return null;
    },
    parent: { postMessage: () => undefined },
    addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
  } as unknown as Window;
  const fakeDocument = { readyState: 'complete' } as unknown as Document;
  const fakeUrl = {
    createObjectURL: (blob: Blob) => {
      createdBlobs.push(blob);
      return 'blob:null/office-screen';
    },
    revokeObjectURL: (url: string) => revokedUrls.push(url),
  };
  const execute = new Function('window', 'document', 'URL', 'Blob', adapter);

  execute(fakeWindow, fakeDocument, fakeUrl, Blob);
  const popup = fakeWindow.open('', '_blank', 'noopener');
  assert.ok(popup);
  popup.document.open();
  popup.document.write('<h1>Экран');
  popup.document.writeln(' для офиса</h1>');
  popup.document.close();

  assert.deepEqual(nativeOpenCalls, [['blob:null/office-screen', '_blank', 'noopener']]);
  assert.equal(createdBlobs.length, 1);
  assert.equal(await createdBlobs[0].text(), '<h1>Экран для офиса</h1>\n');

  fakeWindow.open('https://example.com', '_blank', 'noopener');
  assert.deepEqual(nativeOpenCalls[1], ['https://example.com', '_blank', 'noopener']);
  listeners.get('pagehide')?.(new Event('pagehide'));
  assert.deepEqual(revokedUrls, ['blob:null/office-screen']);
});

test('dashboard download protocol accepts only safe supported files', () => {
  const blob = new Blob(['workbook']);
  const message = {
    marker: TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER,
    type: 'download-request',
    name: 'Поставки 2026-09-01.xlsx',
    blob,
  };

  assert.equal(normalizeTopDashboardDownloadName(message.name), message.name);
  assert.equal(normalizeTopDashboardDownloadName('данные.csv'), 'данные.csv');
  assert.equal(normalizeTopDashboardDownloadName('снимок.json.gz'), 'снимок.json.gz');
  assert.equal(normalizeTopDashboardDownloadName('отчёт.html'), 'отчёт.html');
  assert.equal(normalizeTopDashboardDownloadName('../отчёт.xlsx'), null);
  assert.equal(normalizeTopDashboardDownloadName('папка/отчёт.xlsx'), null);
  assert.equal(normalizeTopDashboardDownloadName('папка\\отчёт.xlsx'), null);
  assert.equal(normalizeTopDashboardDownloadName('отчёт\u202exlsx.csv'), null);
  assert.equal(normalizeTopDashboardDownloadName('вирус.exe'), null);
  assert.deepEqual(readTopDashboardDownloadMessage(message), message);
  assert.equal(readTopDashboardDownloadMessage({ ...message, marker: 'spoofed' }), null);
  assert.equal(readTopDashboardDownloadMessage({ ...message, blob: new Blob([]) }), null);
  assert.equal(readTopDashboardDownloadMessage({ ...message, name: 'вирус.exe' }), null);
  assert.equal(TOP_DASHBOARD_DOWNLOAD_MAX_BYTES, 100 * 1024 * 1024);
  assert.equal(
    getTopDashboardDownloadMimeType(message.name),
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  assert.equal(getTopDashboardDownloadMimeType('данные.csv'), 'text/csv;charset=utf-8');
});

test('dashboard adapter relays detached Blob-anchor downloads instead of navigating the sandbox', () => {
  const adapter = getTopDashboardDataAdapterScript();
  const postedMessages: unknown[] = [];
  const revokedUrls: string[] = [];
  const nativeClicks: FakeAnchor[] = [];
  const listeners = new Map<string, EventListener>();

  class FakeAnchor {
    href = '';
    download = '';

    click() {
      nativeClicks.push(this);
    }
  }

  const fakeWindow = {
    open: () => null,
    HTMLAnchorElement: FakeAnchor,
    parent: { postMessage: (message: unknown) => postedMessages.push(message) },
    addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
  } as unknown as Window;
  const fakeDocument = { readyState: 'complete' } as unknown as Document;
  let urlSequence = 0;
  const fakeUrl = {
    createObjectURL: (blob: Blob) => {
      assert.ok(blob instanceof Blob);
      return `blob:null/export-${++urlSequence}`;
    },
    revokeObjectURL: (url: string) => revokedUrls.push(url),
  };
  const execute = new Function('window', 'document', 'URL', 'Blob', adapter);

  execute(fakeWindow, fakeDocument, fakeUrl, Blob);
  postedMessages.length = 0;

  const excelBlob = new Blob(['xlsx']);
  const excelUrl = fakeUrl.createObjectURL(excelBlob);
  const excelAnchor = new FakeAnchor();
  excelAnchor.href = excelUrl;
  excelAnchor.download = 'Поставки.xlsx';
  excelAnchor.click();

  assert.equal(nativeClicks.length, 0);
  assert.equal(postedMessages.length, 1);
  assert.deepEqual(postedMessages[0], {
    marker: TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER,
    type: 'download-request',
    name: 'Поставки.xlsx',
    blob: excelBlob,
  });

  const csvBlob = new Blob(['a,b']);
  const csvUrl = fakeUrl.createObjectURL(csvBlob);
  const csvAnchor = new FakeAnchor();
  csvAnchor.href = csvUrl;
  csvAnchor.download = 'Поставки.csv';
  csvAnchor.click();
  assert.equal(postedMessages.length, 2);

  const invalidUrl = fakeUrl.createObjectURL(new Blob(['bad']));
  const invalidAnchor = new FakeAnchor();
  invalidAnchor.href = invalidUrl;
  invalidAnchor.download = '../bad.exe';
  invalidAnchor.click();
  assert.equal(nativeClicks.length, 0);
  assert.deepEqual(postedMessages[2], {
    marker: 'kts-top-dashboard-data-v1',
    type: 'adapter-error',
    code: 'DOWNLOAD_INVALID',
  });

  const regularAnchor = new FakeAnchor();
  regularAnchor.href = 'https://kts-impex.ru/catalog';
  regularAnchor.click();
  assert.deepEqual(nativeClicks, [regularAnchor]);

  assert.deepEqual(revokedUrls, [excelUrl, csvUrl, invalidUrl]);
  listeners.get('pagehide')?.(new Event('pagehide'));
});

test('dashboard frames keep downloads inside the trusted bridge and explicitly delegate fullscreen', () => {
  const sources = [
    readFileSync(new URL(
      '../src/features/admin/top-dashboard/AdminTopDashboardSection.tsx',
      import.meta.url,
    ), 'utf8'),
    readFileSync(new URL(
      '../src/features/admin/top-dashboard/TopDashboardViewer.tsx',
      import.meta.url,
    ), 'utf8'),
    readFileSync(new URL(
      '../src/app/api/admin/top-dashboard/blocks/[blockId]/versions/[versionId]/frame/route.ts',
      import.meta.url,
    ), 'utf8'),
    readFileSync(new URL(
      '../src/app/api/admin/top-dashboard/blocks/[blockId]/versions/[versionId]/content/route.ts',
      import.meta.url,
    ), 'utf8'),
  ];

  assert.match(sources[0], /sandbox="allow-scripts allow-same-origin allow-popups"/);
  assert.match(sources[1], /sandbox="allow-scripts allow-same-origin allow-popups"/);
  assert.match(sources[2], /sandbox="allow-scripts allow-popups"/);
  assert.match(sources[0], /fullscreen \*"/);
  assert.match(sources[1], /fullscreen \*"/);
  assert.match(sources[2], /fullscreen \*"/);
  assert.match(sources[0], /allowFullScreen/);
  assert.match(sources[1], /allowFullScreen/);
  assert.match(sources[2], /allowfullscreen/);
  assert.match(sources[2], /fullscreen=\*/);
  assert.match(sources[3], /fullscreen=\*/);
  sources.forEach((source) => {
    assert.doesNotMatch(source, /allow-downloads/);
    assert.doesNotMatch(source, /allow-popups-to-escape-sandbox/);
    assert.doesNotMatch(source, /fullscreen 'none'/);
  });
});

test('TOP read-only adapter blocks local file replacement and hides upload controls', () => {
  const adapter = getTopDashboardDataAdapterScript('multi-file-v1', 'generic', true);
  const transformed = injectTopDashboardDataAdapter(
    '<!doctype html><html><head></head><body><input id="file" type="file"></body></html>',
    { readOnly: true },
  );

  assert.match(adapter, /const READ_ONLY = true/);
  assert.match(adapter, /input\.disabled = true/);
  assert.match(adapter, /event\.isTrusted/);
  assert.match(adapter, /stopImmediatePropagation/);
  assert.match(adapter, /#drop/);
  assert.ok(transformed.includes(adapter));
  assert.match(getTopDashboardDataAdapterScript(), /const READ_ONLY = false/);
});

test('uploaded HTML cannot spoof the server adapter marker to bypass TOP read-only mode', () => {
  const spoofed = '<!doctype html><html><head><!-- data-kts-top-dashboard-data-adapter --></head><body><input type="file"></body></html>';
  const transformed = injectTopDashboardDataAdapter(spoofed, { readOnly: true });

  assert.notEqual(transformed, spoofed);
  assert.match(transformed, /const READ_ONLY = true/);
  assert.ok(transformed.indexOf('const READ_ONLY = true') < transformed.indexOf('<!-- data-kts'));
});

test('trusted dashboard frame bridge persists generic files only with management capability', () => {
  const bridge = createTopDashboardFrameBridgeScript(7, 29, true);
  const csp = buildTopDashboardFrameSecurityPolicy(bridge);
  const scriptDirective = csp.split(';').find((directive) => directive.trim().startsWith('script-src')) ?? '';

  assert.match(csp, /connect-src 'self'/);
  assert.ok(scriptDirective.includes(cspHash(bridge)));
  assert.doesNotMatch(scriptDirective, /'unsafe-inline'/);
  assert.doesNotMatch(scriptDirective, /'unsafe-eval'/);
  assert.match(bridge, /event\.source !== iframe\.contentWindow/);
  assert.match(bridge, /event\.origin !== 'null'/);
  assert.match(bridge, /navigator\.userActivation\.isActive/);
  assert.ok(bridge.includes(`DOWNLOAD_MARKER = '${TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER}'`));
  assert.match(bridge, /window\.parent\.postMessage/);
  assert.match(bridge, /window\.location\.origin/);
  assert.match(bridge, /validDownloadBlob\(data\.blob\)/);
  assert.match(bridge, /normalizeDownloadName\(data\.name\)/);
  assert.match(bridge, /value instanceof ArrayBuffer/);
  assert.match(bridge, /X-Top-Dashboard-Data-Version-Id/);
  assert.match(bridge, /X-Top-Dashboard-Data-Original-Name/);
  assert.match(bridge, /X-Top-Dashboard-Data-Snapshot-Format/);
  assert.match(bridge, /X-Top-Dashboard-Data-Profile/);
  assert.match(bridge, /snapshot-installed/);
  assert.match(bridge, /type: 'bridge-probe'/);
  assert.match(bridge, /setInterval\(probeAdapter, 250\)/);
  assert.doesNotMatch(bridge, /snapshot-selected/);
  assert.match(bridge, /method: 'PUT'/);
  assert.match(bridge, /expectedActiveHtmlVersionId/);
  assert.match(bridge, /CONFIG\.canManage/);
  assert.match(bridge, /multi-file-v1/);
  assert.match(bridge, /X-KTS-Top-Dashboard-Multi-File/);
  assert.ok(bridge.includes('/api/admin/top-dashboard/blocks/7/data'));
});

test('generic dashboard adapter observes trusted drops without consuming dashboard events', () => {
  const adapter = getTopDashboardDataAdapterScript('multi-file-v1', 'generic', false);
  const dropHandler = adapter.slice(
    adapter.indexOf('function captureMultiFileDrop'),
    adapter.indexOf('function matchesMultiFileTarget'),
  );

  assert.match(adapter, /document\.addEventListener\('drop', captureMultiFileDrop, true\)/);
  assert.match(dropHandler, /event\.isTrusted/);
  assert.match(dropHandler, /event\.dataTransfer/);
  assert.match(dropHandler, /captureMultiFiles\(input, transfer\.files\)/);
  assert.doesNotMatch(dropHandler, /preventDefault|stopPropagation|stopImmediatePropagation/);
  assert.match(adapter, /new MutationObserver/);
});

test('generic dashboard replaces single selections and merges multiple selections by path', () => {
  const adapter = getTopDashboardDataAdapterScript('multi-file-v1', 'generic', false);
  const bridge = createTopDashboardFrameBridgeScript(7, 29, true);

  assert.match(adapter, /merge: input\.multiple \|\| input\.hasAttribute\('webkitdirectory'\)/);
  assert.match(bridge, /const merge = data\.merge === true/);
  assert.match(bridge, /if \(data\.merge !== true && data\.merge !== false\)/);
  assert.match(bridge, /const mergedByIdentity = new Map\(\)/);
  assert.match(bridge, /current \? current\.files : \[\]/);
  assert.match(bridge, /if \(merge\)/);
  assert.match(bridge, /file\.webkitRelativePath \|\| file\.name/);
  assert.match(bridge, /mergedByIdentity\.set\(fileIdentity\(file\), file\)/);
  assert.match(bridge, /encodeMultiFileSnapshot\(nextTargets\)/);
  assert.match(bridge, /multiFileTargets = nextTargets/);
});

test('generated dashboard adapters and trusted bridges are valid browser JavaScript', () => {
  const generatedScripts = [
    getTopDashboardDataAdapterScript('multi-file-v1', 'generic', false),
    getTopDashboardDataAdapterScript('multi-file-v1', 'generic', true),
    getTopDashboardDataAdapterScript('kts-bundle-v1', 'sales-analytics', false),
    createTopDashboardFrameBridgeScript(7, 29, true),
    createTopDashboardFrameBridgeScript(7, 29, false),
  ];

  for (const script of generatedScripts) {
    assert.doesNotThrow(() => new Function(script));
  }
});

test('top-level dashboard download hook accepts messages only from its exact frame', () => {
  const hookSource = readFileSync(new URL(
    '../src/features/admin/top-dashboard/useTopDashboardDownloadBridge.ts',
    import.meta.url,
  ), 'utf8');
  const components = [
    readFileSync(new URL(
      '../src/features/admin/top-dashboard/AdminTopDashboardSection.tsx',
      import.meta.url,
    ), 'utf8'),
    readFileSync(new URL(
      '../src/features/admin/top-dashboard/TopDashboardViewer.tsx',
      import.meta.url,
    ), 'utf8'),
  ];

  assert.match(hookSource, /event\.source !== frameWindow/);
  assert.match(hookSource, /event\.origin !== window\.location\.origin/);
  assert.match(hookSource, /navigator\.userActivation\.isActive/);
  assert.match(hookSource, /readTopDashboardDownloadMessage\(event\.data\)/);
  assert.match(hookSource, /document\.body\.appendChild\(anchor\)/);
  assert.match(hookSource, /anchor\.download = message\.name/);
  assert.match(hookSource, /URL\.revokeObjectURL\(activeObjectUrl\)/);
  assert.match(hookSource, /releaseObjectUrl\(\)/);
  assert.match(hookSource, /Не удалось скачать файл/);
  assert.match(hookSource, /DOWNLOAD_THROTTLE_MS = 750/);
  components.forEach((source) => {
    assert.match(source, /useTopDashboardDownloadBridge\(showStatus\)/);
    assert.match(source, /ref=\{previewFrameRef\}/);
  });
});

test('dashboard content is accepted only from its same-origin frame shell', () => {
  const blockId = 7;
  const versionId = 42;
  const request = new Request(`https://kts-impex.ru/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/content`, {
    headers: {
      'sec-fetch-dest': 'iframe',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      referer: `https://kts-impex.ru/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/frame?revision=1`,
    },
  });
  assert.equal(isTopDashboardBlockFrameRequest(request, blockId, versionId), true);

  const reverseProxyRequest = new Request(
    `http://127.0.0.1:3000/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/content`,
    {
      headers: {
        'sec-fetch-dest': 'iframe',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        referer: `https://kts-impex.ru/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/frame?revision=1`,
      },
    },
  );
  assert.equal(isTopDashboardBlockFrameRequest(reverseProxyRequest, blockId, versionId), true);

  const directNavigation = new Request(request.url, {
    headers: {
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
    },
  });
  assert.equal(isTopDashboardBlockFrameRequest(directNavigation, blockId, versionId), false);

  const wrongParent = new Request(request.url, {
    headers: {
      'sec-fetch-dest': 'iframe',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      referer: 'https://kts-impex.ru/admin/top',
    },
  });
  assert.equal(isTopDashboardBlockFrameRequest(wrongParent, blockId, versionId), false);

  const missingParent = new Request(request.url, {
    headers: {
      'sec-fetch-dest': 'iframe',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
    },
  });
  assert.equal(isTopDashboardBlockFrameRequest(missingParent, blockId, versionId), false);

  const crossSiteFrame = new Request(request.url, {
    headers: {
      'sec-fetch-dest': 'iframe',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'cross-site',
      referer: `https://example.com/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/frame`,
    },
  });
  assert.equal(isTopDashboardBlockFrameRequest(crossSiteFrame, blockId, versionId), false);
});

test('dashboard data is readable only by the exact same-origin trusted frame', () => {
  const blockId = 7;
  const versionId = 42;
  const dataUrl = `https://kts-impex.ru/api/admin/top-dashboard/blocks/${blockId}/data`;
  const trusted = new Request(dataUrl, {
    headers: {
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      referer: `https://kts-impex.ru/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/frame?revision=3`,
    },
  });
  assert.equal(isTopDashboardBlockDataFrameRequest(trusted, blockId), true);
  assert.equal(getTopDashboardBlockDataFrameVersionId(trusted, blockId), versionId);

  const wrongBlock = new Request(dataUrl, {
    headers: {
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      referer: `https://kts-impex.ru/api/admin/top-dashboard/blocks/8/versions/${versionId}/frame`,
    },
  });
  assert.equal(isTopDashboardBlockDataFrameRequest(wrongBlock, blockId), false);
  assert.equal(getTopDashboardBlockDataFrameVersionId(wrongBlock, blockId), null);

  const directNavigation = new Request(dataUrl, {
    headers: {
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
    },
  });
  assert.equal(isTopDashboardBlockDataFrameRequest(directNavigation, blockId), false);

  const crossSite = new Request(dataUrl, {
    headers: {
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'cross-site',
      referer: `https://example.com/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/frame`,
    },
  });
  assert.equal(isTopDashboardBlockDataFrameRequest(crossSite, blockId), false);

  const putFromFrame = new Request(dataUrl, {
    method: 'PUT',
    headers: {
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      referer: `https://kts-impex.ru/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/frame`,
    },
  });
  assert.equal(isTopDashboardBlockDataFrameRequest(putFromFrame, blockId), false);
  assert.equal(
    isTopDashboardBlockDataMutationFrameRequest(putFromFrame, blockId, versionId),
    true,
  );
  assert.equal(
    isTopDashboardBlockDataMutationFrameRequest(putFromFrame, blockId, versionId + 1),
    false,
  );
});
