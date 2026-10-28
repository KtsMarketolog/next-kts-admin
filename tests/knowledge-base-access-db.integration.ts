import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AdminSession, AdminSessionRole } from '../src/shared/lib/adminAuth';
import { knowledgeBaseActorKey, type KnowledgeBaseAccess, type KnowledgeBaseAccessSummary } from '../src/shared/lib/knowledgeBase';
import { query } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { createTrustedAdminSession } from '../src/shared/lib/db/adminSessionsRepo';
import { createKnowledgeBaseFile, createKnowledgeBaseFolder, getKnowledgeBaseAccessSummary,
  listKnowledgeBaseActors, setKnowledgeBaseArchive, updateKnowledgeBaseNode } from '../src/shared/lib/db/knowledgeBaseRepo';

function guard() {
  assert.equal(process.env.KTS_KNOWLEDGE_BASE_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.username, 'kb_app');
  assert.equal(url.pathname, '/kts_knowledge_base_integration');
  assert.equal(url.password, '');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['host', 'port']);
  assert.equal(url.searchParams.get('port'), '55489');
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-knowledge-base-postgres\.[A-Za-z0-9]+\/socket$/);
}

const createdAdmins: number[] = [], createdManagers: number[] = [];
async function actor(role: AdminSessionRole, active = true): Promise<AdminSession> {
  const manager = role === 'manager' || role === 'support_manager';
  const login = `kb-access-${randomUUID()}`;
  const result = await query<{ id: string }>(`insert into ${manager ? 'wholesale_managers' : 'admin_users'}(login,email,name,role,is_active)
    values($1,$2,$3,$4,$5) returning id::text`, [login, `${login}@synthetic.test`, login, role, active]);
  const id = Number(result.rows[0].id);
  (manager ? createdManagers : createdAdmins).push(id);
  const identity = manager ? { managerId: id } : { adminUserId: id };
  const stored = await createTrustedAdminSession({ role, ...identity });
  return { role, ...identity, sessionId: stored.sessionId };
}
const status = (expected: number) => (error: unknown) => (error as { status?: number }).status === expected;
const acl = (...actors: AdminSession[]): KnowledgeBaseAccess => ({ mode: 'custom', actorKeys: actors.map(knowledgeBaseActorKey) });
const inherit: KnowledgeBaseAccess = { mode: 'inherit', actorKeys: [] };
function check(summary: KnowledgeBaseAccessSummary, expected: Partial<KnowledgeBaseAccessSummary>) {
  assert.equal(summary.withAccess, summary.byRole + summary.bySelection + summary.byInheritance);
  assert.equal(summary.totalActive, summary.withAccess + summary.withoutAccess);
  assert.ok(Object.values(summary).every(value => Number.isSafeInteger(value) && value >= 0));
  for (const key of Object.keys(expected) as Array<keyof KnowledgeBaseAccessSummary>) assert.equal(summary[key], expected[key], key);
  assert.doesNotMatch(JSON.stringify(summary), /actorKey|name|email|password|session|storage/);
}
async function folder(session: AdminSession, parentId: number | null, title: string, access?: KnowledgeBaseAccess) {
  return (await createKnowledgeBaseFolder(session, { parentId, title, access, operationId: randomUUID() })).node;
}

