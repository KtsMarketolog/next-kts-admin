import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdminSession, AdminSessionRole } from '../src/shared/lib/adminAuth';
import { knowledgeBaseActorKey, type KnowledgeBaseAccess, type KnowledgeBaseNode } from '../src/shared/lib/knowledgeBase';
import { query, withTransaction } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { createTrustedAdminSession } from '../src/shared/lib/db/adminSessionsRepo';
import { createKnowledgeBaseFile, createKnowledgeBaseFolder, getKnowledgeBaseFileForRead, getKnowledgeBaseNode,
  listKnowledgeBase, listKnowledgeBaseStats, moveKnowledgeBaseNode, previewKnowledgeBaseMove,
  recordKnowledgeBaseEvent, setKnowledgeBaseArchive, updateKnowledgeBaseNode } from '../src/shared/lib/db/knowledgeBaseRepo';
import { KNOWLEDGE_BASE_LOCK } from '../src/shared/lib/db/knowledgeBaseRepo.shared';

function guard() {
  assert.equal(process.env.KTS_KNOWLEDGE_BASE_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, 'localhost'); assert.equal(url.username, 'kb_app');
  assert.equal(url.pathname, '/kts_knowledge_base_integration'); assert.equal(url.password, '');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['host', 'port']);
  assert.equal(url.searchParams.get('port'), '55489');
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-knowledge-base-postgres\.[A-Za-z0-9]+\/socket$/);
}
const status = (expected: number) => (error: unknown) => (error as { status?: number }).status === expected;
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
async function actor(role: AdminSessionRole): Promise<AdminSession> {
  const table = ['manager', 'support_manager'].includes(role) ? 'wholesale_managers' : 'admin_users';
  const name = `kb-move-${randomUUID()}`;
  const inserted = await query<{ id: string }>(`insert into ${table}(login,email,name,role) values($1,$2,$3,$4) returning id::text`,
    [name, `${name}@synthetic.test`, name, role]);
  const identity = table === 'wholesale_managers' ? { managerId: Number(inserted.rows[0].id) } : { adminUserId: Number(inserted.rows[0].id) };
  const stored = await createTrustedAdminSession({ role, ...identity });
  return { role, ...identity, sessionId: stored.sessionId };
}
async function folder(session: AdminSession, parentId: number | null, access?: KnowledgeBaseAccess) {
  return (await createKnowledgeBaseFolder(session, { parentId, operationId: randomUUID(), title: `Move folder ${randomUUID()}`, access })).node;
}
const fileInput = (parentId: number | null) => ({ parentId, operationId: randomUUID(), title: 'Synthetic guide',
  originalName: 'guide.pdf', mimeType: 'application/pdf', size: 20,
  storagePath: `knowledge-base/${randomUUID()}.pdf`, sha256: 'a'.repeat(64) });
async function preview(session: AdminSession, source: KnowledgeBaseNode, targetParentId: number | null) {
  return previewKnowledgeBaseMove(session, source.id, { expectedRevision: source.revision, targetParentId });
}
async function move(session: AdminSession, source: KnowledgeBaseNode, targetParentId: number | null) {
  const plan = await preview(session, source, targetParentId);
  return moveKnowledgeBaseNode(session, source.id, { expectedRevision: source.revision, targetParentId, previewToken: plan.previewToken });
}
async function row(id: number) {
  return (await query('select row_to_json(n) as row from knowledge_base_nodes n where id=$1', [id])).rows[0].row;
}
function immutableRow(value: Record<string, unknown>) {
  const copy = { ...value };
  for (const key of ['parent_id', 'revision', 'updated_at', 'acl_mode']) delete copy[key];
  return copy;
}

