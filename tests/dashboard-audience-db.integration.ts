/** Synthetic data only; invoked after purchaser acceptance in its isolated PostgreSQL cluster. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { canViewDashboard } from '../src/shared/lib/dashboardAccess';
import { hasDashboardManagementRight } from '../src/shared/lib/dashboardPermissions';
import { query } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { createTopDashboardBlock } from '../src/shared/lib/db/topDashboardBlocksRepo';
import { createAccessUser, getAccessUsers, updateAccessUser } from '../src/shared/lib/db/adminUsersRepo';
import { createStoredAdminSession, getStoredAdminSession } from '../src/shared/lib/db/adminSessionsRepo';
import { DashboardAudienceForbiddenError, getDashboardAudience, getDashboardGrantOptions, setDashboardAudience } from '../src/shared/lib/db/dashboardAccessRepo';

const values = (role: 'top' | 'manager' | 'support_manager' | 'purchaser' | 'admin' = 'purchaser') => ({
  name: 'Synthetic audience employee', login: `audience-${randomUUID()}`, email: '', role,
  passwordHash: 'synthetic-test-not-a-password', isActive: true, canManageTopDashboard: false,
});
const report = () => createTopDashboardBlock({title: `Audience policy ${randomUUID()}`, createdByAdminUserId: null, createdByManagerId: null});
async function selectAll(key: string) {
  const current = await getDashboardAudience(key);
  return setDashboardAudience(key, current.users.filter((user) => user.eligible).map((user) => user.id), current.version, 'all');
}

test('all-employees policy isolated PostgreSQL acceptance', async (t) => {
  assert.equal(process.env.KTS_PURCHASER_TEST, '1');
  const database = new URL(process.env.DATABASE_URL!);
  assert.equal(database.hostname, 'localhost');
  assert.equal(database.pathname, '/kts_purchaser_integration');
  assert.match(database.searchParams.get('host')!, /^\/(?:private\/)?tmp\/kts-purchaser-postgres\.[A-Za-z0-9]+\/socket$/);
  try {
    await ensureSiteSchema();
    await t.test('legacy individual mode remains default; all mode applies to future active users without management', async () => {
      const block = await report(); const key = `top:${block.id}`;
      assert.equal((await getDashboardAudience(key)).mode, 'individual');
      const selected = await selectAll(key);
      assert.equal(selected.mode, 'all');
      assert.equal((await getDashboardGrantOptions()).find((option) => option.key === key)?.defaultGranted, true);
      for (const role of ['purchaser', 'top', 'manager', 'support_manager'] as const) {
        const user = await createAccessUser(values(role));
        assert.ok(user.dashboardAccess.includes(key), role);
        assert.ok((await getAccessUsers()).find((item) => item.id === user.id)?.dashboardAccess.includes(key));
        const saved = await createStoredAdminSession({role, ...(user.source === 'manager' ? {managerId: user.numericId} : {adminUserId: user.numericId})});
        const session = await getStoredAdminSession(saved.token);
        assert.equal(canViewDashboard(session, key), true);
        assert.equal(hasDashboardManagementRight(session, key), false);
      }
      const other = await report();
      assert.equal((await getDashboardAudience(`top:${other.id}`)).mode, 'individual', 'all employees is scoped to one report, not future reports');
      await query('delete from top_dashboard_blocks where id=any($1::bigint[])', [[block.id, other.id]]);
      assert.equal((await query('select count(*)::int as count from dashboard_audience_policies where key=$1', [key])).rows[0].count, 0);
    });

    await t.test('inactive accounts inherit selection but gain actual viewing only after activation', async () => {
      const block = await report(); const key = `top:${block.id}`;
      const input = {...values(), isActive: false};
      const user = await createAccessUser(input);
      await selectAll(key);
      assert.equal((await getDashboardAudience(key)).users.find((item) => item.id === user.id)?.checked, true);
      const denied = await createStoredAdminSession({role: 'purchaser', adminUserId: user.numericId});
      assert.equal(await getStoredAdminSession(denied.token), null);
      const activated = await updateAccessUser(user.id, {...input, passwordHash: undefined, isActive: true});
      assert.ok(activated.user.dashboardAccess.includes(key));
      const active = await createStoredAdminSession({role: 'purchaser', adminUserId: user.numericId});
      assert.equal(canViewDashboard(await getStoredAdminSession(active.token), key), true);
      await query('delete from top_dashboard_blocks where id=$1', [block.id]);
    });

    await t.test('employee opt-out and re-enable are exceptions in the same rule; stale writes are rejected', async () => {
      const block = await report(); const key = `top:${block.id}`;
      await selectAll(key);
      const input = values(); const user = await createAccessUser(input);
      const stored = await createStoredAdminSession({role: 'purchaser', adminUserId: user.numericId});
      const before = await getDashboardAudience(key);
      const current = (await getAccessUsers()).find((item) => item.id === user.id)!;
      const updated = await updateAccessUser(user.id, {...input, passwordHash: undefined, dashboardAccess: current.dashboardAccess.filter((grant) => grant !== key), dashboardAccessVersion: current.dashboardAccessVersion});
      assert.equal(canViewDashboard(await getStoredAdminSession(stored.token), key), false);
      const excluded = await getDashboardAudience(key);
      assert.equal(excluded.mode, 'all');
      assert.equal(excluded.users.find((item) => item.id === user.id)?.checked, false);
      await assert.rejects(setDashboardAudience(key, before.users.filter((item) => item.eligible).map((item) => item.id), before.version, 'all'), /изменены/);
      await assert.rejects(updateAccessUser(user.id, {...input, passwordHash: undefined, dashboardAccess: current.dashboardAccess, dashboardAccessVersion: current.dashboardAccessVersion}), /другом окне/);
      const restored = await setDashboardAudience(key, [...excluded.users.filter((item) => item.eligible && item.checked).map((item) => item.id), user.id], excluded.version, 'all');
      assert.equal(restored.users.find((item) => item.id === user.id)?.checked, true);
      assert.equal(canViewDashboard(await getStoredAdminSession(stored.token), key), true);
      assert.ok(!(updated.user.dashboardAccess.includes(key)));
      const future = await createAccessUser(values());
      assert.ok(future.dashboardAccess.includes(key), 'one exception never turns off the rule for future employees');
      await query('delete from top_dashboard_blocks where id=$1', [block.id]);
    });

    await t.test('switching all to individual freezes selection, and rule-only revision invalidates old editor state', async () => {
      const block = await report(); const key = `top:${block.id}`;
      const first = await selectAll(key);
      const same = await setDashboardAudience(key, first.users.filter((item) => item.eligible && item.checked).map((item) => item.id), first.version, 'all');
      assert.notEqual(same.version, first.version);
      await assert.rejects(setDashboardAudience(key, [], first.version, 'individual'), /изменены/);
      const individual = await setDashboardAudience(key, same.users.filter((item) => item.eligible && item.checked).map((item) => item.id), same.version, 'individual');
      assert.equal(individual.mode, 'individual');
      for (const employee of individual.users.filter((item) => item.eligible && !item.locked)) assert.equal(employee.checked, true);
      const future = await createAccessUser(values());
      assert.equal(future.dashboardAccess.includes(key), false);
      assert.equal((await getDashboardGrantOptions()).find((option) => option.key === key)?.defaultGranted, false);
      await query('delete from top_dashboard_blocks where id=$1', [block.id]);
    });

    await t.test('personal all mode remains own-group only and cannot remove management authority', async () => {
      for (const key of ['manager:development', 'manager:support']) {
        await selectAll(key);
        try {
          for (const role of ['manager', 'support_manager', 'purchaser'] as const) {
            const user = await createAccessUser(values(role));
            const saved = await createStoredAdminSession({role, ...(user.source === 'manager' ? {managerId: user.numericId} : {adminUserId: user.numericId})});
            const expected = key === 'manager:development' ? role === 'manager' : role === 'support_manager';
            assert.equal(canViewDashboard(await getStoredAdminSession(saved.token), key), expected, `${role}/${key}`);
          }
          const admin = await createAccessUser(values('admin'));
          const current = await getDashboardAudience(key);
          const cleared = await setDashboardAudience(key, [], current.version, 'all');
          const locked = cleared.users.find((user) => user.id === admin.id)!;
          assert.equal(locked.locked, true); assert.equal(locked.checked, true);
          const excluded = await query('select id from dashboard_audience_exclusions where key=$1 and admin_user_id=$2', [key, admin.numericId]);
          assert.equal(excluded.rowCount, 0);
        } finally {
          const current = await getDashboardAudience(key);
          await setDashboardAudience(key, current.users.filter((user) => user.checked && user.eligible).map((user) => user.id), current.version, 'individual');
        }
      }
    });

    await t.test('Admin TOP scoped audience hides administrators and rejects direct administrator targets', async () => {
      const block = await report(); const key = `top:${block.id}`;
      const admin = await createAccessUser(values('admin'));
      const scoped = await getDashboardAudience(key, 'admintop');
      assert.ok(!scoped.users.some((user) => user.role === 'admin'));
      await assert.rejects(setDashboardAudience(key, [admin.id], scoped.version, 'individual', 'admintop'), DashboardAudienceForbiddenError);
      const all = await setDashboardAudience(key, scoped.users.filter((user) => user.eligible).map((user) => user.id), scoped.version, 'all', 'admintop');
      assert.equal(all.mode, 'all'); assert.ok(!all.users.some((user) => user.role === 'admin'));
      await query('delete from top_dashboard_blocks where id=$1', [block.id]);
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
