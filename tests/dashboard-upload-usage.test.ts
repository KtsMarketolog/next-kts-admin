import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import type { PoolClient } from 'pg';
import { getDashboardUploadUsageActor } from '../src/shared/lib/dashboardUploadUsage';
import { enqueueDashboardUploadUsage } from '../src/shared/lib/db/dashboardUploadUsageOutboxRepo';

const actor = { actorKey: 'admin:2', actorRole: 'admintop' as const };
const upload = { dashboardKey: 'top:4', versionId: 81, resourceKey: 'top-html:4:81', name: 'report.html', size: 100, type: 'html' as const };

test('upload actor is captured from authorized session identity without credentials or recipient impersonation', () => {
  assert.deepEqual(getDashboardUploadUsageActor({role: 'admintop', adminUserId: 2, sessionId: 'private-session'}), actor);
  assert.deepEqual(getDashboardUploadUsageActor({role: 'admin', sessionId: 'private-session'}), {actorKey: 'admin:primary', actorRole: 'admin'});
  assert.deepEqual(getDashboardUploadUsageActor({role: 'support_manager', managerId: 3, adminUserId: 2, sessionId: 'private-session'}), {actorKey: 'manager:3', actorRole: 'support_manager'});
  for (const session of [{role: 'admin' as const}, {role: 'admintop' as const, sessionId: 'x'},
    {role: 'manager' as const, adminUserId: 2, sessionId: 'x'}, {role: 'admin' as const, adminUserId: -1, sessionId: 'x'}]) {
    assert.throws(() => getDashboardUploadUsageActor(session), /Invalid upload actor/);
  }
});

test('intent uses caller transaction, immutable resource ID and only projected safe metadata', async () => {
  const calls: {sql: string; params: unknown[]}[] = [];
  const client = {query: async (sql: string, params: unknown[]) => {calls.push({sql, params});}} as unknown as Pick<PoolClient, 'query'>;
  await enqueueDashboardUploadUsage(client, actor, {...upload, name: 'C:\\private\\report\n.html', password: 'DO-NOT-STORE', bytes: 'DO-NOT-STORE'} as typeof upload);
  await enqueueDashboardUploadUsage(client, actor, {...upload, name: '\u202ereport\u2066.html '});
  assert.equal(calls[0].params[4], `upload_${createHash('sha256').update(upload.resourceKey).digest('hex')}`);
  assert.equal(calls[0].params[4], calls[1].params[4]);
  assert.deepEqual(calls[0].params, ['admin:2', 'admintop', 'top:4', 81, calls[0].params[4], 'report.html', 100, 'html']);
  assert.doesNotMatch(JSON.stringify(calls), /DO-NOT-STORE|private-session/);
  await enqueueDashboardUploadUsage(client, actor, {...upload, name: ' .. '});
  assert.equal(calls[2].params[5], 'file');
  assert.match(calls[0].sql, /on conflict\(actor_key,event_id\) do nothing/);
});

test('malformed durable metadata fails before any SQL; transaction owner must roll back the resource too', async () => {
  const client = {query: () => assert.fail('invalid intent must not execute SQL')} as unknown as Pick<PoolClient, 'query'>;
  for (const input of [{...upload,size:-1}, {...upload,versionId:0}, {...upload,resourceKey:''}, {...upload,dashboardKey:'foreign'},
    {...upload,size:Infinity}, {...upload,size:2_147_483_649}]) {
    await assert.rejects(enqueueDashboardUploadUsage(client, actor, input), /Invalid upload usage intent/);
  }
  await assert.rejects(enqueueDashboardUploadUsage(client, {...actor,actorKey:'manager:primary'}, upload), /Invalid upload usage intent/);
});

test('every HTTP upload path passes captured actor into persistence and only nudges the drain after success', () => {
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
    assert.match(source, /usageActor:\s*getDashboardUploadUsageActor\(/, path);
    assert.ok(source.indexOf('scheduleDashboardUploadUsageDrain();') > source.indexOf(boundary), path);
    assert.doesNotMatch(source, /await (recordDashboardUploadUsage|recordPersonalSnapshotUploadUsage|scheduleDashboardUploadUsageDrain)/, path);
  }
});

test('worker retries periodically without overlap or module-import work and never depends on an active user session', async () => {
  const immediate: (() => void)[] = [];
  let interval: (() => void) | undefined;
  let calls = 0, fail = true;
  let complete: (() => void) | undefined;
  const logs: string[] = [];
  const output: Record<string, unknown> = {};
  const unref = {unref() {}};
  vm.runInNewContext(ts.transpileModule(readFileSync('src/shared/lib/dashboardUploadUsageWorker.ts', 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText, {exports: output, console: {error: (message: string) => logs.push(message)},
    setImmediate: (fn: () => void) => {immediate.push(fn); return unref;},
    setInterval: (fn: () => void, ms: number) => {assert.equal(ms, 30_000); interval = fn; return unref;},
    require: (name: string) => {
      assert.equal(name, './db/dashboardUploadUsageOutboxRepo');
      return {drainDashboardUploadUsageOutbox: async () => {calls++; await new Promise<void>(resolve => {complete = resolve;}); if (fail) throw Error('private error');}};
    }});
  const worker = output as typeof import('../src/shared/lib/dashboardUploadUsageWorker');
  assert.equal(calls, 0); assert.equal(interval, undefined);
  worker.startDashboardUploadUsageWorker(); worker.startDashboardUploadUsageWorker();
  worker.requestDashboardUploadUsageDrain();
  assert.equal(immediate.length, 1);
  immediate.shift()!(); interval!(); assert.equal(immediate.length, 0);
  complete!(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(logs, ['DASHBOARD_UPLOAD_USAGE_DRAIN_FAILED']);
  fail = false; interval!(); immediate.shift()!(); complete!();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 2); assert.equal(logs.length, 1);
  const startup = readFileSync('src/shared/lib/runtimeStartup.ts', 'utf8');
  assert.ok(startup.indexOf('startDashboardUploadUsageWorker();') > startup.indexOf('await ensureSiteSchema()'));
});
