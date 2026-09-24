/** Synthetic data only; run through scripts/test-purchaser-postgres.sh. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { isOperationalEmployeeSessionRole, isTopDashboardManagementSession, isTopDashboardSession } from '../src/shared/lib/adminAuth';
import { query } from '../src/shared/lib/db/client';
import { createAccessUser, deleteAccessUser, getAccessUsers, getAdminUserByLogin, updateAccessUser } from '../src/shared/lib/db/adminUsersRepo';
import { createStoredAdminSession, getStoredAdminSession } from '../src/shared/lib/db/adminSessionsRepo';
import { createTopDashboardBlock } from '../src/shared/lib/db/topDashboardBlocksRepo';
import { consumeTwoFactorChallenge, createTwoFactorChallenge } from '../src/shared/lib/db/twoFactorRepo';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import {
  activateSupportSharedDashboardHtml, createSupportSharedDashboardHtml,
  getSupportSharedDashboardHtml, getSupportSharedDashboardJsonSnapshot,
  getSupportSharedDashboardOverview, getSupportSharedDashboardSnapshot,
} from '../src/shared/lib/db/supportSharedDashboardRepo';

function guard() {
  assert.equal(process.env.KTS_PURCHASER_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_purchaser_integration');
  assert.equal(url.username, 'purchaser_app');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-purchaser-postgres\.[A-Za-z0-9]+\/socket$/);
}

const input = () => ({ name: 'Synthetic purchaser', login: `purchaser-${randomUUID()}`, email: '', role: 'purchaser' as const,
  passwordHash: 'synthetic-test-hash-not-a-credential', isActive: true, canManageTopDashboard: true });
const block = () => createTopDashboardBlock({ title: `Synthetic ${randomUUID()}`, createdByAdminUserId: null, createdByManagerId: null });

test('purchaser access isolated PostgreSQL acceptance', async (t) => {
  guard();
  try {
    await ensureSiteSchema();
    await t.test('new purchasers default to no reports and cannot acquire management rights', async () => {
      const user = await createAccessUser(input());
      assert.equal(user.role, 'purchaser');
      assert.equal(user.canManageTopDashboard, false);
      assert.deepEqual(user.dashboardAccess, []);
      assert.equal((await getAdminUserByLogin(user.login))?.role, 'purchaser');
      const stored = await createStoredAdminSession({ role: 'purchaser', adminUserId: user.numericId });
      const session = await getStoredAdminSession(stored.token);
      assert.ok(session);
      assert.equal(isTopDashboardSession(session), true);
      assert.equal(isTopDashboardSession({ role: 'purchaser', adminUserId: user.numericId }), false);
      assert.equal(isTopDashboardManagementSession({ ...session, canManageTopDashboard: true }), false);
      assert.equal(isOperationalEmployeeSessionRole('purchaser'), false);
    });

    await t.test('grants round-trip, deduplicate and refresh on an already open session', async () => {
      const report = await block();
      const values = input();
      const user = await createAccessUser({ ...values, dashboardAccess: [`top:${report.id}`, 'route-planner', `top:${report.id}`] });
      assert.deepEqual(user.dashboardAccess, ['route-planner', `top:${report.id}`]);
      assert.deepEqual((await getAccessUsers()).find((item) => item.id === user.id)?.dashboardAccess, user.dashboardAccess);
      const stored = await createStoredAdminSession({ role: 'purchaser', adminUserId: user.numericId });
      assert.deepEqual((await getStoredAdminSession(stored.token))?.dashboardAccess, user.dashboardAccess);
      const updated = await updateAccessUser(user.id, { ...values, passwordHash: undefined, dashboardAccess: ['route-planner'] });
      assert.equal(updated.permissionsChanged, true);
      assert.deepEqual((await getStoredAdminSession(stored.token))?.dashboardAccess, ['route-planner']);
      const preserved = await updateAccessUser(user.id, { ...values, passwordHash: undefined, name: 'Renamed synthetic' });
      assert.equal(preserved.permissionsChanged, false);
      assert.deepEqual(preserved.user.dashboardAccess, ['route-planner']);
    });

    await t.test('unknown IDs fail atomically without creating or partially renaming users', async () => {
      const values = input();
      await assert.rejects(createAccessUser({ ...values, dashboardAccess: ['top:9007199254740991'] }), /не существует/);
      assert.equal(await getAdminUserByLogin(values.login), null);
      const user = await createAccessUser({ ...values, dashboardAccess: ['route-planner'] });
      await assert.rejects(updateAccessUser(user.id, { ...values, name: 'Must not commit', dashboardAccess: ['top:9007199254740991'] }), /не существует/);
      const current = (await getAccessUsers()).find((item) => item.id === user.id)!;
      assert.equal(current.name, values.name);
      assert.deepEqual(current.dashboardAccess, ['route-planner']);
      await assert.rejects(createAccessUser({ ...input(), dashboardAccess: ['*'] }), /Некорректный/);
    });

    await t.test('personal MR/MS grants are rejected by user writes and the database constraint', async () => {
      const values = input();
      const user = await createAccessUser({ ...values, dashboardAccess: ['route-planner'] });
      for (const key of ['manager:development', 'manager:support']) {
        const createValues = input();
        await assert.rejects(createAccessUser({ ...createValues, dashboardAccess: [key] }), /Некорректный/);
        assert.equal(await getAdminUserByLogin(createValues.login), null);
        await assert.rejects(updateAccessUser(user.id, { ...values, name: 'Must not commit', dashboardAccess: [key] }), /Некорректный/);
        await assert.rejects(query('insert into admin_user_dashboard_access(user_id,key) values($1,$2)', [user.numericId, key]), { code: '23514' });
      }
      const unchanged = (await getAccessUsers()).find((item) => item.id === user.id)!;
      assert.equal(unchanged.name, values.name);
      assert.deepEqual(unchanged.dashboardAccess, ['route-planner']);
    });

    await t.test('leaving purchaser clears grants and returning without explicit grants starts empty', async () => {
      const values = input();
      const user = await createAccessUser({ ...values, dashboardAccess: ['route-planner'] });
      const stored = await createStoredAdminSession({ role: 'purchaser', adminUserId: user.numericId });
      await updateAccessUser(user.id, { ...values, role: 'top', passwordHash: undefined });
      assert.equal(await getStoredAdminSession(stored.token), null);
      assert.equal((await query('select count(*)::int as count from admin_user_dashboard_access where user_id=$1', [user.numericId])).rows[0].count, 0);
      const returned = await updateAccessUser(user.id, { ...values, passwordHash: undefined });
      assert.deepEqual(returned.user.dashboardAccess, []);
      assert.equal(returned.user.canManageTopDashboard, false);
    });

    await t.test('deletion of a block or user removes its grants; disabled users cannot keep reading', async () => {
      const report = await block();
      const values = input();
      const user = await createAccessUser({ ...values, dashboardAccess: [`top:${report.id}`, 'route-planner'] });
      await query('delete from top_dashboard_blocks where id=$1', [report.id]);
      const saved = await updateAccessUser(user.id, { ...values, passwordHash: undefined });
      assert.deepEqual(saved.user.dashboardAccess, ['route-planner']);
      const stored = await createStoredAdminSession({ role: 'purchaser', adminUserId: user.numericId });
      await updateAccessUser(user.id, { ...values, passwordHash: undefined, isActive: false });
      assert.equal(await getStoredAdminSession(stored.token), null);
      await deleteAccessUser(user.id);
      assert.equal((await query('select count(*)::int as count from admin_user_dashboard_access where user_id=$1', [user.numericId])).rows[0].count, 0);
    });

    await t.test('purchaser two-factor challenge retains its persisted identity', async () => {
      const user = await createAccessUser(input());
      const loginSessionId = randomUUID();
      const challengeId = await createTwoFactorChallenge({ login: user.login, actorType: 'admin', role: 'purchaser',
        adminUserId: user.numericId, loginSessionId, code: '123456' });
      const challenge = await consumeTwoFactorChallenge({ challengeId, loginSessionId, code: '123456' });
      assert.equal(challenge?.actorType, 'admin');
      assert.equal(challenge?.role, 'purchaser');
      assert.equal(challenge && 'adminUserId' in challenge ? challenge.adminUserId : null, user.numericId);
    });

    await t.test('shared report rechecks purchaser grants in the database and hides drafts', async () => {
      const values = input();
      const user = await createAccessUser({ ...values, dashboardAccess: ['route-planner'] });
      const viewer = { purchaserId: user.numericId };
      const upload = (label: string) => {
        const htmlContent = `<html><body>${label}<input id="snapIn"><script>
          function loadSnapshot(j){S.orders=revive(j.orders)} function handleFiles(list){}
          window.UI={}; const example={app:'компоновщик'};</script></body></html>`;
        return createSupportSharedDashboardHtml({ originalName: `${label}.html`, htmlContent,
          fileSize: Buffer.byteLength(htmlContent), sha256: createHash('sha256').update(htmlContent).digest('hex'),
          actorId: 'admin:synthetic-purchaser-test' });
      };
      const published = await upload('published');
      const draft = await upload('draft');
      assert.deepEqual((await getSupportSharedDashboardOverview(viewer)).htmlVersions, []);
      await activateSupportSharedDashboardHtml({ versionId: published.id, expectedActiveVersionId: null,
        actorId: 'admin:synthetic-purchaser-test' });
      const overview = await getSupportSharedDashboardOverview(viewer);
      assert.deepEqual(overview.htmlVersions.map((version) => version.id), [published.id]);
      assert.equal(overview.previousHtmlVersionId, null);
      assert.equal((await getSupportSharedDashboardHtml(undefined, false, viewer))?.id, published.id);
      assert.equal(await getSupportSharedDashboardHtml(draft.id, false, viewer), null);
      assert.equal(await getSupportSharedDashboardSnapshot(viewer), null);
      assert.equal(await getSupportSharedDashboardJsonSnapshot(viewer, published.id), null);
      const deniedReads = () => Promise.all([
        assert.rejects(getSupportSharedDashboardOverview(viewer), { code: 'NOT_FOUND' }),
        assert.rejects(getSupportSharedDashboardHtml(undefined, false, viewer), { code: 'NOT_FOUND' }),
        assert.rejects(getSupportSharedDashboardSnapshot(viewer), { code: 'NOT_FOUND' }),
        assert.rejects(getSupportSharedDashboardJsonSnapshot(viewer, published.id), { code: 'NOT_FOUND' }),
      ]);
      await updateAccessUser(user.id, { ...values, passwordHash: undefined, dashboardAccess: [] });
      await deniedReads();
      await updateAccessUser(user.id, { ...values, passwordHash: undefined, dashboardAccess: ['route-planner'], isActive: false });
      await deniedReads();
      // A stale grant must not authorize a different role even if it remains in storage.
      await query("update admin_users set role='top',is_active=true where id=$1", [user.numericId]);
      await deniedReads();
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