test('knowledge base access preview counts effective employees without changing grants', { timeout: 180_000 }, async t => {
  guard();
  try {
    await ensureSiteSchema();
    // This suite runs first on a newly created synthetic database: the 36/40 example is exact.
    assert.equal((await query('select id from admin_users union all select id from wholesale_managers')).rowCount, 0);
    const supervisors: AdminSession[] = [];
    for (let index = 0; index < 9; index++) supervisors.push(await actor((['admin', 'admintop', 'top'] as const)[index % 3]));
    const admin = supervisors[0], employees: AdminSession[] = [];
    for (let index = 0; index < 31; index++) employees.push(await actor((['manager', 'support_manager', 'purchaser', 'wholesale_admin'] as const)[index % 4]));
    const selected = acl(...employees.slice(0, 27));
    const root = await folder(admin, null, 'Access summary example', selected);
    const preview = (access: KnowledgeBaseAccess, parentId: number | null = null) => getKnowledgeBaseAccessSummary(admin, { parentId, access });

    await t.test('27 selected plus 9 automatic accounts means 36 of 40, not 27', async () => {
      check(await preview(selected), { totalActive: 40, withAccess: 36, bySelection: 27, byRole: 9,
        byInheritance: 0, withoutAccess: 4, selectedInactive: 0, selectedBlockedByParent: 0 });
      check(await preview(acl()), { totalActive: 40, withAccess: 9, bySelection: 0, byRole: 9, withoutAccess: 31 });
      for (const supervisor of supervisors.slice(0, 3)) {
        check(await getKnowledgeBaseAccessSummary(supervisor, { parentId: null, access: selected }), { withAccess: 36 });
      }
    });

    await t.test('selected management accounts are not counted twice', async () => {
      check(await preview(acl(...employees.slice(0, 27), ...supervisors)),
        { totalActive: 40, withAccess: 36, bySelection: 27, byRole: 9, withoutAccess: 4 });
      check(await preview(acl(...supervisors)), { withAccess: 9, bySelection: 0, byRole: 9 });
    });

    await t.test('inactive and deleted account keys do not gain access or inflate the total', async () => {
      const inactiveManager = await actor('manager', false), inactiveAdmin = await actor('top', false);
      const access: KnowledgeBaseAccess = { mode: 'custom', actorKeys: [...selected.actorKeys,
        knowledgeBaseActorKey(inactiveManager), knowledgeBaseActorKey(inactiveAdmin), 'manager:999999999999'] };
      check(await preview(access), { totalActive: 40, withAccess: 36, byRole: 9, bySelection: 27, selectedInactive: 3 });
      assert.equal(access.actorKeys.length, 30, 'read-only preview does not normalize the saved/draft selection');
    });

    const scoped = await folder(admin, null, 'Access summary ancestor', acl(...employees.slice(0, 3)));
    const child = await folder(admin, scoped.id, 'Access summary child', acl(...employees.slice(1, 4)));
    await t.test('all custom ancestors intersect the selection; child grants cannot expand parent access', async () => {
      check(await preview(acl(employees[0], employees[1], employees[3], employees[4], supervisors[0]), child.id),
        { totalActive: 40, withAccess: 10, byRole: 9, bySelection: 1, selectedBlockedByParent: 3, withoutAccess: 30 });
      check(await preview(inherit, child.id), { withAccess: 11, byRole: 9, bySelection: 0, byInheritance: 2, withoutAccess: 29 });
      const closed = await folder(admin, null, 'Access summary closed');
      check(await preview(acl(employees[0]), closed.id), { withAccess: 9, bySelection: 0, selectedBlockedByParent: 1 });
      check(await preview(inherit, closed.id), { withAccess: 9, byInheritance: 0 });
    });

    await t.test('ancestor permission changes affect the next count without cached rights', async () => {
      await updateKnowledgeBaseNode(admin, scoped.id, { expectedRevision: scoped.revision, access: acl(employees[0]) });
      check(await preview(inherit, child.id), { withAccess: 9, byInheritance: 0 });
      check(await preview(acl(employees[1]), child.id), { withAccess: 9, bySelection: 0, selectedBlockedByParent: 1 });
    });

    await t.test('missing, archived and non-folder parents are rejected rather than treated as root', async () => {
      const archived = await folder(admin, root.id, 'Access summary archived');
      await setKnowledgeBaseArchive(admin, archived.id, { expectedRevision: archived.revision, archived: true });
      const file = (await createKnowledgeBaseFile(admin, { parentId: root.id, title: 'Access summary file', operationId: randomUUID(),
        originalName: 'access.pdf', mimeType: 'application/pdf', size: 10, storagePath: `knowledge-base/${randomUUID()}.pdf`, sha256: 'a'.repeat(64) })).node;
      for (const parentId of [999999999, archived.id, file.id]) await assert.rejects(preview(inherit, parentId), status(404));
      for (const parentId of [0, -1, 1.5]) await assert.rejects(preview(selected, parentId), status(400));
      await assert.rejects(preview(inherit), status(400));
      await assert.rejects(preview({ mode: 'custom', actorKeys: ['admin:primary'] }), status(400));
      await assert.rejects(preview(acl(employees[0], employees[0])), status(400));
    });

    await t.test('only authenticated active managers of the section can inspect the preview', async () => {
      for (const employee of employees.slice(0, 4)) {
        await assert.rejects(getKnowledgeBaseAccessSummary(employee, { parentId: null, access: selected }), status(403));
      }
      await assert.rejects(getKnowledgeBaseAccessSummary({ ...employees[0], role: 'admin' }, { parentId: null, access: selected }), status(401));
      await assert.rejects(getKnowledgeBaseAccessSummary({ ...admin, sessionId: randomUUID() }, { parentId: null, access: selected }), status(401));
      await query('update admin_sessions set revoked_at=clock_timestamp() where id=$1', [supervisors[8].sessionId]);
      await assert.rejects(getKnowledgeBaseAccessSummary(supervisors[8], { parentId: null, access: selected }), status(401));
    });

    await t.test('role and activation changes are reflected without counting stale session roles', async () => {
      const changed = supervisors[7];
      await query("update admin_users set role='purchaser' where id=$1", [changed.adminUserId]);
      check(await preview(selected), { totalActive: 40, withAccess: 35, byRole: 8, bySelection: 27, withoutAccess: 5 });
      await assert.rejects(getKnowledgeBaseAccessSummary(changed, { parentId: null, access: selected }), status(401));
      await query('update admin_users set role=$2 where id=$1', [changed.adminUserId, changed.role]);
      await query('update wholesale_managers set is_active=false where id=$1', [employees[0].managerId]);
      check(await preview(selected), { totalActive: 39, withAccess: 35, byRole: 9, bySelection: 26, selectedInactive: 1 });
      await query('update wholesale_managers set is_active=true where id=$1', [employees[0].managerId]);
    });

    await t.test('summary covers the entire directory regardless of paging and search', async () => {
      const extra: AdminSession[] = [];
      for (let index = 0; index < 20; index++) extra.push(await actor('manager'));
      const allSelected = acl(...employees.slice(0, 27), ...extra);
      check(await preview(allSelected), { totalActive: 60, withAccess: 56, byRole: 9, bySelection: 47, withoutAccess: 4 });
      const first = await listKnowledgeBaseActors(admin);
      assert.equal(first.actors.length, 50); assert.ok(first.nextCursor);
      const second = await listKnowledgeBaseActors(admin, { after: first.nextCursor! });
      assert.equal(second.actors.length, 10);
      assert.equal((await listKnowledgeBaseActors(admin, { search: 'no such synthetic employee' })).actors.length, 0);
      check(await preview(allSelected), { totalActive: 60, withAccess: 56 });
    });

    await t.test('previews are read-only for nodes, grants, usage and accounts', async () => {
      const snapshot = async () => {
        const rows = [];
        for (const table of ['knowledge_base_nodes', 'knowledge_base_grants', 'knowledge_base_events', 'admin_users', 'wholesale_managers']) {
          rows.push((await query(`select row_to_json(t) as row from ${table} t order by row_to_json(t)::text`)).rows);
        }
        return rows;
      };
      const before = await snapshot();
      await preview(acl()); await preview(selected); await preview(inherit, root.id); await preview(acl(employees[0]), child.id);
      assert.deepEqual(await snapshot(), before);
    });
  } finally {
    // Leave no active fixture employees for later directory tests in the same disposable database.
    if (createdAdmins.length) await query('update admin_users set is_active=false where id=any($1::bigint[])', [createdAdmins]);
    if (createdManagers.length) await query('update wholesale_managers set is_active=false where id=any($1::bigint[])', [createdManagers]);
    await globalThis.__ktsPgPool?.end();
  }
});
