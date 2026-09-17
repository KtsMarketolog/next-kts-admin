/** Run only through scripts/test-top-dashboard-postgres.sh (private local Unix socket). */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { query, withTransaction } from '../src/shared/lib/db/client';
import { applyTopDashboardDataContextStateMigration } from '../src/shared/lib/db/migrations';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import {
  activateTopDashboardBlockDataVersion,
  activateTopDashboardBlockVersion,
  createAndActivateTopDashboardBlockDataVersion,
  createTopDashboardBlock,
  createTopDashboardBlockVersion,
  deleteTopDashboardBlock,
  deleteTopDashboardBlockVersion,
  getActiveTopDashboardBlockDataContent,
  getTopDashboardBlockOverview,
  pruneTopDashboardBlockHistory,
  TopDashboardDraftLimitError,
  TopDashboardDataStorageLimitError,
} from '../src/shared/lib/db/topDashboardBlocksRepo';
import { TOP_DASHBOARD_DATA_STORED_MAX_BYTES } from '../src/shared/lib/topDashboardLimits';
import {
  TopDashboardBlockDataStateConflictError,
  TopDashboardDataCompatibilityError,
  TopDashboardStateConflictError,
  type TopDashboardProfile,
  type TopDashboardSnapshotFormat,
} from '../src/shared/lib/db/topDashboardDomain';

function guard() {
  assert.equal(process.env.KTS_TOP_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_top_integration');
  assert.equal(url.username, 'top_app');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-top-postgres\.[A-Za-z0-9]+\/socket$/);
}

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const actor = { adminUserId: null, managerId: null };
const uploader = { uploadedByAdminUserId: null, uploadedByManagerId: null };
const contracts = {
  generic: { format: 'multi-file-v1', profile: 'generic', html: '<input id="files" type="file">' },
  native: { format: 'kts-bundle-v1', profile: 'sales-analytics', html: '<script>const DASH_NAME="аналитика_продаж"; const data={format:"kts-bundle",version:1};</script>' },
  purchases: { format: 'purchases-v1', profile: 'purchases', html: '<title>Управление закупками</title><input id="snapInp" type="file"><script>PARSERS.purchases=function(){};</script>' },
} satisfies Record<string, { format: TopDashboardSnapshotFormat; profile: TopDashboardProfile; html: string }>;
type Kind = keyof typeof contracts;
const block = () => createTopDashboardBlock({ title: `Synthetic ${randomUUID()}`, createdByAdminUserId: null, createdByManagerId: null });
async function html(blockId: number, label: string, kind: Kind = 'generic') {
  const htmlContent = `<!doctype html><html><body>${label}${contracts[kind].html}</body></html>`;
  return (await createTopDashboardBlockVersion({ blockId, originalName: `${label}.html`, htmlContent,
    fileSize: Buffer.byteLength(htmlContent), sha256: hash(htmlContent), ...uploader })).version.id;
}
const publish = (blockId: number, versionId: number, expectedActiveVersionId: number | null, kind: Kind = 'generic') => activateTopDashboardBlockVersion({
  blockId, versionId, expectedActiveVersionId, expectedSnapshotFormat: contracts[kind].format,
  expectedProfile: contracts[kind].profile, ...actor,
});
function dataInput(blockId: number, htmlId: number, previous: number | null, label: string, kind: Kind = 'generic', file = false) {
  const content = Buffer.from(label);
  return { blockId, expectedActiveHtmlVersionId: htmlId, expectedActiveVersionId: previous,
    expectedHtmlSnapshotFormat: contracts[kind].format, expectedHtmlProfile: contracts[kind].profile,
    originalName: `${label}.bin`, content: file ? null : content,
    storagePath: file ? `${hash(content).slice(0, 2)}/${hash(content)}-${randomUUID()}.bin` : null,
    fileSize: content.length, uncompressedSize: content.length, sha256: hash(content),
    snapshotFormat: contracts[kind].format, dashboardProfile: contracts[kind].profile,
    boundHtmlVersionId: kind === 'generic' ? htmlId : null, ...uploader };
}
const data = (blockId: number, htmlId: number, previous: number | null, label: string, kind: Kind = 'generic', file = false) => createAndActivateTopDashboardBlockDataVersion(dataInput(blockId, htmlId, previous, label, kind, file));
const rollbackData = (blockId: number, htmlId: number, versionId: number, previous: number, kind: Kind = 'generic') => activateTopDashboardBlockDataVersion({
  blockId, expectedActiveHtmlVersionId: htmlId, versionId, expectedActiveVersionId: previous,
  expectedHtmlSnapshotFormat: contracts[kind].format, expectedHtmlProfile: contracts[kind].profile, ...actor,
});
async function dataIds(blockId: number) {
  return (await getTopDashboardBlockOverview(blockId)).data.versions.map((version) => version.id).sort((a, b) => a - b);
}
async function queuedPaths() {
  return (await query<{ storage_path: string }>(`select storage_path from dashboard_file_cleanup_queue order by storage_path`)).rows.map((row) => row.storage_path);
}
async function legacyData(blockId: number, htmlId: number, label: string, file = false) {
  const content = Buffer.from(label);
  const storagePath = file ? `${hash(content).slice(0, 2)}/${hash(content)}-${randomUUID()}.bin` : null;
  const result = await query<{ id: string }>(`insert into top_dashboard_block_data_versions
    (block_id,original_name,compressed_payload,file_size,uncompressed_size,sha256,snapshot_format,dashboard_profile,bound_html_version_id,storage_path)
    values ($1,$2,$3,$4,$4,$5,'multi-file-v1','generic',$6,$7) returning id::text`,
  [blockId, label, file ? null : content, content.length, hash(content), htmlId, storagePath]);
  return Number(result.rows[0].id);
}

