import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import test from 'node:test';
import { loadManagerDashboardRepo } from './helpers/load-manager-dashboard-repo';

import type { AdminSession } from '../src/shared/lib/adminAuth';
import * as permissions from '../src/shared/lib/dashboardPermissions';
import * as audience from '../src/shared/lib/managerDashboardAudience';
import * as domain from '../src/shared/lib/managerDashboardDomain';
import * as pagination from '../src/shared/lib/managerDashboardImportPagination';
import * as recipients from '../src/shared/lib/managerDashboardRecipients';

type Account = { source: 'manager' | 'admin'; id: string; name: string; email: string; role: string | null; is_active: boolean };
type Snapshot = {
  id: string; manager_id: string | null; admin_user_id: string | null; email_hash: string;
  received_at: string; issued: string; active: boolean;
};
type Grant = { manager_id: string; key: string };
const publishedAt = '2026-10-01T07:00:00Z';
const emptyDates = { dataUploadedAt: null, dataAsOf: null, htmlPublishedAt: null };
const account = (source: Account['source'], id: number, role: Account['role'] = 'manager'): Account => ({
  source, id: String(id), role, name: `${source} ${id}`, email: `${source}-${id}@example.test`, is_active: true,
});
const snapshot = (owner: Account, day: number, active = true): Snapshot => ({
  id: String(day * 1000 + Number(owner.id)),
  manager_id: owner.source === 'manager' ? owner.id : null,
  admin_user_id: owner.source === 'admin' ? owner.id : null,
  email_hash: domain.getManagerEmailHash(owner.email),
  received_at: `2026-10-${String(day).padStart(2, '0')}T05:30:00Z`,
  issued: `2026-10-${String(day - 1).padStart(2, '0')}`, active,
});
const grant = (owner: Account, group = 'development'): Grant => ({ manager_id: owner.id, key: `manager:${group}` });
const viewer = (role: AdminSession['role'], id = 1): AdminSession => ({
  role, sessionId: 'synthetic-session', ...(role === 'manager' || role === 'support_manager' ? { managerId: id } : { adminUserId: id }),
  dashboardAccess: ['manager:development', 'manager:support'],
});

function harness(accounts: Account[], grants: Grant[], snapshots: Snapshot[], authority = true) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    assert.doesNotMatch(sql, /\b(insert|update|delete|drop|truncate|alter)\b/i, 'date reads cannot mutate stored data');
    assert.doesNotMatch(sql, /encrypted_payload|html_content/, 'date reads never load dashboard contents');
    const result = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (sql.includes('pg_advisory_xact_lock_shared') || sql.startsWith('lock table ')) return result([]);
    if (sql.includes('from admin_sessions s join admin_users u')) {
      assert.match(sql, /s\.revoked_at is null and s\.expires_at>now\(\)/);
      assert.match(sql, /s\.created_at>=u\.password_changed_at/);
      return result(authority ? [{ id: params[0] }] : []);
    }
    if (sql.includes("select 'manager'::text as source")) return result(accounts.filter((row) => row.source === 'manager'));
    if (sql.includes("select 'admin'::text as source")) return result(accounts.filter((row) => row.source === 'admin'));
    if (sql.includes('from dashboard_effective_view_grants')) return result(grants);
    if (sql.includes('select v.first_published_at::text')) {
      assert.match(sql, /v\.id=st\.active_version_id and v\.audience=st\.audience/);
      return result([{ first_published_at: publishedAt }]);
    }
    if (sql.includes('from personal_dashboard_snapshot_state st join personal_dashboard_snapshots s')) {
      assert.match(sql, /st\.manager_id=s\.manager_id or st\.admin_user_id=s\.admin_user_id/);
      assert.match(sql, /s\.id=st\.active_snapshot_id/);
      assert.match(sql, /s\.manager_id=any\(\$1::bigint\[\]\) or s\.admin_user_id=any\(\$2::bigint\[\]\)/);
      assert.match(sql, /order by s\.received_at desc,s\.id desc/);
      const [managerIds, adminIds] = params as [string[], string[]];
      return result(snapshots.filter((row) => row.active && (managerIds.includes(row.manager_id!) || adminIds.includes(row.admin_user_id!)))
        .sort((left, right) => right.received_at.localeCompare(left.received_at) || Number(right.id) - Number(left.id)));
    }
    assert.fail(`Unexpected SQL: ${sql}`);
  };
  const modules: Record<string, unknown> = {
    'node:crypto': crypto, '../dashboardPermissions': permissions, '../managerDashboardAudience': audience,
    '../managerDashboardRecipients': recipients, '../managerDashboardDomain': domain,
    '../managerDashboardImportPagination': pagination, './dashboardAccessRepo': { DASHBOARD_ACCESS_LOCK: 'kts:dashboard-view-grants' },
    '../dashboardUploadUsage': {getDashboardUploadUsageActor: () => assert.fail('Date reads must not create upload actors')},
    '../managerDashboardSnapshotReplacementToken': new Proxy({}, {get: () => () => assert.fail('Date reads must not use replacement tokens')}),
    './dashboardUploadUsageOutboxRepo': {enqueueDashboardUploadUsage: () => assert.fail('Date reads must not enqueue uploads')},
    './schema': { ensureSiteSchema: async () => {} },
    './client': { query, withTransaction: async (run: (client: { query: typeof query }) => Promise<unknown>) => run({ query }) },
  };
  const repo = loadManagerDashboardRepo(modules);
  const queriedRecipients = () => calls.find(({ sql }) => sql.includes('s.manager_id=any($1::bigint[])'))?.params;
  return { read: repo.getPersonalDashboardReportDates, calls, queriedRecipients };
}

