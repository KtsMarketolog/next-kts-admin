import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdminSession, AdminSessionRole } from '../src/shared/lib/adminAuth';
import type { KnowledgeBaseNode } from '../src/shared/lib/knowledgeBase';
import { query, withTransaction } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { createTrustedAdminSession } from '../src/shared/lib/db/adminSessionsRepo';
import { createKnowledgeBaseFile, createKnowledgeBaseFolder, getKnowledgeBaseFileForRead, getKnowledgeBaseNode,
  listKnowledgeBase, listKnowledgeBaseStats, previewKnowledgeBaseDeletion, deleteKnowledgeBaseNode,
  recordKnowledgeBaseEvent, setKnowledgeBaseArchive, updateKnowledgeBaseNode } from '../src/shared/lib/db/knowledgeBaseRepo';
import { processKnowledgeBaseDeletionCleanup } from '../src/shared/lib/db/knowledgeBaseDeletionCleanup';
import { KNOWLEDGE_BASE_LOCK } from '../src/shared/lib/db/knowledgeBaseRepo.shared';
import { saveKnowledgeBaseUpload } from '../src/shared/lib/knowledgeBaseStorage';
import type { PoolClient } from 'pg';

type BackupReference = { path: string; size: number; sha256?: string };
const backupCapture = createRequire(import.meta.url)('../ops/backup/capture.cjs') as {
  inspectReferences(client: PoolClient): Promise<{ topDashboard: BackupReference[]; clientDocuments: BackupReference[]; knowledgeBase?: BackupReference[] }>;
};

function guard() {
  assert.equal(process.env.KTS_KNOWLEDGE_BASE_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, 'localhost'); assert.equal(url.username, 'kb_app');
  assert.equal(url.pathname, '/kts_knowledge_base_integration'); assert.equal(url.password, '');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['host', 'port']); assert.equal(url.searchParams.get('port'), '55489');
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-knowledge-base-postgres\.[A-Za-z0-9]+\/socket$/);
}
const status = (expected: number) => (error: unknown) => (error as { status?: number }).status === expected;
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
async function actor(role: AdminSessionRole): Promise<AdminSession> {
  const table = ['manager', 'support_manager'].includes(role) ? 'wholesale_managers' : 'admin_users';
  const name = `kb-delete-${randomUUID()}`;
  const inserted = await query<{ id: string }>(`insert into ${table}(login,email,name,role) values($1,$2,$3,$4) returning id::text`,
    [name, `${name}@synthetic.test`, name, role]);
  const identity = table === 'wholesale_managers' ? { managerId: Number(inserted.rows[0].id) } : { adminUserId: Number(inserted.rows[0].id) };
  const stored = await createTrustedAdminSession({ role, ...identity });
  return { role, ...identity, sessionId: stored.sessionId };
}
async function folder(session: AdminSession, parentId: number | null = null) {
  return (await createKnowledgeBaseFolder(session, { parentId, operationId: randomUUID(), title: `Delete folder ${randomUUID()}` })).node;
}
async function file(session: AdminSession, parentId: number | null) {
  const stored = await saveKnowledgeBaseUpload(new Request('https://synthetic.test/upload', { method: 'POST', body: 'synthetic guide' }), 'guide.txt');
  const input = { parentId, operationId: randomUUID(), title: `Guide ${randomUUID()}`, ...stored };
  return { input, node: (await createKnowledgeBaseFile(session, input)).node };
}
async function archive(session: AdminSession, node: KnowledgeBaseNode) {
  return setKnowledgeBaseArchive(session, node.id, { expectedRevision: node.revision, archived: true });
}
async function confirmation(session: AdminSession, node: KnowledgeBaseNode) {
  const preview = await previewKnowledgeBaseDeletion(session, node.id, { expectedRevision: node.revision });
  return { expectedRevision: node.revision, previewToken: preview.previewToken, confirmationTitle: node.title, operationId: randomUUID() };
}