async function maintenanceSnapshot(blockId: number) {
  return (await query<{ snapshot: {
    block: unknown;
    htmlState: unknown;
    dataState: unknown;
    html: unknown[];
    data: unknown[];
    contexts: unknown[];
  } }>(`select jsonb_build_object(
    'block', (select to_jsonb(blocks) from top_dashboard_blocks blocks where id=$1),
    'htmlState', (select to_jsonb(state) from top_dashboard_block_state state where block_id=$1),
    'dataState', (select to_jsonb(state) from top_dashboard_block_data_state state where block_id=$1),
    'html', (select coalesce(jsonb_agg(to_jsonb(versions) order by id), '[]'::jsonb)
      from top_dashboard_block_versions versions where block_id=$1),
    'data', (select coalesce(jsonb_agg(to_jsonb(versions) order by id), '[]'::jsonb)
      from top_dashboard_block_data_versions versions where block_id=$1),
    'contexts', (select coalesce(jsonb_agg(to_jsonb(contexts) order by context_key), '[]'::jsonb)
      from top_dashboard_block_data_context_state contexts where block_id=$1)
  ) as snapshot`, [blockId])).rows[0].snapshot;
}

test('TOP retention isolated PostgreSQL acceptance', async (t) => {
  guard();
  try {
    assert.equal((await query(`select to_regclass('public.top_dashboard_blocks')::text as present`)).rows[0].present, null);
    await ensureSiteSchema();
    assert.equal((await query(`select count(*)::int as count from top_dashboard_block_data_context_state`)).rows[0].count, 0);

    await t.test('context migration is additive and preserves legacy history and unrelated prices', async () => {
      await withTransaction(async (client) => {
        await client.query(`
          create temp table top_dashboard_blocks (id bigint primary key) on commit drop;
          create temp table top_dashboard_block_versions (block_id bigint, id bigint, payload text, primary key(block_id,id)) on commit drop;
          create temp table top_dashboard_block_data_versions (block_id bigint, id bigint, payload text, primary key(block_id,id)) on commit drop;
          create temp table top_dashboard_block_state (active_version_id bigint, previous_version_id bigint) on commit drop;
          create temp table wholesale_price_lists (payload text) on commit drop;
          insert into top_dashboard_blocks values (1);
          insert into top_dashboard_block_versions values (1,1,'active'),(1,2,'previous'),(1,3,'archive'),(1,4,'draft');
          insert into top_dashboard_block_data_versions values (1,11,'active data'),(1,12,'previous data'),(1,13,'archive data');
          insert into top_dashboard_block_state values (1,2);
          insert into wholesale_price_lists values ('price sentinel unchanged');
          set local search_path=pg_temp,public;
        `);
        await applyTopDashboardDataContextStateMigration(client);
        assert.deepEqual((await client.query(`select payload from top_dashboard_block_versions order by id`)).rows.map((row) => row.payload), ['active','previous','archive','draft']);
        assert.deepEqual((await client.query(`select payload from top_dashboard_block_data_versions order by id`)).rows.map((row) => row.payload), ['active data','previous data','archive data']);
        assert.equal((await client.query(`select count(*)::int as count from top_dashboard_block_data_context_state`)).rows[0].count, 0);
        assert.equal((await client.query(`select count(*)::int as count from dashboard_file_cleanup_queue`)).rows[0].count, 0);
        assert.equal((await client.query(`select active_version_id::text as active, previous_version_id::text as previous from top_dashboard_block_state`)).rows[0].active, '1');
        assert.equal((await client.query(`select payload from wholesale_price_lists`)).rows[0].payload, 'price sentinel unchanged');
        await client.query(`drop table pg_temp.top_dashboard_block_data_context_state`);
        await client.query(`drop table pg_temp.dashboard_file_cleanup_queue`);
      });
    });

    await t.test('generic HTML retains its exact data rollback pair across switches and prunes the third publication', async () => {
      const { id } = await block();
      const a = await html(id, 'A');
      await publish(id, a, null);
      const a1 = await data(id, a, null, 'a1', 'generic', true);
      const a2 = await data(id, a, a1.activeVersionId, 'a2', 'generic', true);
      const a3 = await data(id, a, a2.activeVersionId, 'a3', 'generic', true);
      assert.deepEqual(a3.prunedVersionIds, [a1.activeVersionId]);
      assert.equal(a3.prunedStoragePaths.length, 1);
      assert.ok((await queuedPaths()).includes(a3.prunedStoragePaths[0]), 'pruned files are durably queued in the deleting transaction');
      await rollbackData(id, a, a2.activeVersionId, a3.activeVersionId);
      const b = await html(id, 'B');
      const draft = await html(id, 'keep this draft');
      await publish(id, b, a);
      let overview = await getTopDashboardBlockOverview(id);
      assert.equal(overview.data.activeVersionId, null);
      assert.deepEqual(await dataIds(id), [a2.activeVersionId, a3.activeVersionId]);
      const b1 = await data(id, b, null, 'b1', 'generic', true);
      const b2 = await data(id, b, b1.activeVersionId, 'b2', 'generic', true);
      const b3 = await data(id, b, b2.activeVersionId, 'b3', 'generic', true);
      assert.deepEqual(await dataIds(id), [a2.activeVersionId, a3.activeVersionId, b2.activeVersionId, b3.activeVersionId]);
      await publish(id, a, b);
      overview = await getTopDashboardBlockOverview(id);
      assert.equal(overview.data.activeVersionId, a2.activeVersionId, 'rollback choice survives newer upload timestamps');
      assert.equal(overview.data.previousVersionId, a3.activeVersionId);
      assert.equal((await getActiveTopDashboardBlockDataContent(id, a))?.id, a2.activeVersionId);
      assert.equal(await getActiveTopDashboardBlockDataContent(id, b), null);
      await publish(id, b, a);
      overview = await getTopDashboardBlockOverview(id);
      assert.equal(overview.data.activeVersionId, b3.activeVersionId);
      const c = await html(id, 'C');
      const published = await publish(id, c, b);
      assert.equal(published.prunedStoragePaths.length, 2);
      const afterPublicationQueue = await queuedPaths();
      assert.ok(published.prunedStoragePaths.every((file) => afterPublicationQueue.includes(file)));
      overview = await getTopDashboardBlockOverview(id);
      assert.deepEqual(overview.versions.map((v) => v.id).sort((x, y) => x - y), [b, draft, c]);
      assert.deepEqual(await dataIds(id), [b2.activeVersionId, b3.activeVersionId]);
      assert.equal(overview.previousVersionId, b);
      const deletedPrevious = await deleteTopDashboardBlockVersion({ blockId: id, versionId: b, ...actor });
      assert.equal(deletedPrevious.previousVersionId, null);
      assert.equal(deletedPrevious.deletedStoragePaths.length, 2);
      const afterManualDeletionQueue = await queuedPaths();
      assert.ok(deletedPrevious.deletedStoragePaths.every((file) => afterManualDeletionQueue.includes(file)));
      assert.deepEqual(await dataIds(id), []);
      assert.equal((await query(`select count(*)::int as count from top_dashboard_block_data_context_state where block_id=$1`, [id])).rows[0].count, 0);
      await deleteTopDashboardBlock(id);
    });

    await t.test('native JSON shares compatible HTML pairs and restores them after generic HTML', async () => {
      const { id } = await block();
      const a = await html(id, 'native-A', 'native');
      await publish(id, a, null, 'native');
      const d1 = await data(id, a, null, 'native-1', 'native');
      const d2 = await data(id, a, d1.activeVersionId, 'native-2', 'native');
      await rollbackData(id, a, d1.activeVersionId, d2.activeVersionId, 'native');
      const b = await html(id, 'native-B', 'native');
      await publish(id, b, a, 'native');
      assert.equal((await getTopDashboardBlockOverview(id)).data.activeVersionId, d1.activeVersionId);
      const incompatible = await html(id, 'purchases', 'purchases');
      await assert.rejects(publish(id, incompatible, b, 'purchases'), TopDashboardDataCompatibilityError);
      assert.deepEqual(await dataIds(id), [d1.activeVersionId, d2.activeVersionId]);
      const g = await html(id, 'generic');
      await publish(id, g, b);
      const g1 = await data(id, g, null, 'generic-data');
      assert.deepEqual(await dataIds(id), [d1.activeVersionId, d2.activeVersionId, g1.activeVersionId]);
      await publish(id, b, g, 'native');
      const restored = await getTopDashboardBlockOverview(id);
      assert.equal(restored.data.activeVersionId, d1.activeVersionId);
      assert.equal(restored.data.previousVersionId, d2.activeVersionId);
      const d3 = await data(id, b, d1.activeVersionId, 'native-3', 'native');
      assert.deepEqual(d3.prunedVersionIds, [d2.activeVersionId]);
      await assert.rejects(rollbackData(id, b, g1.activeVersionId, d3.activeVersionId, 'native'), TopDashboardDataCompatibilityError);
      await deleteTopDashboardBlock(id);
    });

    await t.test('legacy history changes only on successful scoped updates; no-ops and failures preserve it', async () => {
      const { id } = await block();
      const previous = await html(id, 'legacy-previous');
      const active = await html(id, 'legacy-active');
      const old = await html(id, 'legacy-old');
      const draft = await html(id, 'legacy-draft');
      await query(`update top_dashboard_block_versions set first_published_at=now() where block_id=$1 and id=any($2::bigint[])`, [id, [previous, active, old]]);
      await query(`update top_dashboard_block_state set active_version_id=$2, previous_version_id=$3 where block_id=$1`, [id, active, previous]);
      const a1 = await legacyData(id, active, 'legacy-a1');
      const a2 = await legacyData(id, active, 'legacy-a2');
      const a3 = await legacyData(id, active, 'legacy-a3');
      const p1 = await legacyData(id, previous, 'legacy-p1');
      const p2 = await legacyData(id, previous, 'legacy-p2');
      const p3 = await legacyData(id, previous, 'legacy-p3');
      const oldData = await legacyData(id, old, 'legacy-old-data');
      await query(`update top_dashboard_block_data_state set active_version_id=$2,previous_version_id=$3 where block_id=$1`, [id, a2, a3]);
      const original = await dataIds(id);
      assert.deepEqual(original, [a1, a2, a3, p1, p2, p3, oldData]);
      await ensureSiteSchema();
      await publish(id, active, active);
      await rollbackData(id, active, a2, a2);
      const duplicate = await data(id, active, a2, 'legacy-a2');
      assert.equal(duplicate.activeVersionId, a2);
      assert.deepEqual(duplicate.prunedVersionIds, []);
      const duplicateFile = dataInput(id, active, a2, 'legacy-a2', 'generic', true);
      const duplicateWithFile = await createAndActivateTopDashboardBlockDataVersion(duplicateFile);
      assert.deepEqual(duplicateWithFile.prunedStoragePaths, [duplicateFile.storagePath]);
      assert.ok((await queuedPaths()).includes(duplicateFile.storagePath!));
      await assert.rejects(data(id, active, a1, 'stale'), TopDashboardBlockDataStateConflictError);
      assert.deepEqual(await dataIds(id), original);
      assert.equal((await query(`select count(*)::int as count from top_dashboard_block_data_context_state where block_id=$1`, [id])).rows[0].count, 0);
      const next = await data(id, active, a2, 'legacy-next');
      assert.deepEqual(await dataIds(id), [a2, p2, p3, next.activeVersionId]);
      assert.ok((await getTopDashboardBlockOverview(id)).versions.some((v) => v.id === old), 'data upload does not prune HTML');
      await publish(id, previous, active);
      const overview = await getTopDashboardBlockOverview(id);
      assert.equal(overview.data.activeVersionId, p3, 'unknown historical context initializes from latest upload');
      assert.equal(overview.data.previousVersionId, p2);
      assert.deepEqual(overview.versions.map((v) => v.id).sort((x, y) => x - y), [previous, active, draft]);
      await deleteTopDashboardBlock(id);
    });

    await t.test('failed transaction restores versions and pointers after pruning', async () => {
      const { id } = await block();
      const h = await html(id, 'failure');
      await publish(id, h, null);
      const d1 = await data(id, h, null, 'failure-1', 'generic', true);
      const d2 = await data(id, h, d1.activeVersionId, 'failure-2', 'generic', true);
      const queuedBeforeFailure = await queuedPaths();
      await query(`create function top_retention_test_failure() returns trigger language plpgsql as $$
        begin if new.id = ${id} then raise exception 'synthetic post-prune failure'; end if; return new; end $$;
        create trigger top_retention_test_failure before update on top_dashboard_blocks
        for each row execute function top_retention_test_failure()`);
      try {
        await assert.rejects(data(id, h, d2.activeVersionId, 'failure-3'), /synthetic post-prune failure/);
        assert.deepEqual(await dataIds(id), [d1.activeVersionId, d2.activeVersionId]);
        assert.deepEqual(await queuedPaths(), queuedBeforeFailure, 'rollback also removes queued deletion intents');
        const state = await getTopDashboardBlockOverview(id);
        assert.equal(state.data.activeVersionId, d2.activeVersionId);
        assert.equal(state.data.previousVersionId, d1.activeVersionId);
      } finally {
        await query(`drop trigger top_retention_test_failure on top_dashboard_blocks; drop function top_retention_test_failure()`);
      }
      const deletedBlock = await deleteTopDashboardBlock(id);
      assert.equal(deletedBlock.deletedStoragePaths.length, 2);
      const afterBlockDeletionQueue = await queuedPaths();
      assert.ok(deletedBlock.deletedStoragePaths.every((file) => afterBlockDeletionQueue.includes(file)));
    });

    await t.test('maintenance previews roll back, preserve working legacy pairs and drafts, and apply only to the selected block', async () => {
      const { id } = await block();
      const previous = await html(id, 'maintenance-previous');
      const active = await html(id, 'maintenance-active');
      const old = await html(id, 'maintenance-old');
      const draft = await html(id, 'maintenance-draft');
      const secondDraft = await html(id, 'maintenance-second-draft');
      await query(`update top_dashboard_block_versions set first_published_at=now()
        where block_id=$1 and id=any($2::bigint[])`, [id, [previous, active, old]]);
      await query(`update top_dashboard_block_state set active_version_id=$2, previous_version_id=$3 where block_id=$1`, [id, active, previous]);
      const a1 = await legacyData(id, active, 'maintenance-a1', true);
      const a2 = await legacyData(id, active, 'maintenance-a2', true);
      const a3 = await legacyData(id, active, 'maintenance-a3', true);
      const a4 = await legacyData(id, active, 'maintenance-a4', true);
      const p1 = await legacyData(id, previous, 'maintenance-p1', true);
      const p2 = await legacyData(id, previous, 'maintenance-p2', true);
      const p3 = await legacyData(id, previous, 'maintenance-p3', true);
      const oldData = await legacyData(id, old, 'maintenance-old-data', true);
      const draftData = await legacyData(id, draft, 'maintenance-draft-data', true);
      await query(`update top_dashboard_block_data_state set active_version_id=$2,previous_version_id=$3 where block_id=$1`, [id, a2, a3]);
      const input = { blockId: id, expectedActiveHtmlVersionId: active, expectedPreviousHtmlVersionId: previous,
        expectedActiveDataVersionId: a2, expectedPreviousDataVersionId: a3 };
      const removedData = [a1, a4, p1, oldData].sort((a, b) => a - b);
      const removedPaths = (await query<{ storage_path: string }>(`select storage_path
        from top_dashboard_block_data_versions where block_id=$1 and id=any($2::bigint[]) order by storage_path`,
      [id, removedData])).rows.map((row) => row.storage_path);
      const before = await maintenanceSnapshot(id);
      const queuedBefore = await queuedPaths();

      const sentinel = await block();
      const sentinelHtml = await html(sentinel.id, 'maintenance-other-block');
      await publish(sentinel.id, sentinelHtml, null);
      await data(sentinel.id, sentinelHtml, null, 'maintenance-other-data', 'generic', true);
      const sentinelBefore = await maintenanceSnapshot(sentinel.id);

      const preview = await pruneTopDashboardBlockHistory(input);
      assert.equal(preview.dryRun, true, 'omitting dryRun must never commit');
      assert.deepEqual(preview.prunedHtmlVersionIds, [old]);
      assert.deepEqual(preview.prunedDataVersionIds, removedData);
      assert.deepEqual(preview.prunedStoragePaths, removedPaths);
      assert.deepEqual(preview.preservedHtmlVersionIds, [previous, active, draft, secondDraft]);
      assert.deepEqual(preview.preservedDraftVersionIds, [draft, secondDraft]);
      assert.deepEqual(preview.preservedDataVersionIds, [a2, a3, p2, p3, draftData]);
      assert.deepEqual(await maintenanceSnapshot(id), before, 'preview rolls back seeded contexts, versions and pointers');
      assert.deepEqual(await queuedPaths(), queuedBefore, 'preview rolls back the file cleanup outbox');

      for (const stale of [
        { expectedActiveHtmlVersionId: old }, { expectedPreviousHtmlVersionId: null },
        { expectedActiveDataVersionId: a1 }, { expectedPreviousDataVersionId: null },
      ]) {
        await assert.rejects(pruneTopDashboardBlockHistory({ ...input, ...stale, dryRun: false }),
          'expectedActiveHtmlVersionId' in stale || 'expectedPreviousHtmlVersionId' in stale
            ? TopDashboardStateConflictError : TopDashboardBlockDataStateConflictError);
      }
      assert.deepEqual(await maintenanceSnapshot(id), before);
      assert.deepEqual(await queuedPaths(), queuedBefore);

      const applied = await pruneTopDashboardBlockHistory({ ...input, dryRun: false });
      assert.deepEqual(applied, { ...preview, dryRun: false });
      const after = await maintenanceSnapshot(id);
      assert.deepEqual(after.block, before.block);
      assert.deepEqual(after.htmlState, before.htmlState, 'HTML pointers, attribution and timestamps remain exact');
      assert.deepEqual(after.dataState, before.dataState, 'data pointers, attribution and timestamps remain exact');
      assert.deepEqual(after.html, before.html.filter((row) => (row as { id: number }).id !== old));
      assert.deepEqual(await queuedPaths(), [...queuedBefore, ...removedPaths].sort());
      assert.deepEqual(await maintenanceSnapshot(sentinel.id), sentinelBefore);

      const repeated = await pruneTopDashboardBlockHistory({ ...input, dryRun: false });
      assert.deepEqual(repeated, { ...applied, prunedHtmlVersionIds: [], prunedDataVersionIds: [], prunedStoragePaths: [] });
      assert.deepEqual(await maintenanceSnapshot(id), after, 'repeated maintenance is idempotent');
      assert.deepEqual(await queuedPaths(), [...queuedBefore, ...removedPaths].sort());
      await publish(id, previous, active);
      const restored = await getTopDashboardBlockOverview(id);
      assert.equal(restored.data.activeVersionId, p3);
      assert.equal(restored.data.previousVersionId, p2, 'previous HTML remains fully usable after pruning');
      await deleteTopDashboardBlock(id);
      await deleteTopDashboardBlock(sentinel.id);
    });

    await t.test('maintenance preserves saved inactive-context rollback choices over newer legacy uploads', async () => {
      const { id } = await block();
      const previous = await html(id, 'saved-previous');
      const active = await html(id, 'saved-active');
      await query(`update top_dashboard_block_versions set first_published_at=now() where block_id=$1`, [id]);
      await query(`update top_dashboard_block_state set active_version_id=$2, previous_version_id=$3 where block_id=$1`, [id, active, previous]);
      const p1 = await legacyData(id, previous, 'saved-p1', true);
      const p2 = await legacyData(id, previous, 'saved-p2', true);
      const p3 = await legacyData(id, previous, 'saved-p3', true);
      const a1 = await legacyData(id, active, 'saved-a1', true);
      await query(`update top_dashboard_block_data_state set active_version_id=$2 where block_id=$1`, [id, a1]);
      await query(`insert into top_dashboard_block_data_context_state
        (block_id,context_key,bound_html_version_id,active_version_id,previous_version_id)
        values ($1,$2,$3,$4,$5)`, [id, `html:${previous}`, previous, p1, p2]);
      const input = { blockId: id, expectedActiveHtmlVersionId: active, expectedPreviousHtmlVersionId: previous,
        expectedActiveDataVersionId: a1, expectedPreviousDataVersionId: null, dryRun: false };
      const result = await pruneTopDashboardBlockHistory(input);
      assert.deepEqual(result.prunedDataVersionIds, [p3]);
      assert.deepEqual(result.preservedDataVersionIds, [p1, p2, a1]);
      await publish(id, previous, active);
      const restored = await getTopDashboardBlockOverview(id);
      assert.equal(restored.data.activeVersionId, p1);
      assert.equal(restored.data.previousVersionId, p2);
      await deleteTopDashboardBlock(id);
    });

    await t.test('maintenance invariant failures roll back deletions, contexts and queued files', async () => {
      const { id } = await block();
      const active = await html(id, 'maintenance-failure-active');
      await publish(id, active, null);
      const oldData = await legacyData(id, active, 'maintenance-failure-old', true);
      const a1 = await legacyData(id, active, 'maintenance-failure-a1', true);
      const a2 = await legacyData(id, active, 'maintenance-failure-a2', true);
      await query(`update top_dashboard_block_data_state set active_version_id=$2,previous_version_id=$3 where block_id=$1`, [id, a2, a1]);
      const before = await maintenanceSnapshot(id);
      const queuedBefore = await queuedPaths();
      await query(`create function top_maintenance_test_state_change() returns trigger language plpgsql as $$
        begin if old.block_id = ${id} then
          update top_dashboard_blocks set updated_at=updated_at + interval '1 second' where id=${id};
        end if; return old; end $$;
        create trigger top_maintenance_test_state_change after delete on top_dashboard_block_data_versions
        for each row execute function top_maintenance_test_state_change()`);
      try {
        await assert.rejects(pruneTopDashboardBlockHistory({ blockId: id,
          expectedActiveHtmlVersionId: active, expectedPreviousHtmlVersionId: null,
          expectedActiveDataVersionId: a2, expectedPreviousDataVersionId: a1, dryRun: false }),
        /would change publication state/);
        assert.deepEqual(await maintenanceSnapshot(id), before);
        assert.deepEqual(await queuedPaths(), queuedBefore);
        assert.ok((await dataIds(id)).includes(oldData));
      } finally {
        await query(`drop trigger top_maintenance_test_state_change on top_dashboard_block_data_versions;
          drop function top_maintenance_test_state_change()`);
      }
      await deleteTopDashboardBlock(id);
    });

    await t.test('draft quota rejects the new upload without evicting drafts', async () => {
      const { id } = await block();
      const drafts = [];
      for (let i = 0; i < 50; i++) drafts.push(await html(id, `draft-${i}`));
      await assert.rejects(html(id, 'over-quota'), TopDashboardDraftLimitError);
      assert.equal((await getTopDashboardBlockOverview(id)).versions.length, 50);
      await publish(id, drafts[0], null);
      await publish(id, drafts[1], drafts[0]);
      await publish(id, drafts[2], drafts[1]);
      const overview = await getTopDashboardBlockOverview(id);
      assert.equal(overview.versions.length, 49);
      assert.equal(overview.versions.filter((v) => v.status === 'draft').length, 47);
      await deleteTopDashboardBlock(id);
    });

    await t.test('data quota rejects a fourth maximum-sized protected file without evicting either HTML pair', async () => {
      const { id } = await block();
      const a = await html(id, 'quota-A');
      await publish(id, a, null);
      const largeData = (htmlId: number, previous: number | null, label: string) => createAndActivateTopDashboardBlockDataVersion({
        ...dataInput(id, htmlId, previous, label, 'generic', true),
        fileSize: TOP_DASHBOARD_DATA_STORED_MAX_BYTES,
        uncompressedSize: TOP_DASHBOARD_DATA_STORED_MAX_BYTES,
      });
      // File-backed metadata tests quota without allocating large files or buffers.
      const a1 = await largeData(a, null, 'quota-a1');
      const a2 = await largeData(a, a1.activeVersionId, 'quota-a2');
      const b = await html(id, 'quota-B');
      await publish(id, b, a);
      const b1 = await largeData(b, null, 'quota-b1');
      const before = await getTopDashboardBlockOverview(id);
      await assert.rejects(largeData(b, b1.activeVersionId, 'quota-b2'), TopDashboardDataStorageLimitError);
      assert.deepEqual(await getTopDashboardBlockOverview(id), before);
      await publish(id, a, b);
      assert.equal((await getTopDashboardBlockOverview(id)).data.activeVersionId, a2.activeVersionId);
      await rollbackData(id, a, a1.activeVersionId, a2.activeVersionId);
      assert.deepEqual(await dataIds(id), [a1.activeVersionId, a2.activeVersionId, b1.activeVersionId]);
      await deleteTopDashboardBlock(id);
    });

    await t.test('concurrent uploads/publications serialize and stale writers cannot prune', async () => {
      const { id } = await block();
      const h = await html(id, 'concurrent');
      await publish(id, h, null);
      const d1 = await data(id, h, null, 'concurrent-1');
      const writers = await Promise.allSettled([
        data(id, h, d1.activeVersionId, 'concurrent-2'),
        data(id, h, d1.activeVersionId, 'concurrent-3'),
      ]);
      assert.equal(writers.filter((result) => result.status === 'fulfilled').length, 1);
      const failed = writers.find((result) => result.status === 'rejected');
      assert.ok(failed && failed.reason instanceof TopDashboardBlockDataStateConflictError);
      assert.equal((await dataIds(id)).length, 2);
      const b = await html(id, 'concurrent-B');
      const c = await html(id, 'concurrent-C');
      const publishes = await Promise.allSettled([publish(id, b, h), publish(id, c, h)]);
      assert.equal(publishes.filter((result) => result.status === 'fulfilled').length, 1);
      const stale = publishes.find((result) => result.status === 'rejected');
      assert.ok(stale && stale.reason instanceof TopDashboardStateConflictError);
      const overview = await getTopDashboardBlockOverview(id);
      assert.equal(overview.previousVersionId, h);
      assert.equal(overview.versions.filter((v) => v.status === 'draft').length, 1);
      assert.equal((await dataIds(id)).length, 2, 'previous HTML keeps both working snapshots');
      await publish(id, h, overview.activeVersionId);
      assert.equal((await getTopDashboardBlockOverview(id)).data.previousVersionId, d1.activeVersionId);
      await deleteTopDashboardBlock(id);
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