test('TOP metadata aggregates visible MR team and own leader without conflating equal account IDs', async () => {
  const own = account('admin', 1, 'top');
  const sameIdManager = account('manager', 1);
  const otherLeader = account('admin', 2, 'top');
  const hidden = account('manager', 3);
  const ms = account('manager', 4, 'support_manager');
  const rows = [snapshot(sameIdManager, 12), snapshot(own, 13), snapshot(otherLeader, 30), snapshot(hidden, 29), snapshot(ms, 28)];
  const db = harness([own, sameIdManager, otherLeader, hidden, ms], [grant(sameIdManager), grant(ms, 'support')], rows);
  const dates = await db.read({ ...viewer('top'), managerId: 2 }, 'development');
  assert.equal(dates.dataUploadedAt, rows[1].received_at);
  assert.equal(dates.dataAsOf, rows[1].issued);
  assert.deepEqual(db.queriedRecipients(), [['1'], ['1']]);
  const noOwn = harness([own, sameIdManager, otherLeader], [grant(sameIdManager)], [rows[0], rows[2]]);
  assert.equal((await noOwn.read(viewer('top'), 'development')).dataUploadedAt, rows[0].received_at);
});

test('admin and admintop aggregate only visible own-role recipients including eligible leaders', async () => {
  const mr = account('manager', 1, null);
  const ms = account('manager', 2, 'support_manager');
  const inactive = { ...account('manager', 3), is_active: false };
  const excluded = account('manager', 4);
  const leaders = ['admin', 'admintop', 'top'].map((role, index) => account('admin', index + 1, role));
  const inactiveLeader = { ...account('admin', 7, 'top'), is_active: false };
  const purchaser = account('admin', 8, 'purchaser');
  const accounts = [mr, ms, inactive, excluded, ...leaders, inactiveLeader, purchaser];
  const grants = [grant(mr), grant(ms, 'support'), grant(inactive), grant(ms), grant(excluded, 'support')];
  const rows = accounts.map((owner, index) => snapshot(owner, index + 10));
  for (const role of ['admin', 'admintop'] as const) {
    const db = harness(accounts, grants, rows);
    assert.equal((await db.read(viewer(role), 'development')).dataUploadedAt, rows[6].received_at);
    assert.deepEqual(db.queriedRecipients(), [['1'], ['1', '2', '3']]);
    const support = harness(accounts, grants, rows);
    assert.equal((await support.read(viewer(role), 'support')).dataUploadedAt, rows[1].received_at);
    assert.deepEqual(support.queriedRecipients(), [['2'], []]);
  }
});

