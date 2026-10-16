import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import type * as Helper from '../src/shared/lib/dashboardUploadUsage';

function fixture(failures = 0, role = 'manager') {
  const writes: unknown[] = [], logs: string[] = [];
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/shared/lib/dashboardUploadUsage.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, setTimeout: (fn: () => void) => fn(), console: { error: (message: string) => logs.push(message) },
    require: (name: string) => {
      if (name === 'node:crypto') return { createHash };
      if (name === './db/client') return { withTransaction: async (fn: (client: unknown) => unknown) => fn({ query: async () => ({ rows: [{ role }] }) }) };
      if (name === './db/dashboardUsageRepo') return { recordDashboardUsage: async (_session: unknown, batch: unknown) => {
        writes.push(JSON.parse(JSON.stringify(batch))); if (failures-- > 0) throw Error('private diagnostic');
      } };
      throw Error(`Unexpected dependency ${name}`);
    } });
  return { helper: exports as typeof Helper, writes: writes as Array<{dashboardKey: string; events: Array<{id: string; upload: {name: string; size: number}}> }>, logs };
}
const session = { role: 'admin' as const, sessionId: 'synthetic-session' };
const upload = { dashboardKey: 'top:4', versionId: 81, resourceKey: 'top-html:4:81', name: 'report.html', size: 100, type: 'html' as const };

test('server upload journal retries immutable IDs without file contents or false save failure', async () => {
  const f = fixture(2);
  assert.equal(await f.helper.recordDashboardUploadUsage(session, upload), true);
  assert.equal(f.writes.length, 3);
  assert.equal(new Set(f.writes.map((b) => b.events[0].id)).size, 1);
  assert.deepEqual(f.writes[0].events[0].upload, { name: 'report.html', size: 100 });
  assert.deepEqual(f.logs, []);
  const unavailable = fixture(3);
  assert.equal(await unavailable.helper.recordDashboardUploadUsage(session, upload), false);
  assert.deepEqual(unavailable.logs, ['DASHBOARD_UPLOAD_USAGE_WRITE_FAILED']);
});

test('server metadata strips paths and resolves personal recipient group from persisted role', async () => {
  const f = fixture(0, 'support_manager');
  await f.helper.recordDashboardUploadUsage(session, { ...upload, name: 'C:\\private\\report\n.html' });
  assert.equal(f.writes[0].events[0].upload.name, 'report.html');
  await f.helper.recordDashboardUploadUsage(session, { ...upload, name: '\u202ereport\u2066.html ' });
  assert.equal(f.writes[1].events[0].upload.name, 'report.html');
  await f.helper.recordDashboardUploadUsage(session, { ...upload, name: ' .. ' });
  assert.equal(f.writes[2].events[0].upload.name, 'file');
  await f.helper.recordPersonalSnapshotUploadUsage(session, { managerId: 4, snapshotId: 12, name: 'snapshot.ktsp', size: 50 });
  assert.equal(f.writes[3].dashboardKey, 'manager:support');
  assert.equal(await fixture(0, 'purchaser').helper.recordPersonalSnapshotUploadUsage(session, { managerId: 4, snapshotId: 12, name: 'snapshot.ktsp', size: 50 }), false);
});

test('server upload routes instrument only after successful persistence; unchanged duplicates are not new uploads', () => {
  const sources = [
    ['src/app/api/admin/top-dashboard/blocks/[blockId]/versions/route.ts', 'await createTopDashboardBlockVersion'],
    ['src/app/api/admin/top-dashboard/blocks/[blockId]/data/route.ts', 'await createAndActivateTopDashboardBlockDataVersion'],
    ['src/app/api/admin/manager-dashboard/html/route.ts', 'await createPersonalDashboardHtml'],
    ['src/app/api/admin/manager-dashboard/shared/html/route.ts', 'await createSupportSharedDashboardHtml'],
    ['src/app/api/admin/manager-dashboard/shared/json/route.ts', 'await importSupportSharedDashboardJson'],
    ['src/app/api/admin/manager-dashboard/shared/snapshots/route.ts', 'await importSupportSharedDashboardSnapshot'],
    ['src/app/api/admin/manager-dashboard/snapshots/route.ts', 'await importPersonalDashboardSnapshot'],
  ];
  for (const [path, boundary] of sources) {
    const source = readFileSync(path, 'utf8');
    const audit = Math.max(source.indexOf('await recordDashboardUploadUsage'), source.indexOf('await recordPersonalSnapshotUploadUsage'));
    assert.ok(audit > source.indexOf(boundary) && source.indexOf(boundary) > 0, path);
    if (path.endsWith('/snapshots/route.ts') || path.endsWith('/shared/json/route.ts')) assert.match(source, /result.status === 'imported'/);
  }
});

test('leader snapshot uploads are journaled as MR without confusing manager and admin IDs', async () => {
  for (const role of ['admin', 'admintop', 'top']) {
    const f = fixture(0, role);
    assert.equal(await f.helper.recordPersonalSnapshotUploadUsage(session, { adminUserId: 4, snapshotId: 13, name: 'leader.ktsp', size: 50 }), true);
    assert.equal(f.writes[0].dashboardKey, 'manager:development');
    assert.equal(f.writes[0].events[0].upload.name, 'leader.ktsp');
    assert.equal(await f.helper.recordPersonalSnapshotUploadUsage(session, { adminUserId: 4, managerId: 4, snapshotId: 13, name: 'leader.ktsp', size: 50 }), false);
    assert.equal(f.writes.length, 1);
  }
  for (const role of ['purchaser', 'wholesale_admin', 'manager', 'support_manager']) {
    const f = fixture(0, role);
    assert.equal(await f.helper.recordPersonalSnapshotUploadUsage(session, { adminUserId: 4, snapshotId: 13, name: 'leader.ktsp', size: 50 }), false);
    assert.equal(f.writes.length, 0);
  }
});