test('knowledge base move real PostgreSQL atomicity, tree safety, access and history', { timeout: 240_000 }, async t => {
  guard();
  try {
    await ensureSiteSchema();
    const admin = await actor('admin'), admintop = await actor('admintop'), top = await actor('top');
    const manager = await actor('manager'), support = await actor('support_manager'), purchaser = await actor('purchaser'), wholesale = await actor('wholesale_admin');
    const key = knowledgeBaseActorKey;
    const acl = (...sessions: AdminSession[]): KnowledgeBaseAccess => ({ mode: 'custom', actorKeys: sessions.map(key).sort() });

    await t.test('preview is read only, bounded DTO with destination breadcrumbs; managers can move a file', async () => {
      for (const session of [admin, admintop, top]) {
        const from = await folder(admin, null, acl(manager));
        const root = await folder(admin, null, acl(purchaser));
        const to = await folder(admin, root.id);
        const upload = fileInput(from.id);
        const source = (await createKnowledgeBaseFile(admin, upload)).node;
        const before = await row(source.id);
        const plan = await preview(session, source, to.id);
        assert.equal(plan.source.id, source.id); assert.equal(plan.destination?.id, to.id);
        assert.deepEqual(plan.destinationBreadcrumbs.map(node => node.id), [root.id, to.id]);
        assert.equal(plan.affectedCount, 1); assert.match(plan.previewToken, /^[0-9a-f]{64}$/);
        assert.match(plan.accessWarning, /получить или потерять доступ/);
        assert.doesNotMatch(JSON.stringify(plan), /storagePath|storage_path|operation_digest|sha256|password|synthetic\.test/);
        assert.deepEqual(await row(source.id), before);
        const changed = await moveKnowledgeBaseNode(session, source.id,
          { expectedRevision: source.revision, targetParentId: to.id, previewToken: plan.previewToken });
        assert.equal(changed.parentId, to.id); assert.equal(changed.revision, '2');
        assert.deepEqual(immutableRow(await row(source.id)), immutableRow(before));
        assert.equal(await getKnowledgeBaseFileForRead(manager, source.id), null);
        assert.equal((await getKnowledgeBaseFileForRead(purchaser, source.id))?.storagePath, upload.storagePath);
      }
    });

    await t.test('folder move preserves descendant IDs, revisions, private file bytes, event history and archive state', async () => {
      const left = await folder(admin, null, acl(manager, purchaser));
      const right = await folder(admin, null, acl(purchaser));
      const source = await folder(admin, left.id);
      const child = await folder(admin, source.id, acl(manager, purchaser));
      const upload = fileInput(child.id);
      const file = (await createKnowledgeBaseFile(admin, upload)).node;
      const archived = await folder(admin, source.id);
      await setKnowledgeBaseArchive(admin, archived.id, { expectedRevision: archived.revision, archived: true });
      await recordKnowledgeBaseEvent(manager, { eventId: randomUUID(), nodeId: file.id, action: 'file_view' });
      await recordKnowledgeBaseEvent(admin, { eventId: randomUUID(), nodeId: source.id, action: 'folder_open' });
      const beforeRows = await Promise.all([source.id, child.id, file.id, archived.id].map(row));
      const beforeEvents = (await query('select * from knowledge_base_events where node_id=any($1::bigint[]) order by id', [[source.id, file.id]])).rows;
      const diskRoot = await mkdtemp(join(tmpdir(), 'kts-kb-move-file-'));
      try {
        await mkdir(join(diskRoot, 'knowledge-base'));
        await writeFile(join(diskRoot, upload.storagePath), 'synthetic file bytes');
        const plan = await preview(admin, source, right.id);
        assert.equal(plan.affectedCount, 4, 'archived descendants count toward affected materials');
        await moveKnowledgeBaseNode(admin, source.id, { expectedRevision: source.revision, targetParentId: right.id, previewToken: plan.previewToken });
        assert.equal(await readFile(join(diskRoot, upload.storagePath), 'utf8'), 'synthetic file bytes');
        assert.deepEqual(await Promise.all([child.id, file.id, archived.id].map(row)), beforeRows.slice(1));
        assert.deepEqual(immutableRow(await row(source.id)), immutableRow(beforeRows[0]));
        assert.deepEqual((await query('select * from knowledge_base_events where node_id=any($1::bigint[]) order by id', [[source.id, file.id]])).rows, beforeEvents);
        assert.equal((await listKnowledgeBaseStats(admin, { view: 'materials', nodeId: file.id })).rows[0].fileViews, 1);
        assert.equal(await getKnowledgeBaseFileForRead(manager, file.id), null);
        assert.equal((await getKnowledgeBaseFileForRead(purchaser, file.id))?.storagePath, upload.storagePath);
        assert.deepEqual((await listKnowledgeBase(purchaser, { parentId: child.id })).breadcrumbs.map(node => node.id), [right.id, source.id, child.id]);
        assert.equal(await getKnowledgeBaseNode(purchaser, archived.id), null);
      } finally { await rm(diskRoot, { recursive: true, force: true }); }
    });

    await t.test('moving inherited folder to root materializes raw effective ACL intersection, not union or only active employees', async () => {
      const disabled = await actor('manager'), deleted = await actor('purchaser');
      const oldKeys = [key(manager), key(disabled), key(deleted)].sort();
      const root = await folder(admin, null, acl(manager, purchaser, disabled, deleted));
      const restrictive = await folder(admin, root.id, { mode: 'custom', actorKeys: oldKeys });
      const source = await folder(admin, restrictive.id);
      const file = (await createKnowledgeBaseFile(admin, fileInput(source.id))).node;
      await query('update wholesale_managers set is_active=false where id=$1', [disabled.managerId]);
      await query('delete from admin_users where id=$1', [deleted.adminUserId]);
      const plan = await preview(top, source, null);
      assert.equal(plan.destination, null); assert.deepEqual(plan.destinationBreadcrumbs, []);
      assert.match(plan.accessWarning, /сохранён отдельным списком/);
      const changed = await moveKnowledgeBaseNode(top, source.id, { expectedRevision: source.revision, targetParentId: null, previewToken: plan.previewToken });
      assert.equal(changed.parentId, null); assert.deepEqual(changed.access, { mode: 'custom', actorKeys: oldKeys });
      assert.ok(await getKnowledgeBaseFileForRead(manager, file.id));
      assert.equal(await getKnowledgeBaseFileForRead(purchaser, file.id), null);
      await query('update wholesale_managers set is_active=true where id=$1', [disabled.managerId]);
      assert.ok(await getKnowledgeBaseFileForRead(disabled, file.id), 'reactivation retains previous effective access');
      await updateKnowledgeBaseNode(admin, root.id, { expectedRevision: root.revision, access: acl(purchaser) });
      assert.ok(await getKnowledgeBaseFileForRead(manager, file.id), 'old ancestor no longer controls new root');
      assert.equal(await getKnowledgeBaseFileForRead(purchaser, file.id), null);
    });

    await t.test('custom folder moved to root keeps own ACL and warns about removed ancestor restrictions', async () => {
      const root = await folder(admin, null, acl(manager));
      const source = await folder(admin, root.id, acl(manager, purchaser));
      const file = (await createKnowledgeBaseFile(admin, fileInput(source.id))).node;
      assert.equal(await getKnowledgeBaseFileForRead(purchaser, file.id), null);
      assert.match((await preview(admin, source, null)).accessWarning, /Ограничения прежних родительских папок перестанут действовать/);
      const changed = await move(admin, source, null);
      assert.deepEqual(changed.access, source.access);
      assert.ok(await getKnowledgeBaseFileForRead(purchaser, file.id));
      const zeroRoot = await folder(admin, null), inherited = await folder(admin, zeroRoot.id);
      assert.deepEqual((await move(admin, inherited, null)).access, { mode: 'custom', actorKeys: [] });
    });

    await t.test('moving a root into another folder keeps custom ACL and intersects new ancestors', async () => {
      const source = await folder(admin, null, acl(manager, purchaser));
      const destination = await folder(admin, null, acl(purchaser));
      const changed = await move(admin, source, destination.id);
      assert.deepEqual(changed.access, source.access);
      assert.equal(await getKnowledgeBaseNode(manager, source.id), null);
      assert.ok(await getKnowledgeBaseNode(purchaser, source.id));
    });

    await t.test('root file moves freeze all effective restrictions, preserve dormant grants, bytes and event history', async () => {
      for (const mode of ['inherit', 'custom'] as const) {
        const disabled = await actor('manager'), deleted = await actor('purchaser');
        const allowed = [key(manager), key(disabled), key(deleted)].sort();
        const root = await folder(admin, null, acl(manager, purchaser, disabled, deleted));
        const child = await folder(admin, root.id, acl(manager, support, disabled, deleted));
        const upload = { ...fileInput(child.id), access: mode === 'inherit'
          ? { mode: 'inherit' as const, actorKeys: [] } : acl(manager, purchaser, disabled, deleted) };
        const source = (await createKnowledgeBaseFile(admin, upload)).node;
        await recordKnowledgeBaseEvent(manager, { eventId: randomUUID(), nodeId: source.id, action: 'file_view' });
        const before = await row(source.id);
        const events = (await query('select * from knowledge_base_events where node_id=$1 order by id', [source.id])).rows;
        await query('update wholesale_managers set is_active=false where id=$1', [disabled.managerId]);
        await query('delete from admin_users where id=$1', [deleted.adminUserId]);
        const plan = await preview(top, source, null);
        assert.equal(plan.affectedCount, 1); assert.equal(plan.destination, null);
        assert.match(plan.accessWarning, /Файл.*сохранён отдельным списком.*Дополнительные сотрудники доступ не получат/);
        const changed = await moveKnowledgeBaseNode(top, source.id, { expectedRevision: source.revision, targetParentId: null, previewToken: plan.previewToken });
        assert.deepEqual(changed.access, { mode: 'custom', actorKeys: allowed });
        assert.equal(changed.parentId, null); assert.equal(Number(changed.revision), Number(source.revision) + 1);
        assert.deepEqual(immutableRow(await row(source.id)), immutableRow(before));
        assert.deepEqual((await query('select * from knowledge_base_events where node_id=$1 order by id', [source.id])).rows, events);
        assert.equal((await getKnowledgeBaseFileForRead(manager, source.id))?.storagePath, upload.storagePath);
        assert.equal(await getKnowledgeBaseFileForRead(purchaser, source.id), null);
        assert.equal(await getKnowledgeBaseFileForRead(support, source.id), null);
        assert.ok((await listKnowledgeBase(manager)).nodes.some(node => node.id === source.id));
        await query('update wholesale_managers set is_active=true where id=$1', [disabled.managerId]);
        assert.ok(await getKnowledgeBaseFileForRead(disabled, source.id));
        await updateKnowledgeBaseNode(admin, root.id, { expectedRevision: root.revision, access: acl(purchaser) });
        assert.ok(await getKnowledgeBaseFileForRead(manager, source.id));
        assert.equal(await getKnowledgeBaseFileForRead(purchaser, source.id), null);
        await assert.rejects(preview(admin, changed, null), code('SAME_PARENT'));
      }
      const emptyRoot = await folder(admin, null);
      const privateFile = (await createKnowledgeBaseFile(admin, fileInput(emptyRoot.id))).node;
      assert.deepEqual((await move(admin, privateFile, null)).access, { mode: 'custom', actorKeys: [] });
    });

    await t.test('self, descendant, current parent, target file and missing targets fail without changes', async () => {
      const source = await folder(admin, null), child = await folder(admin, source.id);
      const file = (await createKnowledgeBaseFile(admin, fileInput(child.id))).node;
      const before = await Promise.all([source.id, child.id, file.id].map(row));
      for (const [node, destination, expectedCode] of [
        [source, source.id, 'MOVE_CYCLE'], [source, child.id, 'MOVE_CYCLE'], [source, null, 'SAME_PARENT'],
        [child, source.id, 'SAME_PARENT'], [source, file.id, 'NOT_A_FOLDER'],
      ] as const) await assert.rejects(preview(admin, node, destination), code(expectedCode));
      await assert.rejects(preview(admin, child, 99999999), status(404));
      await assert.rejects(previewKnowledgeBaseMove(admin, child.id, { expectedRevision: '0', targetParentId: null }), status(400));
      await assert.rejects(moveKnowledgeBaseNode(admin, child.id, { expectedRevision: child.revision, targetParentId: null, previewToken: 'invalid' }), status(400));
      assert.deepEqual(await Promise.all([source.id, child.id, file.id].map(row)), before);
    });

    await t.test('archived source, ancestor and target paths cannot be moved even by a manager', async () => {
      const left = await folder(admin, null), right = await folder(admin, null);
      let source = await folder(admin, left.id), target = await folder(admin, right.id);
      source = await setKnowledgeBaseArchive(admin, source.id, { expectedRevision: source.revision, archived: true });
      await assert.rejects(preview(admin, source, target.id), status(404));
      source = await setKnowledgeBaseArchive(admin, source.id, { expectedRevision: source.revision, archived: false });
      target = await setKnowledgeBaseArchive(admin, target.id, { expectedRevision: target.revision, archived: true });
      await assert.rejects(preview(admin, source, target.id), status(404));
      target = await setKnowledgeBaseArchive(admin, target.id, { expectedRevision: target.revision, archived: false });
      await setKnowledgeBaseArchive(admin, right.id, { expectedRevision: right.revision, archived: true });
      await assert.rejects(preview(admin, source, target.id), status(404));
      await setKnowledgeBaseArchive(admin, left.id, { expectedRevision: left.revision, archived: true });
      await assert.rejects(preview(admin, source, null), status(404));
    });

    await t.test('depth limit includes archived descendants; files remain allowed under the twelfth folder', async () => {
      let depth11 = await folder(admin, null);
      for (let depth = 2; depth <= 11; depth++) depth11 = await folder(admin, depth11.id);
      const depth12 = await folder(admin, depth11.id);
      const source = await folder(admin, null);
      const archivedChild = await folder(admin, source.id);
      await setKnowledgeBaseArchive(admin, archivedChild.id, { expectedRevision: archivedChild.revision, archived: true });
      await assert.rejects(preview(admin, source, depth11.id), code('MAX_DEPTH'));
      const shallow = await folder(admin, null);
      assert.equal((await move(admin, shallow, depth11.id)).parentId, depth11.id);
      const fileRoot = await folder(admin, null);
      const file = (await createKnowledgeBaseFile(admin, fileInput(fileRoot.id))).node;
      assert.equal((await move(admin, file, depth12.id)).parentId, depth12.id);
      assert.ok(await getKnowledgeBaseFileForRead(admin, file.id));
      const other = await folder(admin, null);
      await assert.rejects(preview(admin, other, depth12.id), code('MAX_DEPTH'));
    });

    await t.test('preview token binds exact actor, source and destination; caller cannot substitute a target', async () => {
      const root = await folder(admin, null), source = await folder(admin, root.id), destination = await folder(admin, null), other = await folder(admin, null);
      const plan = await preview(admin, source, destination.id);
      for (const [session, targetParentId, previewToken] of [[admin, other.id, plan.previewToken], [top, destination.id, plan.previewToken], [admin, destination.id, '0'.repeat(64)]] as const) {
        await assert.rejects(moveKnowledgeBaseNode(session, source.id, { expectedRevision: source.revision, targetParentId, previewToken }), status(409));
      }
      assert.equal((await getKnowledgeBaseNode(admin, source.id))?.parentId, root.id);
    });

    const staleMutations: Array<[string, (nodes: { source: KnowledgeBaseNode; left: KnowledgeBaseNode; right: KnowledgeBaseNode;
      target: KnowledgeBaseNode; descendant: KnowledgeBaseNode }) => Promise<unknown>]> = [
      ['source title', n => updateKnowledgeBaseNode(admin, n.source.id, { expectedRevision: n.source.revision, title: 'Changed source' })],
      ['source ACL', n => updateKnowledgeBaseNode(admin, n.source.id, { expectedRevision: n.source.revision, access: acl(purchaser) })],
      ['source ancestor', n => updateKnowledgeBaseNode(admin, n.left.id, { expectedRevision: n.left.revision, access: acl(purchaser) })],
      ['destination title', n => updateKnowledgeBaseNode(admin, n.target.id, { expectedRevision: n.target.revision, title: 'Changed target' })],
      ['destination ACL', n => updateKnowledgeBaseNode(admin, n.target.id, { expectedRevision: n.target.revision, access: acl(purchaser) })],
      ['destination ancestor', n => updateKnowledgeBaseNode(admin, n.right.id, { expectedRevision: n.right.revision, title: 'Changed ancestor' })],
      ['descendant title', n => updateKnowledgeBaseNode(admin, n.descendant.id, { expectedRevision: n.descendant.revision, title: 'Changed child' })],
      ['descendant raw ACL without parent revision', n => query('insert into knowledge_base_grants(node_id,actor_key) values($1,$2)', [n.descendant.id, key(purchaser)])],
      ['new descendant', n => folder(admin, n.descendant.id)],
      ['archived descendant', n => setKnowledgeBaseArchive(admin, n.descendant.id, { expectedRevision: n.descendant.revision, archived: true })],
      ['archived source ancestor', n => setKnowledgeBaseArchive(admin, n.left.id, { expectedRevision: n.left.revision, archived: true })],
      ['archived destination', n => setKnowledgeBaseArchive(admin, n.target.id, { expectedRevision: n.target.revision, archived: true })],
      ['moved destination ancestor', async n => { const root = await folder(admin, null); return move(admin, n.right, root.id); }],
      ['moved descendant', async n => { const sibling = await folder(admin, n.source.id); return move(admin, n.descendant, sibling.id); }],
    ];
    for (const [name, mutate] of staleMutations) await t.test(`stale ${name} invalidates confirmation without overwriting changes`, async () => {
      const left = await folder(admin, null), right = await folder(admin, null);
      const source = await folder(admin, left.id), target = await folder(admin, right.id), descendant = await folder(admin, source.id);
      const plan = await preview(admin, source, target.id);
      await mutate({ source, left, right, target, descendant });
      const before = await row(source.id);
      await assert.rejects(moveKnowledgeBaseNode(admin, source.id, { expectedRevision: source.revision, targetParentId: target.id, previewToken: plan.previewToken }), status(409));
      assert.deepEqual(await row(source.id), before);
    });

    await t.test('ordinary employees cannot preview or commit; persisted fake/revoked/demoted sessions are denied', async () => {
      const source = await folder(admin, null), target = await folder(admin, null);
      const plan = await preview(admin, source, target.id);
      const input = { expectedRevision: source.revision, targetParentId: target.id, previewToken: plan.previewToken };
      for (const session of [manager, support, purchaser, wholesale]) {
        await assert.rejects(previewKnowledgeBaseMove(session, source.id, input), status(403));
        await assert.rejects(moveKnowledgeBaseNode(session, source.id, input), status(403));
      }
      const revoked = await actor('top'), demoted = await actor('top'), disabled = await actor('top');
      await query('update admin_sessions set revoked_at=clock_timestamp() where id=$1', [revoked.sessionId]);
      await query("update admin_users set role='purchaser' where id=$1", [demoted.adminUserId]);
      await query('update admin_users set is_active=false where id=$1', [disabled.adminUserId]);
      for (const session of [{ ...manager, role: 'top' as const }, { ...top, sessionId: randomUUID() }, revoked, demoted, disabled]) {
        await assert.rejects(previewKnowledgeBaseMove(session, source.id, input), status(401));
        await assert.rejects(moveKnowledgeBaseNode(session, source.id, input), status(401));
      }
    });

    await t.test('concurrent identical commits are single mutation; concurrent reciprocal moves cannot form a cycle', async () => {
      const source = await folder(admin, null), target = await folder(admin, null);
      const plan = await preview(admin, source, target.id);
      const input = { expectedRevision: source.revision, targetParentId: target.id, previewToken: plan.previewToken };
      const results = await Promise.allSettled([moveKnowledgeBaseNode(admin, source.id, input), moveKnowledgeBaseNode(admin, source.id, input)]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter(result => result.status === 'rejected' && status(409)(result.reason)).length, 1);
      assert.equal((await getKnowledgeBaseNode(admin, source.id))?.revision, '2');
      const a = await folder(admin, null), b = await folder(admin, null);
      const pa = await preview(admin, a, b.id), pb = await preview(admin, b, a.id);
      const reciprocal = await Promise.allSettled([
        moveKnowledgeBaseNode(admin, a.id, { expectedRevision: a.revision, targetParentId: b.id, previewToken: pa.previewToken }),
        moveKnowledgeBaseNode(admin, b.id, { expectedRevision: b.revision, targetParentId: a.id, previewToken: pb.previewToken }),
      ]);
      assert.equal(reciprocal.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(reciprocal.filter(result => result.status === 'rejected' && status(409)(result.reason)).length, 1);
      assert.ok(await getKnowledgeBaseNode(admin, a.id)); assert.ok(await getKnowledgeBaseNode(admin, b.id));
    });

    await t.test('tree lock serializes waiting move after an ACL change', async () => {
      const source = await folder(admin, null), destination = await folder(admin, null);
      const plan = await preview(top, source, destination.id);
      let ready!: () => void, release!: () => void;
      const locked = new Promise<void>(resolve => { ready = resolve; }), proceed = new Promise<void>(resolve => { release = resolve; });
      const blocker = withTransaction(async client => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [KNOWLEDGE_BASE_LOCK]);
        await client.query('update knowledge_base_nodes set revision=revision+1 where id=$1', [destination.id]);
        ready(); await proceed;
      });
      await locked;
      const waiting = moveKnowledgeBaseNode(top, source.id, { expectedRevision: source.revision, targetParentId: destination.id, previewToken: plan.previewToken });
      // Attach rejection immediately; the DB operation itself is waiting on the held tree lock.
      const denied = assert.rejects(waiting, status(409));
      release(); await blocker; await denied;
      assert.equal((await getKnowledgeBaseNode(admin, source.id))?.parentId, null);
    });

    await t.test('session revoked while move waits for the tree lock is rechecked before mutation', async () => {
      const temporary = await actor('top'), source = await folder(admin, null), target = await folder(admin, null);
      const plan = await preview(temporary, source, target.id);
      let ready!: () => void, release!: () => void;
      const locked = new Promise<void>(resolve => { ready = resolve; }), proceed = new Promise<void>(resolve => { release = resolve; });
      const blocker = withTransaction(async client => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [KNOWLEDGE_BASE_LOCK]);
        ready(); await proceed;
      });
      await locked;
      const denied = assert.rejects(moveKnowledgeBaseNode(temporary, source.id,
        { expectedRevision: source.revision, targetParentId: target.id, previewToken: plan.previewToken }), status(401));
      await query('update admin_sessions set revoked_at=clock_timestamp() where id=$1', [temporary.sessionId]);
      release(); await blocker; await denied;
      assert.equal((await getKnowledgeBaseNode(admin, source.id))?.parentId, null);
    });

    await t.test('transaction failure after ACL materialization rolls back parent, revision and grants together', async () => {
      const root = await folder(admin, null, acl(manager, purchaser)), source = await folder(admin, root.id);
      const plan = await preview(admin, source, null), before = await row(source.id);
      // A deferred test trigger fails at COMMIT, after parent and grants have both been written.
      await query(`create function kb_move_synthetic_fail() returns trigger language plpgsql as $$ begin
        if new.id=${source.id} and new.parent_id is null then raise exception 'synthetic move failure'; end if;
        return new; end $$`);
      await query(`create constraint trigger kb_move_synthetic_failure after update on knowledge_base_nodes
        deferrable initially deferred for each row execute function kb_move_synthetic_fail()`);
      try {
        await assert.rejects(moveKnowledgeBaseNode(admin, source.id, { expectedRevision: source.revision, targetParentId: null, previewToken: plan.previewToken }));
        assert.deepEqual(await row(source.id), before);
        assert.equal((await query('select count(*)::int as n from knowledge_base_grants where node_id=$1', [source.id])).rows[0].n, 0);
      } finally {
        await query('drop trigger kb_move_synthetic_failure on knowledge_base_nodes');
        await query('drop function kb_move_synthetic_fail()');
      }
      assert.deepEqual((await move(admin, source, null)).access, acl(manager, purchaser));
    });

    await t.test('corrupt cycle or too-deep subtree fails closed rather than silently truncating', async () => {
      const root = await folder(admin, null), child = await folder(admin, root.id), destination = await folder(admin, null);
      await query('update knowledge_base_nodes set parent_id=$2 where id=$1', [root.id, child.id]);
      await assert.rejects(preview(admin, root, destination.id), status(404));
      await query('update knowledge_base_nodes set parent_id=null where id=$1', [root.id]);
      let parent = child.id;
      for (let depth = 3; depth <= 14; depth++) {
        parent = Number((await query(`insert into knowledge_base_nodes(parent_id,kind,title,acl_mode,created_by,operation_id,operation_digest)
          values($1,'folder','Synthetic corrupt depth','inherit',$2,$3::uuid,$4) returning id`, [parent, key(admin), randomUUID(), 'c'.repeat(64)])).rows[0].id);
      }
      await assert.rejects(preview(admin, root, destination.id), code('INVALID_TREE'));
    });

    await t.test('large breadth is explicitly rejected and never silently moved in part', async () => {
      const source = await folder(admin, null), destination = await folder(admin, null);
      await query(`insert into knowledge_base_nodes(parent_id,kind,title,acl_mode,created_by,operation_id,operation_digest)
        select $1,'folder','Synthetic broad tree '||i,'inherit',$2,gen_random_uuid(),$3 from generate_series(1,10000) i`,
      [source.id, key(admin), 'd'.repeat(64)]);
      await assert.rejects(preview(admin, source, destination.id), code('MOVE_TOO_LARGE'));
      assert.equal((await row(source.id)).parent_id, null);
      assert.equal((await query('select count(*)::int as n from knowledge_base_nodes where parent_id=$1', [source.id])).rows[0].n, 10000);
    });
  } finally { await globalThis.__ktsPgPool?.end(); }
});