test('MR and MS metadata is own-only and a wrong-audience checkbox never widens access', async () => {
  const mr = account('manager', 1);
  const ms = account('manager', 2, 'support_manager');
  const other = account('manager', 3);
  const leader = account('admin', 1, 'top');
  const accounts = [mr, ms, other, leader];
  const grants = [grant(mr), grant(ms, 'support'), grant(other)];
  const rows = accounts.map((owner, index) => snapshot(owner, index + 10));
  for (const [role, owner, group, wrong] of [
    ['manager', mr, 'development', 'support'], ['support_manager', ms, 'support', 'development'],
  ] as const) {
    const db = harness(accounts, grants, rows);
    assert.equal((await db.read(viewer(role, Number(owner.id)), group)).dataUploadedAt, rows[accounts.indexOf(owner)].received_at);
    assert.deepEqual(db.queriedRecipients(), [[owner.id], []]);
    const denied = harness(accounts, grants, rows);
    assert.deepEqual(await denied.read(viewer(role, Number(owner.id)), wrong), emptyDates);
    assert.equal(denied.calls.length, 0);
  }
});

test('revoked grants and inactive accounts cannot contribute retained dates', async () => {
  for (const active of [true, false]) {
    const mr = { ...account('manager', 1), is_active: active };
    const db = harness([mr], active ? [] : [grant(mr)], [snapshot(mr, 20)]);
    assert.deepEqual(await db.read(viewer('manager'), 'development'), { ...emptyDates, htmlPublishedAt: publishedAt });
    assert.equal(db.queriedRecipients(), undefined);
  }
  const deniedTop = harness([account('admin', 1, 'top')], [], [], false);
  await assert.rejects(deniedTop.read(viewer('top'), 'development'), { code: 'REVIEW_FORBIDDEN' });
  assert.equal(deniedTop.calls.some(({ sql }) => sql.startsWith('lock table ')), false);
});

test('hidden cross-audience and cross-source email collisions suppress dates without exposing hidden accounts', async () => {
  for (const duplicate of [account('manager', 2, 'support_manager'), account('admin', 2, 'top')]) {
    const mr = account('manager', 1);
    duplicate.email = `\u00a0${mr.email.toUpperCase()}\u00a0`;
    const row = snapshot(mr, 20);
    const db = harness([mr, duplicate], [grant(mr)], [row]);
    assert.equal((await db.read(viewer('manager'), 'development')).dataUploadedAt, null);
    assert.equal(db.queriedRecipients(), undefined);
    const restored = harness([mr, { ...duplicate, is_active: false }], [grant(mr)], [row]);
    assert.equal((await restored.read(viewer('manager'), 'development')).dataUploadedAt, row.received_at);
  }
});

test('current email binding and active pointer select paired dates, never a newer archived or mismatched snapshot', async () => {
  const mr = account('manager', 1);
  const other = account('manager', 2);
  const changed = snapshot(other, 29);
  other.email = 'changed@example.test';
  const active = snapshot(mr, 12);
  const db = harness([mr, other], [grant(mr), grant(other)], [active, changed, snapshot(mr, 30, false)]);
  assert.deepEqual(await db.read(viewer('admin'), 'development'), {
    dataUploadedAt: active.received_at, dataAsOf: active.issued, htmlPublishedAt: publishedAt,
  });
  const missingEmail = harness([{ ...mr, email: '' }], [grant(mr)], [active]);
  assert.equal((await missingEmail.read(viewer('manager'), 'development')).dataUploadedAt, null);
  assert.equal(missingEmail.queriedRecipients(), undefined);
});

test('metadata takes shared access lock before identity locks and reads all scoped dates in one batch', async () => {
  const accounts = Array.from({ length: 50 }, (_, index) => account('manager', index + 1));
  const db = harness(accounts, accounts.map((owner) => grant(owner)), accounts.map((owner) => snapshot(owner, 12)));
  await db.read(viewer('admin'), 'development');
  const advisory = db.calls.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock_shared'));
  const identityLock = db.calls.findIndex(({ sql }) => sql.startsWith('lock table '));
  assert.ok(advisory >= 0 && advisory < identityLock);
  assert.equal(db.calls.filter(({ sql }) => sql.includes('from personal_dashboard_snapshot_state')).length, 1);
  assert.deepEqual(db.queriedRecipients(), [accounts.map(({ id }) => id), []]);
});
