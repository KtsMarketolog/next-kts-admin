import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AdminSession, AdminSessionRole } from '../src/shared/lib/adminAuth';
import { knowledgeBaseActorKey, type KnowledgeBaseNode } from '../src/shared/lib/knowledgeBase';
import { query, withTransaction } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { createTrustedAdminSession } from '../src/shared/lib/db/adminSessionsRepo';
import { createKnowledgeBaseFile, createKnowledgeBaseFolder, getKnowledgeBaseFileForRead, getKnowledgeBaseNode,
  listKnowledgeBase, listKnowledgeBaseActors, listKnowledgeBaseStats, recordKnowledgeBaseEvent,
  setKnowledgeBaseArchive, updateKnowledgeBaseNode } from '../src/shared/lib/db/knowledgeBaseRepo';
import { KNOWLEDGE_BASE_LOCK } from '../src/shared/lib/db/knowledgeBaseRepo.shared';
import { applyKnowledgeBaseMigration } from '../src/shared/lib/db/knowledgeBaseMigration';
import { applyKnowledgeBaseRootFilesMigration } from '../src/shared/lib/db/knowledgeBaseRootFilesMigration';

function guard() {
  assert.equal(process.env.KTS_KNOWLEDGE_BASE_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, 'localhost'); assert.equal(url.username, 'kb_app');
  assert.equal(url.pathname, '/kts_knowledge_base_integration'); assert.equal(url.password, '');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['host', 'port']);
  assert.equal(url.searchParams.get('port'), '55489');
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-knowledge-base-postgres\.[A-Za-z0-9]+\/socket$/);
}
let seq = 0;
async function actor(role: AdminSessionRole): Promise<AdminSession> {
  const table = role === 'manager' || role === 'support_manager' ? 'wholesale_managers' : 'admin_users';
  const inserted = await query<{ id: string }>(`insert into ${table}(login,email,name,role) values($1,$2,$3,$4) returning id::text`,
    [`kb-${++seq}`, `kb-${seq}@synthetic.test`, `KB employee ${seq}`, role]);
  const id = Number(inserted.rows[0].id);
  const identity = table === 'wholesale_managers' ? { managerId: id } : { adminUserId: id };
  const stored = await createTrustedAdminSession({ role, ...identity });
  return { role, ...identity, sessionId: stored.sessionId };
}
const status = (expected: number) => (error: unknown) => (error as { status?: number }).status === expected;
const folderInput = (parentId: number | null, title = `Folder ${++seq}`) => ({ parentId, title, operationId: randomUUID() });
const fileInput = (parentId: number | null) => ({ ...folderInput(parentId, 'Guide'), parentId, originalName: 'guide.pdf', mimeType: 'application/pdf',
  size: 100, storagePath: `knowledge-base/${randomUUID()}.pdf`, sha256: 'a'.repeat(64) });
function safeDto(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), /storagePath|storage_path|operation_digest|session_hash|password|@synthetic|"sha256"/);
}