test('knowledge base explicit archive deletion: permissions, complete previews, atomic tombstones, private-file outbox and durable history', { timeout: 240_000 }, async t => {
  guard();
  const storage = await mkdtemp(join(tmpdir(), 'kts-kb-deletion-test-'));
  const previousStorage = process.env.UPLOAD_DIR; process.env.UPLOAD_DIR = storage;
  try {
    await ensureSiteSchema();
    const admin = await actor('admin'), admintop = await actor('admintop'), top = await actor('top');
    const manager = await actor('manager'), support = await actor('support_manager'), purchaser = await actor('purchaser'), wholesale = await actor('wholesale_admin');

    await t.test('only Admin, Admin TOP and TOP delete; active materials and wrong confirmation are protected', async () => {
      for (const session of [admin, admintop, top]) {
        const active = await folder(admin);
        await assert.rejects(previewKnowledgeBaseDeletion(session, active.id, { expectedRevision: active.revision }), code('ARCHIVE_REQUIRED'));
        const source = await archive(admin, active);
        const input = await confirmation(session, source);
        await assert.rejects(deleteKnowledgeBaseNode(session, source.id, { ...input, confirmationTitle: 'wrong' }), code('DELETE_CONFIRMATION_REQUIRED'));
        const result = await deleteKnowledgeBaseNode(session, source.id, input);
        assert.equal(result.deleted, true); assert.equal(result.affectedCount, 1); assert.equal(result.cleanupPending, false);
        assert.equal(await getKnowledgeBaseNode(session, source.id, { archived: true }), null);
      }
      const source = await archive(admin, await folder(admin));
      const input = await confirmation(admin, source);
      for (const session of [manager, support, purchaser, wholesale]) {
        await assert.rejects(previewKnowledgeBaseDeletion(session, source.id, { expectedRevision: source.revision }), status(403));
        await assert.rejects(deleteKnowledgeBaseNode(session, source.id, input), status(403));
      }
      for (const session of [{ ...top, sessionId: randomUUID() }, { ...manager, role: 'top' as const }]) {
        await assert.rejects(deleteKnowledgeBaseNode(session, source.id, input), status(401));
      }
      await assert.rejects(deleteKnowledgeBaseNode(top, source.id, input), code('DELETE_PREVIEW_STALE'), 'preview is bound to actor/session');
      assert.ok(await getKnowledgeBaseNode(admin, source.id, { archived: true }));
    });

    await t.test('archive browsing includes effectively archived descendants; deletion hides subtree without erasing usage history', async () => {
      const root = await folder(admin), child = await folder(admin, root.id), nested = await folder(admin, child.id);
      const document = await file(admin, nested.id), ownArchived = await archive(admin, await folder(admin, root.id));
      const untouched = await file(admin, null);
      await recordKnowledgeBaseEvent(admin, { eventId: randomUUID(), nodeId: document.node.id, action: 'file_view' });
      const archivedRoot = await archive(admin, root);
      const listing = await listKnowledgeBase(admin, { parentId: root.id, archived: true });
      assert.deepEqual(listing.nodes.map(node => node.id), [child.id, ownArchived.id]);
      assert.ok(listing.breadcrumbs[0].archivedAt);
      const inner = await listKnowledgeBase(admin, { parentId: nested.id, archived: true });
      assert.equal(inner.nodes[0].id, document.node.id); assert.equal(inner.nodes[0].archivedAt, null);
      await assert.rejects(listKnowledgeBase(manager, { parentId: root.id, archived: true }), status(403));
      const before = await query('select * from knowledge_base_nodes where id=$1', [root.id]);
      const preview = await previewKnowledgeBaseDeletion(top, root.id, { expectedRevision: archivedRoot.revision });
      assert.equal(preview.affectedCount, 5); assert.equal(preview.folderCount, 4); assert.equal(preview.fileCount, 1); assert.equal(preview.totalBytes, document.input.size);
      assert.doesNotMatch(JSON.stringify(preview), /storage_path|storagePath|sha256|operation_digest|password/);
      assert.deepEqual((await query('select * from knowledge_base_nodes where id=$1', [root.id])).rows, before.rows, 'preview is read only');
      const input = { expectedRevision: archivedRoot.revision, previewToken: preview.previewToken, confirmationTitle: root.title, operationId: randomUUID() };
      const result = await deleteKnowledgeBaseNode(top, root.id, input);
      assert.equal(result.cleanupPending, false);
      for (const node of [root, child, nested, document.node, ownArchived]) {
        assert.equal(await getKnowledgeBaseNode(admin, node.id, { archived: true }), null);
        await assert.rejects(setKnowledgeBaseArchive(admin, node.id, { expectedRevision: node.revision, archived: false }), status(404));
      }
      assert.equal(await getKnowledgeBaseFileForRead(admin, document.node.id), null);
      assert.ok((await query('select archived_at from knowledge_base_nodes where id=$1', [document.node.id])).rows[0].archived_at,
        'legacy readers also see an own archive marker, not a still-readable pending file');
      await assert.rejects(query('update knowledge_base_nodes set archived_at=null,deleted_at=null,deleted_by=null where id=$1', [root.id]),
        { code: '23514' }, 'older code cannot restore an irreversibly deleted item');
      assert.ok(!(await listKnowledgeBase(admin, { archived: true })).nodes.some(node => node.id === root.id));
      await assert.rejects(readFile(join(storage, document.input.storagePath)), { code: 'ENOENT' });
      assert.equal(await readFile(join(storage, untouched.input.storagePath), 'utf8'), 'synthetic guide');
      const history = await listKnowledgeBaseStats(admin, { view: 'materials', nodeId: document.node.id });
      assert.equal(history.rows[0].fileViews, 1); assert.match(history.rows[0].title, /\(удалено\)/);
      await assert.rejects(createKnowledgeBaseFile(admin, document.input), code('OPERATION_CONFLICT'), 'old upload cannot resurrect a deleted file');
      assert.deepEqual(await deleteKnowledgeBaseNode(top, root.id, input), result, 'same confirmed operation is idempotent');
      await assert.rejects(deleteKnowledgeBaseNode(top, root.id, { ...input, confirmationTitle: 'another' }), code('OPERATION_CONFLICT'));
      assert.equal((await query('select count(*)::int as n from knowledge_base_deletions where actor_key=$1 and operation_id=$2', [`admin:${top.adminUserId}`, input.operationId])).rows[0].n, 1);
    });

    await t.test('child changes invalidate preview; descendants can be individually deleted while parent remains archived', async () => {
      const root = await folder(admin), child = await folder(admin, root.id);
      const archivedRoot = await archive(admin, root);
      const old = await confirmation(admin, archivedRoot);
      const childInput = await confirmation(admin, child);
      await deleteKnowledgeBaseNode(admin, child.id, childInput);
      await assert.rejects(deleteKnowledgeBaseNode(admin, root.id, old), code('DELETE_PREVIEW_STALE'));
      assert.ok(await getKnowledgeBaseNode(admin, root.id, { archived: true }));
      const fresh = await previewKnowledgeBaseDeletion(admin, root.id, { expectedRevision: archivedRoot.revision });
      assert.equal(fresh.affectedCount, 1);
      const restored = await setKnowledgeBaseArchive(admin, root.id, { expectedRevision: archivedRoot.revision, archived: false });
      await assert.rejects(deleteKnowledgeBaseNode(admin, root.id, old), code('DELETE_PREVIEW_STALE'));
      assert.equal((await listKnowledgeBase(admin, { parentId: restored.id })).nodes.length, 0);
      assert.equal(await getKnowledgeBaseNode(admin, child.id, { archived: true }), null);
    });

    await t.test('concurrent confirmations cannot double-delete; audit and outbox changes roll back together on failure', async () => {
      const source = await archive(admin, await folder(admin));
      const input = await confirmation(admin, source);
      const outcomes = await Promise.all([deleteKnowledgeBaseNode(admin, source.id, input), deleteKnowledgeBaseNode(admin, source.id, input)]);
      assert.deepEqual(outcomes[0], outcomes[1]);
      const document = await file(admin, null), archived = await archive(admin, document.node);
      const data = await confirmation(admin, archived);
      await query(`create function kb_reject_delete_test() returns trigger language plpgsql as $$begin raise exception 'synthetic insert failure'; end$$`);
      await query(`create trigger kb_reject_delete_test before insert on knowledge_base_file_deletions for each row execute function kb_reject_delete_test()`);
      try { await assert.rejects(deleteKnowledgeBaseNode(admin, archived.id, data)); }
      finally { await query('drop trigger kb_reject_delete_test on knowledge_base_file_deletions'); await query('drop function kb_reject_delete_test()'); }
      assert.ok(await getKnowledgeBaseNode(admin, archived.id, { archived: true }));
      assert.equal((await query('select count(*)::int as n from knowledge_base_deletions where operation_id=$1', [data.operationId])).rows[0].n, 0);
      assert.equal(await readFile(join(storage, document.input.storagePath), 'utf8'), 'synthetic guide');
    });

    await t.test('ancestor ACL and deep descendant metadata/grants are included in the confirmation fingerprint', async () => {
      const ancestor = await folder(admin), source = await folder(admin, ancestor.id), child = await folder(admin, source.id);
      const document = await file(admin, child.id), archived = await archive(admin, source);
      let input = await confirmation(admin, archived);
      await updateKnowledgeBaseNode(admin, ancestor.id, { expectedRevision: ancestor.revision,
        access: { mode: 'custom', actorKeys: [`manager:${manager.managerId}`] } });
      await assert.rejects(deleteKnowledgeBaseNode(admin, source.id, input), code('DELETE_PREVIEW_STALE'));
      input = await confirmation(admin, archived);
      await query('update knowledge_base_nodes set title=$2,revision=revision+1 where id=$1', [document.node.id, 'Changed deep document']);
      await assert.rejects(deleteKnowledgeBaseNode(admin, source.id, input), code('DELETE_PREVIEW_STALE'));
      input = await confirmation(admin, archived);
      await query('insert into knowledge_base_grants(node_id,actor_key) values($1,$2)', [document.node.id, `manager:${manager.managerId}`]);
      await assert.rejects(deleteKnowledgeBaseNode(admin, source.id, input), code('DELETE_PREVIEW_STALE'));
      assert.ok(await getKnowledgeBaseNode(admin, source.id, { archived: true }));
    });

    await t.test('physical cleanup failure never reverses committed deletion; persisted jobs retry and never remove a live reference', async () => {
      const document = await file(admin, null), archived = await archive(admin, document.node);
      await writeFile(join(storage, document.input.storagePath), 'unexpected data', { mode: 0o600 });
      const result = await deleteKnowledgeBaseNode(admin, archived.id, await confirmation(admin, archived));
      assert.equal(result.deleted, true); assert.equal(result.cleanupPending, true);
      assert.equal(await getKnowledgeBaseNode(admin, archived.id, { archived: true }), null);
      let job = (await query('select * from knowledge_base_file_deletions where node_id=$1', [archived.id])).rows[0];
      assert.equal(job.attempts, 1); assert.equal(job.completed_at, null);
      await writeFile(join(storage, document.input.storagePath), 'synthetic guide', { mode: 0o600 });
      await query('update knowledge_base_file_deletions set next_attempt_at=now() where node_id=$1', [archived.id]);
      const cleanup = await processKnowledgeBaseDeletionCleanup({ deletionId: String(job.deletion_id), limit: 1 });
      assert.equal(cleanup.completed, 1); assert.equal(cleanup.pending, false);
      await assert.rejects(readFile(join(storage, document.input.storagePath)), { code: 'ENOENT' });
      const second = await file(admin, null), sameReference = (await createKnowledgeBaseFile(admin, { ...second.input, operationId: randomUUID(), title: 'Other reference' })).node;
      const secondArchived = await archive(admin, second.node);
      assert.equal((await deleteKnowledgeBaseNode(admin, secondArchived.id, await confirmation(admin, secondArchived))).cleanupPending, true);
      assert.ok(await getKnowledgeBaseFileForRead(admin, sameReference.id));
      assert.equal(await readFile(join(storage, second.input.storagePath), 'utf8'), 'synthetic guide');
      await query('update knowledge_base_file_deletions set attempts=7,next_attempt_at=now() where node_id=$1', [second.node.id]);
      job = (await query('select * from knowledge_base_file_deletions where node_id=$1', [second.node.id])).rows[0];
      const failed = await processKnowledgeBaseDeletionCleanup({ deletionId: String(job.deletion_id), limit: 1 });
      assert.equal(failed.exhausted, 1); assert.equal(failed.pending, true);
      const noRetry = await processKnowledgeBaseDeletionCleanup({ deletionId: String(job.deletion_id), limit: 1 });
      assert.equal(noRetry.processed, 0, 'bounded retries stop on repeated unsafe target');
    });

    await t.test('cleanup waits for tree writers then rechecks committed live references before touching bytes', async () => {
      const document = await file(admin, null), archived = await archive(admin, document.node), target = await file(admin, null);
      await writeFile(join(storage, document.input.storagePath), 'unexpected data');
      await deleteKnowledgeBaseNode(admin, archived.id, await confirmation(admin, archived));
      await writeFile(join(storage, document.input.storagePath), 'synthetic guide');
      await query('update knowledge_base_file_deletions set next_attempt_at=now() where node_id=$1', [archived.id]);
      const job = (await query('select deletion_id::text from knowledge_base_file_deletions where node_id=$1', [archived.id])).rows[0];
      let ready!: () => void, release!: () => void;
      const locked = new Promise<void>(resolve => { ready = resolve; }), proceed = new Promise<void>(resolve => { release = resolve; });
      const writer = withTransaction(async client => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [KNOWLEDGE_BASE_LOCK]);
        await client.query('update knowledge_base_nodes set storage_path=$2 where id=$1', [target.node.id, document.input.storagePath]);
        ready(); await proceed;
      });
      await locked;
      const waiting = processKnowledgeBaseDeletionCleanup({ deletionId: job.deletion_id, limit: 1 });
      release(); await writer;
      const result = await waiting;
      assert.equal(result.completed, 0); assert.equal(result.failed, 1);
      assert.equal(await readFile(join(storage, document.input.storagePath), 'utf8'), 'synthetic guide');
    });

    await t.test('backup PostgreSQL references include live and archived files, exclude physically removed tombstones, and retain legacy shape', async () => {
      const active = await file(admin, null), archivedFile = await file(admin, null);
      const archived = await archive(admin, archivedFile.node);
      const toDelete = await file(admin, null), deleted = await archive(admin, toDelete.node);
      const removed = await deleteKnowledgeBaseNode(admin, deleted.id, await confirmation(admin, deleted));
      assert.equal(removed.cleanupPending, false);
      await assert.rejects(readFile(join(storage, toDelete.input.storagePath)), { code: 'ENOENT' });
      const references = await withTransaction(client => backupCapture.inspectReferences(client));
      assert.ok(Array.isArray(references.knowledgeBase));
      for (const expected of [active, archivedFile]) {
        assert.deepEqual(references.knowledgeBase.find(ref => ref.path === expected.input.storagePath),
          { path: expected.input.storagePath, size: expected.input.size, sha256: expected.input.sha256 });
      }
      assert.ok((await getKnowledgeBaseNode(admin, archived.id, { archived: true }))?.archivedAt);
      assert.ok(!references.knowledgeBase.some(ref => ref.path === toDelete.input.storagePath));
      assert.ok((await query('select deleted_at from knowledge_base_nodes where id=$1', [deleted.id])).rows[0].deleted_at,
        'the tombstone remains in the database backup, only its physical file reference is excluded');
      assert.equal((await query('select count(*)::int as n from knowledge_base_deletions where node_id=$1', [deleted.id])).rows[0].n, 1);
      assert.equal((await query('select count(*)::int as n from knowledge_base_file_deletions where node_id=$1 and completed_at is not null', [deleted.id])).rows[0].n, 1);
      // This is only the disposable guarded cluster. Rename the feature column
      // within one transaction to execute the actual old-schema discovery path,
      // then restore it; no rows, constraints or history are dropped.
      const legacy = await withTransaction(async client => {
        await client.query('alter table knowledge_base_nodes rename column deleted_at to legacy_deleted_at_fixture');
        try { return await backupCapture.inspectReferences(client); }
        finally { await client.query('alter table knowledge_base_nodes rename column legacy_deleted_at_fixture to deleted_at'); }
      });
      assert.deepEqual(Object.keys(legacy), ['topDashboard', 'clientDocuments']);
      assert.deepEqual(legacy.topDashboard, references.topDashboard); assert.deepEqual(legacy.clientDocuments, references.clientDocuments);
      assert.deepEqual(await withTransaction(client => backupCapture.inspectReferences(client)), references,
        'feature restoration recovers the exact complete reference set');
    });
  } finally {
    if (previousStorage === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = previousStorage;
    assert.match(storage, /kts-kb-deletion-test-/); await rm(storage, { recursive: true, force: true });
    await globalThis.__ktsPgPool?.end();
  }
});
