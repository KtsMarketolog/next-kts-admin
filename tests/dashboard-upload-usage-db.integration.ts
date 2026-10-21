/** Synthetic local cluster only; appended to scripts/test-dashboard-usage-postgres.sh. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { query, withTransaction } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { enqueueDashboardUploadUsage, drainDashboardUploadUsageOutbox, DASHBOARD_UPLOAD_USAGE_DRAIN_BATCH } from '../src/shared/lib/db/dashboardUploadUsageOutboxRepo';
import { createTopDashboardBlock, createTopDashboardBlockVersion } from '../src/shared/lib/db/topDashboardBlocksRepo';

function guard() {
  assert.equal(process.env.KTS_USAGE_TEST, '1'); assert.equal(process.env.NODE_ENV, 'test');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_usage_integration'); assert.equal(url.username, 'usage_app'); assert.equal(url.password, '');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['host', 'port']);
  assert.equal(url.searchParams.get('port'), '55479');
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-usage-postgres\.[A-Za-z0-9]+\/socket$/);
}
const actor = {actorKey: 'admin:999999', actorRole: 'admintop' as const};
const input = (resourceKey: string) => ({dashboardKey: 'top:999999',versionId: 87,resourceKey,name:'synthetic.html',size:123,type:'html' as const});
const eventId = (resource: string) => `upload_${createHash('sha256').update(resource).digest('hex')}`;
async function counts(resource: string) {
  return (await query<{resources: number; pending: number; events: number; details: number}>(`select
    (select count(*)::integer from upload_usage_test_resources where resource=$1) as resources,
    (select count(*)::integer from dashboard_upload_usage_outbox where actor_key=$2 and event_id=$3) as pending,
    (select count(*)::integer from dashboard_usage_events where actor_key=$2 and event_id=$3) as events,
    (select count(*)::integer from dashboard_usage_event_details d join dashboard_usage_events e on e.id=d.usage_event_id where e.actor_key=$2 and e.event_id=$3) as details`,
  [resource,actor.actorKey,eventId(resource)])).rows[0];
}
async function save(resource: string) {
  await withTransaction(async client => {
    await client.query('insert into upload_usage_test_resources(resource) values($1)', [resource]);
    await enqueueDashboardUploadUsage(client, actor, input(resource));
  });
}

test('upload intents survive process/journal gaps and commit atomically with their saved resources', {timeout: 30_000}, async t => {
  guard();
  try {
    await ensureSiteSchema();
    await query('create table upload_usage_test_resources(resource text primary key)');
    await t.test('resource and intent both roll back on any failed save, including intent validation', async () => {
      for (const invalid of [false,true]) {
        const resource = randomUUID();
        await assert.rejects(withTransaction(async client => {
          await client.query('insert into upload_usage_test_resources(resource) values($1)', [resource]);
          await enqueueDashboardUploadUsage(client, actor, {...input(resource),size:invalid ? -1 : 123});
          throw Error('Synthetic save failed after intent');
        }));
        assert.deepEqual(await counts(resource), {resources:0,pending:0,events:0,details:0});
      }
    });
    await t.test('committed upload waits durably through journal outage; retry keeps original actor and source time', async () => {
      const resource = randomUUID(); await save(resource);
      const capturedAt = new Date(Date.now() - 60_000).toISOString();
      await query('update dashboard_upload_usage_outbox set captured_at=$2 where event_id=$1', [eventId(resource),capturedAt]);
      assert.deepEqual(await counts(resource), {resources:1,pending:1,events:0,details:0});
      await query(`create function reject_synthetic_usage_detail() returns trigger language plpgsql as $$ begin raise exception 'Synthetic journal outage'; end $$;
        create trigger reject_synthetic_usage_detail before insert on dashboard_usage_event_details for each row execute function reject_synthetic_usage_detail()`);
      await assert.rejects(drainDashboardUploadUsageOutbox(), /Synthetic journal outage/);
      assert.deepEqual(await counts(resource), {resources:1,pending:1,events:0,details:0});
      await query('drop trigger reject_synthetic_usage_detail on dashboard_usage_event_details; drop function reject_synthetic_usage_detail()');
      assert.equal(await drainDashboardUploadUsageOutbox(), 1);
      assert.deepEqual(await counts(resource), {resources:1,pending:0,events:1,details:1});
      const event = (await query(`select actor_key,actor_role,captured_at,captured_source,created_at from dashboard_usage_events where event_id=$1`, [eventId(resource)])).rows[0];
      assert.equal(event.actor_key, actor.actorKey); assert.equal(event.actor_role, 'admintop');
      assert.equal(event.captured_source,'server'); assert.equal(event.captured_at.toISOString(),capturedAt);
      assert.ok(event.created_at.getTime() > event.captured_at.getTime());
      // An account need not still exist or retain access when a historical server intent is drained.
      assert.equal((await query('select count(*)::integer as count from admin_users where id=999999')).rows[0].count,0);
      // Replay after a lost drain ACK must not create another event or replace its timestamp.
      await withTransaction(client => enqueueDashboardUploadUsage(client, actor, input(resource)));
      assert.equal(await drainDashboardUploadUsageOutbox(),1);
      assert.deepEqual(await counts(resource), {resources:1,pending:0,events:1,details:1});
    });
    await t.test('concurrent drains use bounded batches and never double-count the same intent', async () => {
      const resources = Array.from({length:121},() => randomUUID());
      for (const resource of resources) await save(resource);
      const delivered = await Promise.all(Array.from({length:4},() => drainDashboardUploadUsageOutbox()));
      assert.equal(delivered.reduce((a,b)=>a+b,0),121);
      assert.ok(delivered.every(count => count <= DASHBOARD_UPLOAD_USAGE_DRAIN_BATCH));
      for (const resource of resources) assert.deepEqual(await counts(resource),{resources:1,pending:0,events:1,details:1});
    });
    await t.test('actual TOP HTML repository commits the audit intent with its new version', async () => {
      const block = await createTopDashboardBlock({title:'Synthetic outbox block',createdByAdminUserId:null,createdByManagerId:null});
      const htmlContent = '<!doctype html><title>Synthetic outbox</title>';
      const result = await createTopDashboardBlockVersion({blockId:block.id,htmlContent,originalName:'synthetic.html',fileSize:Buffer.byteLength(htmlContent),
        sha256:createHash('sha256').update(htmlContent).digest('hex'),uploadedByAdminUserId:null,uploadedByManagerId:null,usageActor:actor});
      const resource = `top-html:${block.id}:${result.version.id}`;
      assert.equal((await counts(resource)).pending,1);
      await query('delete from top_dashboard_block_versions where id=$1',[result.version.id]);
      assert.equal(await drainDashboardUploadUsageOutbox(),1,'source retention does not erase the independent audit intent');
      assert.equal((await counts(resource)).events,1);
    });
    await t.test('a preexisting conflicting event is never acknowledged as a successful server upload', async () => {
      const resource = randomUUID(); await save(resource);
      await query(`insert into dashboard_usage_events(actor_key,actor_role,dashboard_key,event_id,action) values($1,'admintop','top:999999',$2,'report_open')`,[actor.actorKey,eventId(resource)]);
      assert.equal(await drainDashboardUploadUsageOutbox(),0);
      assert.deepEqual(await counts(resource),{resources:1,pending:1,events:1,details:0});
      await query('delete from dashboard_usage_events where actor_key=$1 and event_id=$2',[actor.actorKey,eventId(resource)]);
      assert.equal(await drainDashboardUploadUsageOutbox(),1);
    });
  } finally { await globalThis.__ktsPgPool?.end(); }
});