test('knowledge base real PostgreSQL permissions, conflicts, retry and accounting', { timeout: 180_000 }, async t => {
  guard();
  try {
    await ensureSiteSchema();
    const admin = await actor('admin'), admintop = await actor('admintop'), top = await actor('top');
    const manager = await actor('manager'), support = await actor('support_manager'), purchaser = await actor('purchaser'), wholesale = await actor('wholesale_admin');
    const employees = [manager, support, purchaser, wholesale];
    let root: KnowledgeBaseNode = (await createKnowledgeBaseFolder(admin, folderInput(null, 'Knowledge root'))).node;
    const child = (await createKnowledgeBaseFolder(admin, folderInput(root.id, 'Team folder'))).node;
    const file = (await createKnowledgeBaseFile(admin, fileInput(child.id))).node;

    await t.test('additive root migration finds the legacy rule by meaning and preserves old files, grants, history and other checks', async () => {
      const rollback = new Error('rollback synthetic legacy migration fixture');
      await assert.rejects(withTransaction(async client => {
        // All fixture DDL/data is transaction-local and rolled back; public application rows are never touched.
        await client.query('create schema kb_root_files_migration_fixture');
        await client.query('set local search_path to kb_root_files_migration_fixture,pg_catalog');
        await applyKnowledgeBaseMigration(client);
        const oldRoot = await client.query<{ id: string }>(`insert into knowledge_base_nodes
          (kind,title,acl_mode,created_by,operation_id,operation_digest) values ('folder','Legacy root','custom','admin:1',$1,$2) returning id::text`,
        [randomUUID(), 'a'.repeat(64)]);
        const insertFile = (parentId: string | null, mode = 'inherit') => client.query<{ id: string }>(`insert into knowledge_base_nodes
          (parent_id,kind,title,acl_mode,original_name,mime_type,file_size,storage_path,sha256,created_by,operation_id,operation_digest)
          values($1,'file','Existing guide',$2,'guide.pdf','application/pdf',100,'knowledge-base/legacy.pdf',$3,'admin:1',$4,$3) returning id::text`,
        [parentId, mode, 'a'.repeat(64), randomUUID()]);
        const oldFile = await insertFile(oldRoot.rows[0].id);
        await client.query("insert into knowledge_base_grants(node_id,actor_key) values($1,'manager:1')", [oldRoot.rows[0].id]);
        await client.query(`insert into knowledge_base_events(actor_key,actor_role,event_id,node_id,action)
          values('manager:1','manager',$1,$2,'file_view')`, [randomUUID(), oldFile.rows[0].id]);
        const snapshot = async () => (await client.query(`select
          (select jsonb_agg(to_jsonb(n) order by id) from knowledge_base_nodes n) as nodes,
          (select jsonb_agg(to_jsonb(g) order by node_id,actor_key) from knowledge_base_grants g) as grants,
          (select jsonb_agg(to_jsonb(e) order by id) from knowledge_base_events e) as events`)).rows[0];
        await client.query('savepoint rejected_legacy_root');
        await assert.rejects(insertFile(null, 'custom'), (error: unknown) => (error as { code: string }).code === '23514');
        await client.query('rollback to savepoint rejected_legacy_root');
        const oldCheck = (await client.query<{ name: string }>(`select conname as name from pg_constraint
          where conrelid='knowledge_base_nodes'::regclass and contype='c'
            and pg_get_expr(conbin,conrelid) like '%parent_id%folder%custom%'`)).rows;
        assert.equal(oldCheck.length, 1);
        const oldIdentifier = '"' + oldCheck[0].name.replace(/"/g, '""') + '"';
        await client.query(`alter table knowledge_base_nodes rename constraint ${oldIdentifier} to renamed_legacy_root_check`);
        await client.query(`alter table knowledge_base_nodes drop constraint renamed_legacy_root_check,
          add constraint differently_grouped_root_check check ((parent_id is not null or kind='folder') and acl_mode='custom') not valid`);
        const constraintSnapshot = async () => (await client.query(`select conname,pg_get_expr(conbin,conrelid) as expression
          from pg_constraint where conrelid='knowledge_base_nodes'::regclass order by conname`)).rows;
        const unknownChecks = await constraintSnapshot();
        await assert.rejects(applyKnowledgeBaseRootFilesMigration(client), /Unexpected knowledge base root constraint/);
        assert.deepEqual(await constraintSnapshot(), unknownChecks, 'unknown grouping must fail before changing any constraint');
        await client.query(`alter table knowledge_base_nodes drop constraint differently_grouped_root_check,
          add constraint renamed_legacy_root_check check (parent_id is not null or (kind='folder' and acl_mode='custom'))`);
        const otherChecks = (await client.query<{ name: string }>(`select conname as name from pg_constraint
          where conrelid='knowledge_base_nodes'::regclass and contype='c' and conname<>'renamed_legacy_root_check' order by conname`)).rows;
        const before = await snapshot();
        await applyKnowledgeBaseRootFilesMigration(client);
        await applyKnowledgeBaseRootFilesMigration(client);
        assert.deepEqual(await snapshot(), before);
        assert.deepEqual((await client.query(`select conname as name from pg_constraint where conrelid='knowledge_base_nodes'::regclass
          and contype='c' and conname<>'knowledge_base_nodes_root_access_check' order by conname`)).rows, otherChecks);
        assert.equal((await insertFile(null, 'custom')).rows.length, 1);
        await client.query('savepoint rejected_new_root');
        await assert.rejects(insertFile(null), (error: unknown) => (error as { code: string }).code === '23514');
        await client.query('rollback to savepoint rejected_new_root');
        throw rollback;
      }), (error: unknown) => error === rollback);
    });

    await t.test('private by default for ordinary employees; admin, admintop and top manage without grants', async () => {
      assert.deepEqual((await listKnowledgeBase(purchaser)).nodes, []);
      for (const supervisor of [admin, admintop, top]) {
        assert.equal((await listKnowledgeBase(supervisor)).canManage, true);
        assert.equal((await getKnowledgeBaseNode(supervisor, file.id))?.id, file.id);
        assert.deepEqual((await getKnowledgeBaseNode(supervisor, root.id))?.access?.actorKeys, []);
      }
      for (const session of employees) {
        assert.equal(await getKnowledgeBaseNode(session, file.id), null);
        await assert.rejects(createKnowledgeBaseFolder(session, folderInput(null)), status(403));
        await assert.rejects(listKnowledgeBaseActors(session), status(403));
        await assert.rejects(listKnowledgeBaseStats(session, { view: 'materials' }), status(403));
      }
      assert.equal((await getKnowledgeBaseNode(admintop, file.id))?.id, file.id);
      root = await updateKnowledgeBaseNode(admintop, root.id, { expectedRevision: root.revision,
        access: { mode: 'custom', actorKeys: employees.map(knowledgeBaseActorKey) } });
      for (const session of employees) {
        const listed = await listKnowledgeBase(session, { parentId: child.id });
        assert.equal(listed.nodes[0].id, file.id); assert.equal(listed.breadcrumbs.length, 2);
        assert.equal(listed.nodes[0].access, undefined); safeDto(listed);
        assert.equal((await getKnowledgeBaseFileForRead(session, file.id))?.node.id, file.id);
        assert.equal(listed.canManage, false);
        await assert.rejects(createKnowledgeBaseFile(session, fileInput(child.id)), status(403));
        await assert.rejects(updateKnowledgeBaseNode(session, root.id, { expectedRevision: root.revision, title: 'Denied edit' }), status(403));
        await assert.rejects(setKnowledgeBaseArchive(session, root.id, { expectedRevision: root.revision, archived: true }), status(403));
        await assert.rejects(createKnowledgeBaseFolder({ ...session, canManageTopDashboard: true }, folderInput(null)), status(403));
      }
      safeDto(root);
    });

    await t.test('every ancestor custom ACL intersects descendants; direct IDs and breadcrumbs do not bypass revocation', async () => {
      let scoped = await updateKnowledgeBaseNode(admin, child.id, { expectedRevision: child.revision,
        access: { mode: 'custom', actorKeys: [knowledgeBaseActorKey(manager)] } });
      assert.equal(await getKnowledgeBaseNode(purchaser, file.id), null);
      await assert.rejects(listKnowledgeBase(purchaser, { parentId: child.id }), status(404));
      assert.ok(await getKnowledgeBaseFileForRead(top, file.id), 'TOP manages despite a restrictive child ACL');
      assert.ok(await getKnowledgeBaseFileForRead(manager, file.id));
      root = await updateKnowledgeBaseNode(admin, root.id, { expectedRevision: root.revision,
        access: { mode: 'custom', actorKeys: [knowledgeBaseActorKey(purchaser)] } });
      assert.equal(await getKnowledgeBaseFileForRead(manager, file.id), null);
      scoped = await updateKnowledgeBaseNode(admin, child.id, { expectedRevision: scoped.revision, access: { mode: 'inherit', actorKeys: [] } });
      assert.ok(scoped); assert.ok(await getKnowledgeBaseFileForRead(purchaser, file.id));
      root = await updateKnowledgeBaseNode(admin, root.id, { expectedRevision: root.revision,
        access: { mode: 'custom', actorKeys: employees.map(knowledgeBaseActorKey) } });
    });

    await t.test('persisted session recheck rejects forgery, revocation, role changes and disabled accounts', async () => {
      await assert.rejects(listKnowledgeBase({ ...manager, role: 'admin' }), status(401));
      await assert.rejects(listKnowledgeBase({ ...top, sessionId: randomUUID() }), status(401));
      const temporary = await actor('top');
      await query('update admin_users set is_active=false where id=$1', [temporary.adminUserId]);
      await assert.rejects(listKnowledgeBase(temporary), status(401));
      await query('update admin_users set is_active=true,role=\'purchaser\' where id=$1', [temporary.adminUserId]);
      await assert.rejects(listKnowledgeBase(temporary), status(401));
      const other = await actor('manager');
      await query('update admin_sessions set revoked_at=now() where id=$1', [other.sessionId]);
      await assert.rejects(listKnowledgeBase(other), status(401));
      const changed = await actor('manager');
      await query('update wholesale_managers set password_changed_at=clock_timestamp() where id=$1', [changed.managerId]);
      await assert.rejects(listKnowledgeBase(changed), status(401));
    });

    await t.test('same UUID is idempotent with immutable content; concurrent create produces one row', async () => {
      const input = fileInput(child.id);
      const results = await Promise.all([createKnowledgeBaseFile(admin, input), createKnowledgeBaseFile(admin, { ...input, storagePath: `knowledge-base/${randomUUID()}.pdf` })]);
      assert.equal(results.filter(x => x.created).length, 1); assert.equal(results[0].node.id, results[1].node.id);
      for (const delta of [{ title: 'Other' }, { sha256: 'b'.repeat(64) }, { originalName: 'other.pdf' }, { size: 101 }]) {
        await assert.rejects(createKnowledgeBaseFile(admin, { ...input, ...delta }), status(409));
      }
      assert.equal((await query('select count(*)::int as n from knowledge_base_nodes where operation_id=$1', [input.operationId])).rows[0].n, 1);
      assert.equal((await getKnowledgeBaseFileForRead(admin, results[0].node.id))?.storagePath, input.storagePath);
      const folder = folderInput(child.id); const first = await createKnowledgeBaseFolder(admin, folder);
      assert.equal((await createKnowledgeBaseFolder(admin, folder)).node.id, first.node.id);
    });

    await t.test('concurrent stale edits cannot overwrite title or access; failed grant update rolls back', async () => {
      const fresh = (await createKnowledgeBaseFolder(admin, folderInput(root.id))).node;
      const results = await Promise.allSettled([
        updateKnowledgeBaseNode(admin, fresh.id, { expectedRevision: fresh.revision, title: 'First' }),
        updateKnowledgeBaseNode(admintop, fresh.id, { expectedRevision: fresh.revision, title: 'Second' }),
      ]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.filter(r => r.status === 'rejected' && status(409)(r.reason)).length, 1);
      const before = await getKnowledgeBaseNode(admin, fresh.id);
      await assert.rejects(updateKnowledgeBaseNode(admin, fresh.id, { expectedRevision: before!.revision, title: 'Not saved',
        access: { mode: 'custom', actorKeys: ['admin:9999999'] } }), status(400));
      assert.deepEqual(await getKnowledgeBaseNode(admin, fresh.id), before);
    });

    await t.test('editing preserves previous disabled/deleted grantees but never adds a new inactive recipient', async () => {
      const disabled = await actor('manager'), deleted = await actor('top'), newlyDisabled = await actor('purchaser');
      const oldKeys = [knowledgeBaseActorKey(disabled), knowledgeBaseActorKey(deleted)].sort();
      let node = (await createKnowledgeBaseFolder(admin, { ...folderInput(null), access: { mode: 'custom', actorKeys: oldKeys } })).node;
      await query('update wholesale_managers set is_active=false where id=$1', [disabled.managerId]);
      await query('delete from admin_users where id=$1', [deleted.adminUserId]);
      await query('update admin_users set is_active=false where id=$1', [newlyDisabled.adminUserId]);
      node = await updateKnowledgeBaseNode(admin, node.id, { expectedRevision: node.revision, title: 'Renamed with prior grants', access: node.access });
      assert.deepEqual(node.access?.actorKeys, oldKeys);
      node = await updateKnowledgeBaseNode(admin, node.id, { expectedRevision: node.revision, access: { mode: 'custom', actorKeys: [...oldKeys, knowledgeBaseActorKey(purchaser)] } });
      assert.ok(await getKnowledgeBaseNode(purchaser, node.id));
      await assert.rejects(getKnowledgeBaseNode(disabled, node.id), status(401));
      await assert.rejects(getKnowledgeBaseNode(deleted, node.id), status(401));
      await assert.rejects(updateKnowledgeBaseNode(admin, node.id, { expectedRevision: node.revision,
        access: { mode: 'custom', actorKeys: [...node.access!.actorKeys, knowledgeBaseActorKey(newlyDisabled)] } }), status(400));
      node = await updateKnowledgeBaseNode(admin, node.id, { expectedRevision: node.revision, access: { mode: 'custom', actorKeys: [knowledgeBaseActorKey(purchaser)] } });
      assert.deepEqual(node.access?.actorKeys, [knowledgeBaseActorKey(purchaser)]);
      await assert.rejects(updateKnowledgeBaseNode(admin, node.id, { expectedRevision: node.revision,
        access: { mode: 'custom', actorKeys: oldKeys } }), status(400), 'once removed a disabled recipient cannot be re-added');
    });

    await t.test('archive hides entire subtree including direct file endpoint; restoration never deletes files or child data', async () => {
      const before = (await query('select row_to_json(n) as row from knowledge_base_nodes n where id=$1', [file.id])).rows[0].row;
      root = await setKnowledgeBaseArchive(admin, root.id, { expectedRevision: root.revision, archived: true });
      assert.equal(await getKnowledgeBaseFileForRead(admin, file.id), null);
      assert.equal(await getKnowledgeBaseNode(top, file.id), null);
      assert.equal((await listKnowledgeBase(admin, { archived: true })).nodes.some(n => n.id === root.id), true);
      assert.equal((await listKnowledgeBase(top, { archived: true })).nodes.some(n => n.id === root.id), true);
      await assert.rejects(listKnowledgeBase(purchaser, { archived: true }), status(403));
      await assert.rejects(listKnowledgeBase(admin, { parentId: root.id }), status(404));
      await assert.rejects(setKnowledgeBaseArchive(admin, file.id, { expectedRevision: file.revision, archived: false }), status(409));
      root = await setKnowledgeBaseArchive(admin, root.id, { expectedRevision: root.revision, archived: false });
      assert.ok(await getKnowledgeBaseFileForRead(top, file.id));
      assert.deepEqual((await query('select row_to_json(n) as row from knowledge_base_nodes n where id=$1', [file.id])).rows[0].row, before);
    });

    await t.test('root files are private by default, explicit recipients work and retries keep the original bytes', async () => {
      for (const supervisor of [admin, admintop, top]) {
        const input = fileInput(null);
        const created = await createKnowledgeBaseFile(supervisor, input);
        assert.equal(created.node.parentId, null); assert.equal(created.node.kind, 'file');
        assert.deepEqual(created.node.access, { mode: 'custom', actorKeys: [] });
        assert.equal(await getKnowledgeBaseFileForRead(manager, created.node.id), null);
        const retried = await createKnowledgeBaseFile(supervisor, { ...input, storagePath: `knowledge-base/${randomUUID()}.pdf` });
        assert.equal(retried.created, false); assert.equal(retried.node.id, created.node.id);
        assert.equal((await getKnowledgeBaseFileForRead(supervisor, created.node.id))?.storagePath, input.storagePath);
      }
      const granted = (await createKnowledgeBaseFile(admin, { ...fileInput(null),
        access: { mode: 'custom', actorKeys: [knowledgeBaseActorKey(manager)] } })).node;
      assert.ok((await listKnowledgeBase(manager)).nodes.some(node => node.id === granted.id));
      assert.ok(await getKnowledgeBaseFileForRead(manager, granted.id));
      assert.equal(await getKnowledgeBaseFileForRead(support, granted.id), null);
      for (const employee of employees) await assert.rejects(createKnowledgeBaseFile(employee, fileInput(null)), status(403));
      await assert.rejects(createKnowledgeBaseFile(admin, { ...fileInput(null), access: { mode: 'inherit', actorKeys: [] } }), status(400));
      await assert.rejects(updateKnowledgeBaseNode(admin, granted.id, { expectedRevision: granted.revision,
        access: { mode: 'inherit', actorKeys: [] } }), status(400));
      await assert.rejects(query("update knowledge_base_nodes set acl_mode='inherit' where id=$1", [granted.id]),
        (error: unknown) => (error as { code: string }).code === '23514', 'DB still prevents unscoped root inheritance');
    });

    await t.test('folder depth, oversize metadata and malformed inputs are rejected without writes', async () => {
      let deep = (await createKnowledgeBaseFolder(admin, folderInput(null))).node;
      for (let level = 2; level <= 12; level++) deep = (await createKnowledgeBaseFolder(admin, folderInput(deep.id))).node;
      await assert.rejects(createKnowledgeBaseFolder(admin, folderInput(deep.id)), status(400));
      const leaf = await createKnowledgeBaseFile(admin, fileInput(deep.id));
      assert.ok(await getKnowledgeBaseFileForRead(admin, leaf.node.id));
      await assert.rejects(createKnowledgeBaseFolder(admin, folderInput(leaf.node.id)), status(404));
      await assert.rejects(createKnowledgeBaseFile(admin, { ...fileInput(root.id), parentId: 0 }), status(400));
      await assert.rejects(createKnowledgeBaseFile(admin, { ...fileInput(root.id), size: 25 * 1024 * 1024 + 1 }), status(400));
      await assert.rejects(createKnowledgeBaseFile(admin, { ...fileInput(root.id), storagePath: '../secret.pdf' }), status(400));
    });

    await t.test('pages are bounded and search literal, directory does not reveal email/login', async () => {
      const listParent = (await createKnowledgeBaseFolder(admin, folderInput(root.id))).node;
      for (let i = 0; i < 52; i++) await createKnowledgeBaseFolder(admin, folderInput(listParent.id, `Page ${i}`));
      const special = (await createKnowledgeBaseFolder(admin, folderInput(listParent.id, 'Literal %_ match'))).node;
      const first = await listKnowledgeBase(admin, { parentId: listParent.id }); assert.equal(first.nodes.length, 50); assert.ok(first.nextCursor);
      const second = await listKnowledgeBase(admin, { parentId: listParent.id, after: first.nextCursor! });
      assert.equal(second.nodes.length, 3); assert.equal(second.nextCursor, null);
      assert.equal(new Set([...first.nodes, ...second.nodes].map(n => n.id)).size, 53);
      assert.deepEqual((await listKnowledgeBase(admin, { parentId: listParent.id, search: '%_' })).nodes.map(n => n.id), [special.id]);
      const directory = await listKnowledgeBaseActors(admin); safeDto(directory);
      assert.ok(directory.actors.some(a => a.actorKey === knowledgeBaseActorKey(manager)));
      assert.ok(directory.actors.every(a => Object.keys(a).sort().join(',') === 'actorKey,actorName,actorRole'));
    });

    await t.test('events idempotent per actor, kind checked, denied access cannot be logged, aggregates filter exact employee/material', async () => {
      const eventId = randomUUID();
      const input = { eventId, nodeId: file.id, action: 'file_view' as const };
      const results = await Promise.all([recordKnowledgeBaseEvent(top, input), recordKnowledgeBaseEvent(top, input)]);
      assert.equal(results.filter(r => r.recorded).length, 1);
      await assert.rejects(recordKnowledgeBaseEvent(top, { ...input, action: 'download_started' }), status(409));
      await assert.rejects(recordKnowledgeBaseEvent(top, { eventId: randomUUID(), nodeId: file.id, action: 'folder_open' }), status(400));
      const managerEventId = randomUUID();
      await recordKnowledgeBaseEvent(manager, { ...input, eventId: managerEventId });
      await recordKnowledgeBaseEvent(top, { eventId: randomUUID(), nodeId: null, action: 'section_open' });
      await recordKnowledgeBaseEvent(top, { eventId: randomUUID(), nodeId: child.id, action: 'folder_open' });
      await recordKnowledgeBaseEvent(top, { eventId: randomUUID(), nodeId: file.id, action: 'download_started' });
      const perPerson = await listKnowledgeBaseStats(admin, { view: 'employees', nodeId: file.id });
      assert.equal(perPerson.rows.length, 2); assert.equal(perPerson.rows.find(r => r.key === knowledgeBaseActorKey(top))?.totalEvents, 2);
      const perFile = await listKnowledgeBaseStats(admin, { view: 'materials', actorKey: knowledgeBaseActorKey(top) });
      assert.equal(perFile.rows.find(r => r.key === String(file.id))?.fileViews, 1);
      assert.equal(perFile.rows.find(r => r.key === 'root')?.sectionOpens, 1);
      safeDto(perPerson); safeDto(perFile);
      root = await updateKnowledgeBaseNode(admin, root.id, { expectedRevision: root.revision, access: { mode: 'custom', actorKeys: [] } });
      await assert.rejects(recordKnowledgeBaseEvent(manager, { ...input, eventId: randomUUID() }), status(404));
      await assert.rejects(recordKnowledgeBaseEvent(manager, { ...input, eventId: managerEventId }), status(404), 'even idempotent replay rechecks current access');
      assert.ok(await getKnowledgeBaseFileForRead(top, file.id), 'revoking per-person grants does not revoke TOP management');
    });

    await t.test('ACL mutation and event share a lock; an event waiting behind revocation is denied after commit', async () => {
      root = await updateKnowledgeBaseNode(admin, root.id, { expectedRevision: root.revision, access: { mode: 'custom', actorKeys: [knowledgeBaseActorKey(purchaser)] } });
      let ready!: () => void, release!: () => void;
      const locked = new Promise<void>(resolve => { ready = resolve; }); const proceed = new Promise<void>(resolve => { release = resolve; });
      const mutation = withTransaction(async client => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [KNOWLEDGE_BASE_LOCK]);
        await client.query('delete from knowledge_base_grants where node_id=$1', [root.id]); ready(); await proceed;
      });
      await locked;
      const event = recordKnowledgeBaseEvent(purchaser, { eventId: randomUUID(), nodeId: file.id, action: 'file_view' });
      const denied = assert.rejects(event, status(404));
      release(); await mutation; await denied;
    });

    await t.test('directory/statistics keyset pages cover the full set and retain deleted-actor history without PII', async () => {
      const initial = (await listKnowledgeBaseActors(admin)).actors;
      for (let i = 0; i < 52; i++) {
        const employee = await actor('manager');
        await recordKnowledgeBaseEvent(employee, { eventId: randomUUID(), nodeId: null, action: 'section_open' });
      }
      let directoryCursor: string | undefined;
      const directoryKeys: string[] = [];
      do {
        const page = await listKnowledgeBaseActors(admin, { after: directoryCursor }); safeDto(page);
        assert.ok(page.actors.length <= 50); directoryKeys.push(...page.actors.map(a => a.actorKey));
        directoryCursor = page.nextCursor ?? undefined;
      } while (directoryCursor);
      assert.equal(new Set(directoryKeys).size, directoryKeys.length);
      assert.equal(directoryKeys.length, initial.length + 52);
      const first = await listKnowledgeBaseStats(admin, { view: 'employees' });
      assert.equal(first.rows.length, 50); assert.ok(first.nextCursor);
      const next = await listKnowledgeBaseStats(admin, { view: 'employees', after: first.nextCursor! });
      assert.equal(next.rows.length, 4); assert.equal(next.nextCursor, null);
      assert.equal(new Set([...first.rows, ...next.rows].map(r => r.key)).size, 54);
      const materialRows = (await query<{ id: string }>('select id::text from knowledge_base_nodes where archived_at is null order by knowledge_base_nodes.id limit 52')).rows;
      for (const row of materialRows) {
        const node = await getKnowledgeBaseNode(admin, Number(row.id));
        await recordKnowledgeBaseEvent(admin, { eventId: randomUUID(), nodeId: node!.id, action: node!.kind === 'folder' ? 'folder_open' : 'file_view' });
      }
      const materials = await listKnowledgeBaseStats(admin, { view: 'materials' });
      assert.equal(materials.rows.length, 50); assert.ok(materials.nextCursor);
      const materialsNext = await listKnowledgeBaseStats(admin, { view: 'materials', after: materials.nextCursor! });
      assert.equal(materialsNext.nextCursor, null);
      assert.equal(new Set([...materials.rows, ...materialsNext.rows].map(r => r.key)).size, 53);
      const removed = await actor('manager');
      await recordKnowledgeBaseEvent(removed, { eventId: randomUUID(), nodeId: null, action: 'section_open' });
      await query('delete from wholesale_managers where id=$1', [removed.managerId]);
      const historical = await listKnowledgeBaseStats(admin, { view: 'employees', actorKey: knowledgeBaseActorKey(removed) });
      assert.equal(historical.rows[0].title, knowledgeBaseActorKey(removed));
      assert.equal(historical.rows[0].role, 'manager'); assert.equal(historical.rows[0].totalEvents, 1); safeDto(historical);
      const env = await createTrustedAdminSession({ role: 'admin' });
      const primary: AdminSession = { role: 'admin', sessionId: env.sessionId };
      assert.ok((await listKnowledgeBase(primary)).canManage);
      await recordKnowledgeBaseEvent(primary, { eventId: randomUUID(), nodeId: null, action: 'section_open' });
      assert.equal((await listKnowledgeBaseStats(primary, { view: 'employees', actorKey: 'admin:primary' })).rows[0].title, 'Основной администратор');
    });

    await t.test('statistics page limits identities, not events, and name search runs before pagination', async () => {
      const before = (await listKnowledgeBaseStats(admin, { view: 'materials', actorKey: knowledgeBaseActorKey(top), nodeId: file.id })).rows[0];
      await query(`insert into knowledge_base_events(actor_key,actor_role,event_id,node_id,action)
        select $1,'top',md5('synthetic-bulk-'||value::text)::uuid,$2,'file_view' from generate_series(1,5000) value`, [knowledgeBaseActorKey(top), file.id]);
      const after = (await listKnowledgeBaseStats(admin, { view: 'materials', actorKey: knowledgeBaseActorKey(top), nodeId: file.id })).rows[0];
      assert.equal(after.fileViews, before.fileViews + 5000); assert.equal(after.totalEvents, before.totalEvents + 5000);
      assert.equal(after.downloadsStarted, before.downloadsStarted);
      const last = await actor('manager');
      await query("update wholesale_managers set name='Unique %_ Search Target' where id=$1", [last.managerId]);
      await recordKnowledgeBaseEvent(last, { eventId: randomUUID(), nodeId: null, action: 'section_open' });
      const matching = await listKnowledgeBaseStats(admin, { view: 'employees', search: '%_ Search' });
      assert.deepEqual(matching.rows.map(r => r.key), [knowledgeBaseActorKey(last)]); assert.equal(matching.nextCursor, null);
      assert.deepEqual((await listKnowledgeBaseStats(admin, { view: 'materials', search: 'Guide' })).rows.map(r => r.key), [String(file.id),
        ...((await query<{ id: string }>("select distinct n.id::text from knowledge_base_nodes n join knowledge_base_events e on e.node_id=n.id where n.title='Guide' and n.id<>$1 order by n.id::text", [file.id])).rows.map(r => r.id))].sort());
    });

    await t.test('TOP can create folders and files, edit exact ACL, archive/restore, and read employee and usage pages', async () => {
      assert.deepEqual(await listKnowledgeBase(top), await listKnowledgeBase(admin), 'TOP sees the same folders without being individually granted');
      const created = await createKnowledgeBaseFolder(top, folderInput(null, 'TOP-managed folder'));
      let folder = created.node;
      assert.equal(created.created, true);
      assert.equal(await getKnowledgeBaseNode(manager, folder.id), null);
      folder = await updateKnowledgeBaseNode(top, folder.id, { expectedRevision: folder.revision, title: 'TOP-managed documents',
        access: { mode: 'custom', actorKeys: [knowledgeBaseActorKey(manager), knowledgeBaseActorKey(purchaser)] } });
      assert.ok(await getKnowledgeBaseNode(manager, folder.id));
      const upload = fileInput(folder.id);
      let material = (await createKnowledgeBaseFile(top, upload)).node;
      assert.equal((await getKnowledgeBaseFileForRead(manager, material.id))?.storagePath, upload.storagePath);
      material = await updateKnowledgeBaseNode(top, material.id, { expectedRevision: material.revision,
        title: 'TOP restricted file', access: { mode: 'custom', actorKeys: [knowledgeBaseActorKey(purchaser)] } });
      assert.equal(await getKnowledgeBaseFileForRead(manager, material.id), null);
      assert.ok(await getKnowledgeBaseFileForRead(purchaser, material.id));
      assert.ok(await getKnowledgeBaseFileForRead(top, material.id));
      await assert.rejects(updateKnowledgeBaseNode(top, folder.id, { expectedRevision: created.node.revision, title: 'Stale TOP edit' }), status(409));
      const directory = await listKnowledgeBaseActors(top);
      assert.deepEqual(directory, await listKnowledgeBaseActors(admin)); safeDto(directory);
      const eventId = randomUUID();
      await recordKnowledgeBaseEvent(top, { eventId, nodeId: material.id, action: 'file_view' });
      const people = await listKnowledgeBaseStats(top, { view: 'employees', nodeId: material.id });
      assert.equal(people.rows.length, 1); assert.equal(people.rows[0].key, knowledgeBaseActorKey(top));
      assert.equal(people.rows[0].fileViews, 1);
      const materials = await listKnowledgeBaseStats(top, { view: 'materials', nodeId: material.id });
      assert.equal(materials.rows[0].title, 'TOP restricted file'); safeDto(people); safeDto(materials);
      folder = await setKnowledgeBaseArchive(top, folder.id, { expectedRevision: folder.revision, archived: true });
      assert.equal(await getKnowledgeBaseFileForRead(top, material.id), null);
      assert.equal(await getKnowledgeBaseFileForRead(purchaser, material.id), null);
      assert.ok((await listKnowledgeBase(top, { archived: true })).nodes.some(node => node.id === folder.id));
      folder = await setKnowledgeBaseArchive(top, folder.id, { expectedRevision: folder.revision, archived: false });
      assert.equal(folder.archivedAt, null);
      assert.equal((await getKnowledgeBaseFileForRead(top, material.id))?.storagePath, upload.storagePath);
      assert.ok(await getKnowledgeBaseFileForRead(purchaser, material.id));
      assert.equal(await getKnowledgeBaseFileForRead(manager, material.id), null, 'restoring does not expand file ACL');
      assert.deepEqual((await getKnowledgeBaseNode(top, material.id))?.access, material.access);
      assert.equal((await listKnowledgeBaseStats(top, { view: 'employees', nodeId: material.id })).rows[0].fileViews, 1);
    });

    await t.test('forged, revoked and demoted TOP sessions cannot use any management operation', async () => {
      const revoked = await actor('top');
      await query('update admin_sessions set revoked_at=clock_timestamp() where id=$1', [revoked.sessionId]);
      const demoted = await actor('top');
      await query("update admin_users set role='purchaser' where id=$1", [demoted.adminUserId]);
      const disabled = await actor('top');
      await query('update admin_users set is_active=false where id=$1', [disabled.adminUserId]);
      const fakeSessions: AdminSession[] = [
        { ...top, sessionId: randomUUID() }, { ...purchaser, role: 'top' },
        { ...top, adminUserId: purchaser.adminUserId }, revoked, demoted, disabled,
      ];
      for (const session of fakeSessions) {
        await assert.rejects(listKnowledgeBase(session), status(401));
        await assert.rejects(listKnowledgeBaseActors(session), status(401));
        await assert.rejects(listKnowledgeBaseStats(session, { view: 'materials' }), status(401));
        await assert.rejects(createKnowledgeBaseFolder(session, folderInput(null)), status(401));
        await assert.rejects(createKnowledgeBaseFile(session, fileInput(child.id)), status(401));
        await assert.rejects(updateKnowledgeBaseNode(session, root.id, { expectedRevision: root.revision, title: 'Forged TOP edit' }), status(401));
        await assert.rejects(setKnowledgeBaseArchive(session, root.id, { expectedRevision: root.revision, archived: true }), status(401));
      }
    });
  } finally { await globalThis.__ktsPgPool?.end(); }
});
