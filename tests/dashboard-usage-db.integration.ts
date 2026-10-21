/** Synthetic data only; run with scripts/test-dashboard-usage-postgres.sh. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { enforceAdminActionRateLimit } from '../src/shared/lib/adminSecurity';
import { createAccessUser, updateAccessUser } from '../src/shared/lib/db/adminUsersRepo';
import { createStoredAdminSession, getStoredAdminSession } from '../src/shared/lib/db/adminSessionsRepo';
import { query, withTransaction } from '../src/shared/lib/db/client';
import { DASHBOARD_USAGE_RETENTION_CUTOFF_SQL, dashboardUsageActorKey, exportDashboardUsage, listDashboardUsageActors, listDashboardUsage, listDashboardUsageEmployees, listDashboardUsageEmployeeReports, recordDashboardUsage, pruneExpiredDashboardUsage } from '../src/shared/lib/db/dashboardUsageRepo';
import { dashboardUsageDateBounds, DashboardUsageExportLimitError } from '../src/shared/lib/dashboardUsageFilters';
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
      const capturedAt = new Date(started - 86_400_000).toISOString();
      await recordDashboardUsage(viewer, { ...batch, events: [{ ...batch.events[0], capturedAt }] });
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
      assert.equal(row.capturedAt, capturedAt, 'An ACK retry cannot overwrite the original browser timestamp');
      assert.equal(row.capturedSource, 'browser');
      assert.equal(result.events.find(event => event.actorKey !== actorKey)!.capturedAt, null, 'Legacy events retain an unknown source time');
    });

    await t.test('revoked access and viewer-only preview never write events', async () => {
      await assert.rejects(recordDashboardUsage(viewer, { ...batch, preview: true }), /Нет доступа/);
      await assert.rejects(recordDashboardUsage({ ...viewer, sessionId: undefined }, batch), /Нет доступа/);
      const changed = await updateAccessUser(user.id, { ...input, passwordHash: undefined, dashboardAccess: [], expectedRevision: user.revision });
      assert.equal(await getStoredAdminSession(stored.token), null, 'Changing access revokes the old login session');
      const deniedLogin = await createStoredAdminSession({ role: 'purchaser', adminUserId: user.numericId });
      const revoked = (await getStoredAdminSession(deniedLogin.token))!;
      await assert.rejects(recordDashboardUsage(revoked, { ...batch, events: [{ id: randomUUID(), action: 'filter_changed' }] }), /Нет доступа/);
      assert.equal((await listDashboardUsage({ actorKey })).events.length, 1);
      await updateAccessUser(user.id, { ...input, passwordHash: undefined, expectedRevision: changed!.user.revision });
    });

    await t.test('pagination is bounded, ordered and stable; filters work across pages', async () => {
      const login = await createStoredAdminSession({ role: 'purchaser', adminUserId: user.numericId });
      const refreshed = (await getStoredAdminSession(login.token))!;
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

    await t.test('employee summary and per-report details retain safe file metadata, deduplicate viewing windows and include never-used employees', async () => {
      const secondBlock = await createTopDashboardBlock({ title: 'Synthetic second visible report', createdByAdminUserId: null, createdByManagerId: null });
      const secondKey = `top:${secondBlock.id}`;
      const user = await createAccessUser({ ...input, name: 'Summary actor', login: `usage-summary-${randomUUID()}`, dashboardAccess: [key, secondKey] });
      const never = await createAccessUser({ ...input, name: 'Summary never used', login: `usage-never-${randomUUID()}` });
      const disabled = await createAccessUser({ ...input, name: 'Summary disabled', login: `usage-disabled-${randomUUID()}`, isActive: false });
      const manager = await createAccessUser({ ...input, name: 'Summary manager never used', login: `usage-manager-${randomUUID()}`, role: 'manager' });
      const stored = await createStoredAdminSession({ role: 'purchaser', adminUserId: user.numericId });
      const session = (await getStoredAdminSession(stored.token))!;
      const actor = dashboardUsageActorKey(session);
      const windowId = randomUUID();
      const events = [
        { id: randomUUID(), action: 'report_open' as const },
        { id: randomUUID(), action: 'data_loaded' as const },
        { id: randomUUID(), action: 'data_loaded' as const, upload: { name: 'Счёт-синтетика.xlsx', size: 1234 } },
        { id: randomUUID(), action: 'file_uploaded' as const, upload: { name: 'Синтетический-отчёт.html', size: 2048 }, uploadType: 'html' as const },
        { id: randomUUID(), action: 'viewing_time' as const, durationSeconds: 20, viewingWindowId: windowId },
        { id: randomUUID(), action: 'viewing_time' as const, durationSeconds: 15, viewingWindowId: randomUUID() },
      ];
      await recordDashboardUsage(session, { ...batch, events });
      await recordDashboardUsage(session, { ...batch, events });
      await recordDashboardUsage(session, { ...batch, dashboardKey: secondKey, events: [
        { id: randomUUID(), action: 'viewing_time', durationSeconds: 20, viewingWindowId: windowId },
      ] });
      // Expired and preview records must never inflate summary duration/interaction.
      await query(`insert into dashboard_usage_events(actor_key,actor_role,dashboard_key,event_id,action,is_preview,created_at)
        values ($1,'purchaser',$2,$3,'filter_changed',true,now()),
          ($1,'purchaser',$2,$4,'filter_changed',false,now()-interval '2 months')`, [actor, key, randomUUID(), randomUUID()]);
      const summary = await listDashboardUsageEmployees({ search: 'Summary' });
      const entry = summary.employees.find((row) => row.actorKey === actor)!;
      assert.equal(entry.viewingSeconds, 35, 'paired reports share one viewing window, not 55 seconds');
      assert.equal(entry.uploadCount, 2);
      assert.equal(entry.interactionCount, 2, 'automatic data loads and time pulses are not user actions');
      assert.equal(entry.reportCount, 2);
      assert.ok(entry.lastOpenedAt && entry.lastUsedAt && entry.lastInteractionAt);
      assert.equal(summary.employees.find((row) => row.actorKey === `admin:${never.numericId}`)?.lastUsedAt, null);
      assert.equal(summary.employees.find((row) => row.actorKey === `manager:${manager.numericId}`)?.viewingSeconds, 0);
      assert.equal(summary.employees.some((row) => row.actorKey === `admin:${disabled.numericId}`), false);
      const reports = await listDashboardUsageEmployeeReports({ actorKey: actor });
      assert.equal(reports.reports.find((row) => row.dashboardKey === key)?.viewingSeconds, 35);
      assert.equal(reports.reports.find((row) => row.dashboardKey === secondKey)?.viewingSeconds, 20);
      const ordinary = await listDashboardUsage({ actorKey: actor });
      assert.equal(ordinary.events.length, 4, 'default history excludes time pulses, preview and expiry');
      assert.equal(ordinary.events.find((row) => row.action === 'file_uploaded')?.upload?.name, 'Синтетический-отчёт.html');
      assert.equal((await listDashboardUsage({ actorKey: actor, includePreview: true })).events.length, 5);
      assert.equal((await listDashboardUsage({ actorKey: actor, action: 'viewing_time' })).events.length, 3);
      const eventId = (await query('select id from dashboard_usage_events where actor_key=$1 and event_id=$2', [actor, events[2].id])).rows[0].id;
      assert.equal((await query('select count(*)::int as n from dashboard_usage_event_details where usage_event_id=$1', [eventId])).rows[0].n, 1);
      await query('delete from dashboard_usage_events where id=$1', [eventId]);
      assert.equal((await query('select count(*)::int as n from dashboard_usage_event_details where usage_event_id=$1', [eventId])).rows[0].n, 0);
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

    await t.test('Moscow day boundaries, exact actors, historical picker and whole-result export agree with paginated reads', async () => {
      const account = await createAccessUser({ ...input, name: 'Same synthetic name', login: `usage-range-${randomUUID()}` });
      const other = await createAccessUser({ ...input, name: 'Same synthetic name', login: `usage-range-other-${randomUUID()}` });
      const actor = `admin:${account.numericId}`, otherActor = `admin:${other.numericId}`;
      // Yesterday in Moscow: always within retention, regardless of the runner timezone/date.
      const day = new Date(Date.now() + 3 * 3600_000 - 86_400_000).toISOString().slice(0, 10);
      const bounds = dashboardUsageDateBounds({ from: day, to: day });
      await query(`insert into dashboard_usage_events(actor_key,actor_role,dashboard_key,event_id,action,created_at)
        select $1,'purchaser',$2,'range-event-'||lpad(i::text,8,'0'),'filter_changed',
          $3::timestamptz + (i-1)*interval '1 millisecond' from generate_series(1,55) i`, [actor, key, bounds.fromInclusive]);
      await query(`insert into dashboard_usage_events(actor_key,actor_role,dashboard_key,event_id,action,created_at,is_preview) values
        ($1,'purchaser',$3,'range-end-inclusive','report_open',$5::timestamptz-interval '1 millisecond',false),
        ($1,'purchaser',$3,'range-before-day','report_open',$4::timestamptz-interval '1 millisecond',false),
        ($1,'purchaser',$3,'range-next-midnight','report_open',$5::timestamptz,false),
        ($1,'purchaser',$3,'range-preview-day','report_open',$4::timestamptz,true),
        ($2,'purchaser',$3,'range-other-actor','report_open',$4::timestamptz,false)`, [actor, otherActor, key, bounds.fromInclusive, bounds.toExclusive]);
      const filter = { from: day, to: day, actorKey: actor, dashboardKey: key };
      const first = await listDashboardUsage(filter), second = await listDashboardUsage({ ...filter, before: first.nextCursor! });
      assert.equal(first.events.length, 50); assert.equal(second.events.length, 6); assert.equal(second.nextCursor, null);
      const full = await exportDashboardUsage('events', filter); assert.equal(full.view, 'events');
      assert.equal(full.rows.length, 56);
      assert.deepEqual(full.rows.map(row => (row as { id: string }).id), [...first.events, ...second.events].map(row => row.id));
      assert.equal(new Set(full.rows.map(row => row.actorKey)).size, 1);
      assert.equal((await exportDashboardUsage('events', { ...filter, includePreview: true })).rows.length, 57);
      const summary = await listDashboardUsageEmployees({ from: day, to: day, actorKey: actor });
      assert.equal(summary.employees.length, 1); assert.equal(summary.employees[0].interactionCount, 55); assert.equal(summary.employees[0].reportCount, 1);
      assert.equal(summary.employees[0].lastOpenedAt, new Date(new Date(bounds.toExclusive!).getTime() - 1).toISOString());
      const reports = await listDashboardUsageEmployeeReports({ actorKey: actor, from: day, to: day });
      assert.equal(reports.reports.length, 1); assert.equal(reports.reports[0].openCount, 1); assert.equal(reports.reports[0].interactionCount, 55);
      const summaryExport = await exportDashboardUsage('employees', { actorKey: actor, from: day, to: day });
      assert.deepEqual(summaryExport.rows, summary.employees);
      assert.equal((await listDashboardUsageEmployees({ from: day, to: day, actorKey: otherActor })).employees[0].interactionCount, 0);
      await query('update admin_users set is_active=false where id=$1', [account.numericId]);
      const options = await listDashboardUsageActors({ search: 'Same synthetic name' });
      assert.equal(options.actors.filter(row => [actor, otherActor].includes(row.actorKey)).length, 2);
      assert.deepEqual(Object.keys(options.actors[0]).sort(), ['actorKey', 'actorName', 'actorRole']);
      assert.equal((await listDashboardUsageEmployees({ actorKey: actor, from: day, to: day })).employees[0].interactionCount, 55, 'explicit disabled actor remains inspectable');
      assert.equal((await listDashboardUsageEmployees({ search: 'Same synthetic name' })).employees.some(row => row.actorKey === actor), false, 'default roster remains active only');
      await query('delete from admin_users where id=$1', [account.numericId]);
      assert.equal((await listDashboardUsageActors({ search: actor })).actors.find(row => row.actorKey === actor)?.actorName, actor);
      assert.equal((await listDashboardUsageEmployees({ actorKey: actor, from: day, to: day })).employees[0].interactionCount, 55);
      assert.equal((await listDashboardUsage({ actorKey: actor, from: '1970-01-01', to: '1970-01-02' })).events.length, 0, 'date filters never extend retained history');
      // The SQL read itself detects the extra row; the workbook builder is never asked to truncate.
      await query(`insert into dashboard_usage_events(actor_key,actor_role,dashboard_key,event_id,action,created_at)
        select 'admin:888888','admin',$1,'export-limit-'||lpad(i::text,8,'0'),'report_open',now() from generate_series(1,5001) i`, [key]);
      await assert.rejects(exportDashboardUsage('events', { actorKey: 'admin:888888' }), DashboardUsageExportLimitError);
      await query("delete from dashboard_usage_events where actor_key='admin:888888' and event_id='export-limit-00005001'");
      assert.equal((await exportDashboardUsage('events', { actorKey: 'admin:888888' })).rows.length, 5000);
    });

    await t.test('locked metadata storage fails within its bounded timeout and rolls back the whole usage write', async () => {
      const id = randomUUID();
      const started = Date.now();
      await withTransaction(async (client) => {
        await client.query('lock table dashboard_usage_event_details in access exclusive mode');
        await assert.rejects(recordDashboardUsage(viewer2, { ...batch, events: [
          { id, action: 'data_loaded', upload: { name: 'Synthetic.xlsx', size: 10 } },
        ] }), /lock timeout/);
      });
      assert.ok(Date.now() - started < 5000);
      assert.equal((await query('select count(*)::int as n from dashboard_usage_events where event_id=$1', [id])).rows[0].n, 0);
    });

    await t.test('database metadata constraints reject partial nullable, path and oversized values', async () => {
      const id = (await query(`insert into dashboard_usage_events(actor_key,actor_role,dashboard_key,event_id,action)
        values ($1,'purchaser',$2,$3,'data_loaded') returning id`, [dashboardUsageActorKey(viewer2), key, randomUUID()])).rows[0].id;
      await assert.rejects(query('insert into dashboard_usage_event_details(usage_event_id) values($1)', [id]), /check constraint/);
      await assert.rejects(query('insert into dashboard_usage_event_details(usage_event_id,upload_name) values($1,$2)', [id, 'partial.xlsx']), /check constraint/);
      await assert.rejects(query('insert into dashboard_usage_event_details(usage_event_id,upload_name,upload_size) values($1,$2,$3)', [id, '../path.xlsx', 10]), /check constraint/);
      await assert.rejects(query('insert into dashboard_usage_event_details(usage_event_id,duration_seconds,viewing_window_id) values($1,61,$2)', [id, randomUUID()]), /check constraint/);
      await query('delete from dashboard_usage_events where id=$1', [id]);
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

    await t.test('retention uses a Moscow calendar month, hides expiry immediately and physically prunes in bounded batches', async () => {
      const actor = 'admin:999999';
      await query(`insert into dashboard_usage_events(actor_key,actor_role,dashboard_key,event_id,action,created_at)
        select $1,'admin','currency-rates','expired-event-'||lpad(i::text,8,'0'),'report_open',
          (${DASHBOARD_USAGE_RETENTION_CUTOFF_SQL})-interval '1 minute' from generate_series(1,10005) as i`, [actor]);
      await query(`insert into dashboard_usage_events(actor_key,actor_role,dashboard_key,event_id,action,created_at)
        values ($1,'admin','currency-rates','current-event-retained','report_open',now()),
          ($1,'admin','currency-rates','boundary-event-retained','report_open',(${DASHBOARD_USAGE_RETENTION_CUTOFF_SQL})+interval '1 minute')`, [actor]);
      assert.equal((await listDashboardUsage({ actorKey: actor })).events.length, 2, 'Expired rows are hidden even before the scheduler runs');
      const unrelatedBefore = (await query('select count(*)::int as total from dashboard_usage_events where actor_key<>$1', [actor])).rows[0].total;
      const unrelatedExpiredBefore = (await query(`select count(*)::int as total from dashboard_usage_events
        where actor_key<>$1 and created_at < (${DASHBOARD_USAGE_RETENTION_CUTOFF_SQL})`, [actor])).rows[0].total;
      await withTransaction(async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', ['kts:dashboard-usage-retention']);
        const blocked = await pruneExpiredDashboardUsage();
        assert.equal(blocked.skipped, 'running');
        assert.equal(blocked.deleted, 0);
      });
      const first = await pruneExpiredDashboardUsage();
      assert.equal(first.deleted, 10000);
      assert.equal(first.remaining, true);
      assert.equal(first.skipped, null);
      const second = await pruneExpiredDashboardUsage();
      assert.equal(second.deleted, 5 + unrelatedExpiredBefore);
      assert.equal(second.remaining, false);
      assert.equal((await pruneExpiredDashboardUsage()).deleted, 0);
      assert.equal((await query('select count(*)::int as total from dashboard_usage_events where actor_key=$1', [actor])).rows[0].total, 2);
      assert.equal((await query('select count(*)::int as total from dashboard_usage_events where actor_key<>$1', [actor])).rows[0].total, unrelatedBefore - unrelatedExpiredBefore);
      const calendar = await query(`select ((timestamptz '2026-03-31T20:00:00Z' at time zone 'Europe/Moscow')-interval '1 month') at time zone 'Europe/Moscow' as cutoff`);
      assert.equal(new Date(calendar.rows[0].cutoff).toISOString(), '2026-02-28T20:00:00.000Z');
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
