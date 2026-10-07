/** Synthetic data only; run with scripts/test-dashboard-usage-postgres.sh. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { enforceAdminActionRateLimit } from '../src/shared/lib/adminSecurity';
import { createAccessUser, updateAccessUser } from '../src/shared/lib/db/adminUsersRepo';
import { createStoredAdminSession, getStoredAdminSession } from '../src/shared/lib/db/adminSessionsRepo';
import { query } from '../src/shared/lib/db/client';
import { dashboardUsageActorKey, listDashboardUsage, recordDashboardUsage } from '../src/shared/lib/db/dashboardUsageRepo';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { createTopDashboardBlock } from '../src/shared/lib/db/topDashboardBlocksRepo';

function guard() {
  assert.equal(process.env.KTS_USAGE_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_usage_integration');
  assert.equal(url.username, 'usage_app');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-usage-postgres\.[A-Za-z0-9]+\/socket$/);
}

test('usage audit isolated PostgreSQL acceptance', async (t) => {
  guard();
  try {
    await ensureSiteSchema();
    const block = await createTopDashboardBlock({ title: 'Synthetic usage report', createdByAdminUserId: null, createdByManagerId: null });
    const key = `top:${block.id}`;
    const input = { name: 'Synthetic viewer', login: `usage-${randomUUID()}`, email: '', role: 'purchaser' as const,
      passwordHash: 'synthetic-test-hash-not-a-credential', isActive: true, canManageTopDashboard: false, dashboardAccess: [key] };
    const user = await createAccessUser(input);
    const user2 = await createAccessUser({ ...input, login: `usage-${randomUUID()}`, name: 'Other synthetic viewer' });
    const stored = await createStoredAdminSession({ role: 'purchaser', adminUserId: user.numericId });
    const stored2 = await createStoredAdminSession({ role: 'purchaser', adminUserId: user2.numericId });
    const viewer = (await getStoredAdminSession(stored.token))!;
    const viewer2 = (await getStoredAdminSession(stored2.token))!;
    const actorKey = dashboardUsageActorKey(viewer);
    const batch = { dashboardKey: key, preview: false, versionId: 66, events: [{ id: randomUUID(), action: 'report_open' as const }] };

    await t.test('retry deduplication is actor-scoped and stores server timestamps, not client identity', async () => {
      const started = Date.now();
      await recordDashboardUsage(viewer, batch);
      await recordDashboardUsage(viewer, batch);
      await recordDashboardUsage(viewer2, batch);
      const result = await listDashboardUsage({ dashboardKey: key });
      assert.equal(result.events.length, 2);
      assert.equal(new Set(result.events.map((event) => event.actorKey)).size, 2);
      const row = result.events.find((event) => event.actorKey === actorKey)!;
      assert.equal(row.actorName, input.name);
      assert.equal(row.dashboardTitle, block.title);
      assert.equal(row.preview, false);
      assert.equal(row.versionId, 66);
      assert.ok(new Date(row.createdAt).getTime() >= started - 1000);
      assert.ok(new Date(row.createdAt).getTime() <= Date.now() + 1000);
    });

    await t.test('revoked access and viewer-only preview never write events', async () => {
      await assert.rejects(recordDashboardUsage(viewer, { ...batch, preview: true }), /Нет доступа/);
      await assert.rejects(recordDashboardUsage({ ...viewer, sessionId: undefined }, batch), /Нет доступа/);
      await updateAccessUser(user.id, { ...input, passwordHash: undefined, dashboardAccess: [] });
      const revoked = (await getStoredAdminSession(stored.token))!;
      await assert.rejects(recordDashboardUsage(revoked, { ...batch, events: [{ id: randomUUID(), action: 'filter_changed' }] }), /Нет доступа/);
      assert.equal((await listDashboardUsage({ actorKey })).events.length, 1);
      await updateAccessUser(user.id, { ...input, passwordHash: undefined });
    });

    await t.test('pagination is bounded, ordered and stable; filters work across pages', async () => {
      const refreshed = (await getStoredAdminSession(stored.token))!;
      for (let count = 0; count < 3; count++) {
        await recordDashboardUsage(refreshed, { ...batch, events: Array.from({ length: 20 }, () => ({ id: randomUUID(), action: 'filter_changed' as const })) });
      }
      const first = await listDashboardUsage({ actorKey, dashboardKey: key });
      assert.equal(first.events.length, 50);
      assert.ok(first.nextCursor);
      const second = await listDashboardUsage({ actorKey, dashboardKey: key, before: first.nextCursor! });
      assert.equal(second.events.length, 11);
      assert.equal(second.nextCursor, null);
      const all = [...first.events, ...second.events];
      assert.equal(new Set(all.map((event) => event.id)).size, 61);
      assert.ok(all.every((event, index) => index === 0 || BigInt(all[index - 1].id) > BigInt(event.id)));
      const opens = await listDashboardUsage({ actorKey, action: 'report_open' });
      assert.equal(opens.events.length, 1);
    });

    await t.test('database-backed action limit is per actor and returns retryable HTTP 429', async () => {
      const action = `usage-test-${randomUUID()}`;
      assert.equal(await enforceAdminActionRateLimit(viewer, action, 2, 60_000), null);
      assert.equal(await enforceAdminActionRateLimit(viewer, action, 2, 60_000), null);
      const rejected = await enforceAdminActionRateLimit(viewer, action, 2, 60_000);
      assert.equal(rejected?.status, 429);
      assert.ok(Number(rejected?.headers.get('Retry-After')) > 0);
      assert.equal(await enforceAdminActionRateLimit(viewer2, action, 2, 60_000), null);
      assert.ok(Number((await query('select max(count) as count from rate_limit_buckets')).rows[0].count) >= 3);
    });

    await t.test('deleting employee or report does not erase audit history', async () => {
      await query('delete from admin_users where id=$1', [user.numericId]);
      await query('delete from top_dashboard_blocks where id=$1', [block.id]);
      const result = await listDashboardUsage({ actorKey, action: 'report_open' });
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].actorName, actorKey);
      assert.equal(result.events[0].dashboardKey, key);
      assert.equal(result.events[0].dashboardTitle, key);
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
