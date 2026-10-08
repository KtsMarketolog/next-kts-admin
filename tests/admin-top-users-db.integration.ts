/** Run only with scripts/test-purchaser-postgres.sh: disposable local PostgreSQL, synthetic identities. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AccessUserManagementError, AccessUserProfileForbiddenError, DashboardOptionsConflictError } from '../src/shared/lib/accessUserManagement';
import { createAccessUser, deleteAccessUser, getAccessUsers, updateAccessUser } from '../src/shared/lib/db/adminUsersRepo';
import { query } from '../src/shared/lib/db/client';
import { dashboardGrantOptionsVersion, getDashboardAudience, getDashboardGrantOptions, setDashboardAudience } from '../src/shared/lib/db/dashboardAccessRepo';

function guard() {
  assert.equal(process.env.KTS_PURCHASER_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_purchaser_integration');
  assert.equal(url.username, 'purchaser_app');
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-purchaser-postgres\.[A-Za-z0-9]+\/socket$/);
}

const values = () => ({ name: 'Synthetic delegated user', login: `delegated-${randomUUID()}`, email: '', role: 'purchaser' as const,
  isActive: true, canManageTopDashboard: false, passwordHash: `synthetic-hash-${randomUUID()}`, dashboardAccess: [] as string[] });

test('Admin TOP scoped account administration in isolated PostgreSQL', async (t) => {
  guard();
  try {
    const adminInput = { ...values(), role: 'admin' as const, dashboardAccess: ['currency-rates'] };
    const admin = await createAccessUser(adminInput);
    const delegatedInput = { ...values(), role: 'admintop' as const };
    const delegated = await createAccessUser(delegatedInput);

    await t.test('read projection excludes site administrators and all credential material', async () => {
      const result = await getAccessUsers(delegated.numericId, 'admintop');
      assert.equal(result.some((user) => user.role === 'admin'), false);
      assert.equal(result.some((user) => user.id === admin.id), false);
      assert.doesNotMatch(JSON.stringify(result), /passwordHash|password_hash|synthetic-hash/);
      assert.equal(result.find((user) => user.id === delegated.id)?.isCurrent, true);
      assert.ok((await getAccessUsers(admin.numericId, 'admin')).some((user) => user.id === admin.id));
    });

    await t.test('every delegated attempt to alter a site administrator is atomic and forbidden', async () => {
      const before = (await query('select name,login,role,password_hash,is_active from admin_users where id=$1', [admin.numericId])).rows[0];
      const grants = (await query('select key from dashboard_view_grants where admin_user_id=$1 order by key', [admin.numericId])).rows;
      for (const changes of [{ role: 'purchaser' as const }, { passwordHash: 'unexpected-overwrite' }, { isActive: false }, { name: 'Changed' }, { dashboardAccess: [] }]) {
        await assert.rejects(updateAccessUser(admin.id, { ...adminInput, ...changes }, delegated.numericId, 'admintop'), AccessUserManagementError);
      }
      // A forged client role of purchaser must not bypass the actual stored role check.
      await assert.rejects(updateAccessUser(admin.id, { ...adminInput, role: 'purchaser', passwordHash: 'unexpected-overwrite' }, delegated.numericId, 'admintop'), AccessUserManagementError);
      await assert.rejects(deleteAccessUser(admin.id, delegated.numericId, 'admintop'), AccessUserProfileForbiddenError);
      assert.deepEqual((await query('select name,login,role,password_hash,is_active from admin_users where id=$1', [admin.numericId])).rows[0], before);
      assert.deepEqual((await query('select key from dashboard_view_grants where admin_user_id=$1 order by key', [admin.numericId])).rows, grants);
      const forbiddenLogin = values();
      await assert.rejects(createAccessUser({ ...forbiddenLogin, role: 'admin' }, 'admintop'), AccessUserManagementError);
      assert.equal((await query('select id from admin_users where login=$1', [forbiddenLogin.login])).rowCount, 0);
    });

    await t.test('non-admin creation and grant-only edits preserve every existing profile field', async () => {
      for (const role of ['wholesale_admin', 'top', 'admintop', 'purchaser', 'manager', 'support_manager'] as const) {
        const input = { ...values(), role };
        const user = await createAccessUser(input, 'admintop');
        await assert.rejects(updateAccessUser(user.id, { ...input, role: 'admin' }, delegated.numericId, 'admintop'), AccessUserManagementError);
        const table = user.source === 'admin' ? 'admin_users' : 'wholesale_managers';
        const before = (await query(`select name,login,email,role,is_active,password_hash,can_manage_top_dashboard from ${table} where id=$1`, [user.numericId])).rows[0];
        for (const change of [{name:'Changed'}, {login:'changed'}, {email:'changed@example.test'}, {passwordHash:'replacement'}, {isActive:false}, {canManageTopDashboard:true}, {supportManagerId:123}]) {
          await assert.rejects(updateAccessUser(user.id, { ...input, passwordHash: undefined, ...change }, delegated.numericId, 'admintop'), AccessUserProfileForbiddenError);
        }
        const saved = await updateAccessUser(user.id, { ...input, passwordHash: undefined, dashboardAccess: ['currency-rates'] }, delegated.numericId, 'admintop');
        assert.equal(saved.user.role, role);
        assert.equal(saved.passwordChanged, false);
        assert.ok(saved.user.dashboardAccess.includes('currency-rates'));
        assert.deepEqual((await query(`select name,login,email,role,is_active,password_hash,can_manage_top_dashboard from ${table} where id=$1`, [user.numericId])).rows[0], before);
        await assert.rejects(deleteAccessUser(saved.user.id, delegated.numericId, 'admintop'), AccessUserProfileForbiddenError);
        const deleted = await deleteAccessUser(saved.user.id);
        assert.equal(deleted.id, user.id);
      }
      await assert.rejects(updateAccessUser(delegated.id, { ...delegatedInput, name: 'Own profile', passwordHash: undefined }, delegated.numericId, 'admintop'), AccessUserProfileForbiddenError);
      await assert.rejects(deleteAccessUser(delegated.id, delegated.numericId, 'admintop'), AccessUserProfileForbiddenError);
      await assert.rejects(updateAccessUser(delegated.id, { ...delegatedInput, isActive: false }, delegated.numericId, 'admintop'), AccessUserProfileForbiddenError);
    });

    await t.test('legacy manager file-management flag survives delegated grant-only edits', async () => {
      for (const role of ['manager', 'support_manager'] as const) {
        const input = { ...values(), role };
        const user = await createAccessUser(input);
        await query('update wholesale_managers set can_access_top_dashboard=true,can_manage_top_dashboard=true where id=$1', [user.numericId]);
        const saved = await updateAccessUser(user.id, { ...input, passwordHash: undefined, canManageTopDashboard: true, dashboardAccess: ['currency-rates'] }, delegated.numericId, 'admintop');
        assert.equal(saved.user.canManageTopDashboard, true);
        assert.equal(saved.passwordChanged, false);
        assert.equal((await query('select can_manage_top_dashboard from wholesale_managers where id=$1', [user.numericId])).rows[0].can_manage_top_dashboard, true);
        await deleteAccessUser(user.id);
      }
    });

    await t.test('a different role cannot call the scoped repository or inherit Admin TOP authority', async () => {
      for (const actor of ['top', 'wholesale_admin', 'purchaser', 'manager', 'support_manager'] as const) {
        await assert.rejects(getAccessUsers(delegated.numericId, actor), AccessUserManagementError);
        await assert.rejects(createAccessUser(values(), actor), AccessUserManagementError);
        await assert.rejects(updateAccessUser(delegated.id, delegatedInput, delegated.numericId, actor), AccessUserManagementError);
        await assert.rejects(deleteAccessUser(delegated.id, delegated.numericId, actor), AccessUserManagementError);
      }
    });

    await t.test('stale explicit creation fails atomically, untouched creation inherits and deliberate current opt-out works', async () => {
      const original = await getDashboardAudience('currency-rates');
      await setDashboardAudience('currency-rates', [], original.version, 'individual');
      const staleVersion = dashboardGrantOptionsVersion(await getDashboardGrantOptions());
      const individual = await getDashboardAudience('currency-rates');
      await setDashboardAudience('currency-rates', [], individual.version, 'all');
      const stale = { ...values(), dashboardOptionsVersion: staleVersion };
      await assert.rejects(createAccessUser(stale, 'admintop'), DashboardOptionsConflictError);
      assert.equal((await query('select id from admin_users where login=$1', [stale.login])).rowCount, 0);
      const inherited = await createAccessUser({ ...values(), dashboardAccess: undefined }, 'admintop');
      assert.ok(inherited.dashboardAccess.includes('currency-rates'));
      const currentVersion = dashboardGrantOptionsVersion(await getDashboardGrantOptions());
      const optedOut = await createAccessUser({ ...values(), dashboardOptionsVersion: currentVersion }, 'admintop');
      assert.equal(optedOut.dashboardAccess.includes('currency-rates'), false);
      await deleteAccessUser(inherited.id);
      await deleteAccessUser(optedOut.id);
    });
  } finally {
    await (globalThis as typeof globalThis & { __ktsPgPool?: { end(): Promise<void> } }).__ktsPgPool?.end();
  }
});
