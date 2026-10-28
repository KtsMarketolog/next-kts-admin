import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { AdminSession, AdminSessionRole } from '../src/shared/lib/adminAuth';
import { knowledgeBaseActorKey, type KnowledgeBaseAccess, type KnowledgeBaseNode } from '../src/shared/lib/knowledgeBase';
import { query } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { createTrustedAdminSession } from '../src/shared/lib/db/adminSessionsRepo';
import { createKnowledgeBaseFile, createKnowledgeBaseFolder, listKnowledgeBase,
  setKnowledgeBaseArchive, updateKnowledgeBaseNode } from '../src/shared/lib/db/knowledgeBaseRepo';

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

async function actor(role: AdminSessionRole): Promise<AdminSession> {
  const table = role === 'manager' || role === 'support_manager' ? 'wholesale_managers' : 'admin_users';
  const login = `kb-search-${randomUUID()}`;
  const result = await query<{ id: string }>(`insert into ${table}(login,email,name,role) values($1,$2,$3,$4) returning id::text`,
    [login, `${login}@synthetic.test`, login, role]);
  const id = Number(result.rows[0].id);
  const identity = table === 'wholesale_managers' ? { managerId: id } : { adminUserId: id };
  const stored = await createTrustedAdminSession({ role, ...identity });
  return { role, ...identity, sessionId: stored.sessionId };
}

const status = (expected: number) => (error: unknown) => (error as { status?: number }).status === expected;
const acl = (...sessions: AdminSession[]): KnowledgeBaseAccess => ({ mode: 'custom', actorKeys: sessions.map(knowledgeBaseActorKey) });
const ids = (nodes: KnowledgeBaseNode[]) => nodes.map(node => node.id).sort((a, b) => a - b);
const pathOf = (...nodes: KnowledgeBaseNode[]) => nodes.map(({ id, title }) => ({ id, title }));
function safeDto(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), /storagePath|storage_path|operation_digest|session_hash|password|@synthetic|"sha256"/);
}
async function folder(session: AdminSession, parentId: number | null, title: string, access?: KnowledgeBaseAccess) {
  return (await createKnowledgeBaseFolder(session, { parentId, title, access, operationId: randomUUID() })).node;
}
async function file(session: AdminSession, parentId: number, title: string, access?: KnowledgeBaseAccess) {
  return (await createKnowledgeBaseFile(session, { parentId, title, access, operationId: randomUUID(),
    originalName: 'synthetic-guide.pdf', mimeType: 'application/pdf', size: 20,
    storagePath: `knowledge-base/${randomUUID()}.pdf`, sha256: 'a'.repeat(64) })).node;
}

test('knowledge base recursive search real PostgreSQL scope, paths, Unicode, paging and ACL', { timeout: 180_000 }, async t => {
  guard();
  try {
    await ensureSiteSchema();
    const admin = await actor('admin'), top = await actor('top'), adminTop = await actor('admintop');
    const manager = await actor('manager'), support = await actor('support_manager');
    const purchaser = await actor('purchaser'), wholesale = await actor('wholesale_admin');
    const employees = [manager, support, purchaser, wholesale];
    const root = await folder(admin, null, 'Регламенты ГК КТС — проверка поиска', acl(...employees));
    const personnel = await folder(admin, root.id, 'Персонал');
    const expenses = await folder(admin, personnel.id, 'Расходы');
    const finance = await folder(admin, root.id, 'Финансовый отдел');
    const trip = await file(admin, expenses.id, 'Командировочные расходы');
    const duplicate = await file(admin, finance.id, 'Командировочные расходы');
    const matchingFolder = await folder(admin, personnel.id, 'Командировочные инструкции');
    const unrelated = await file(admin, expenses.id, 'Отпуска и выходные');
    const special = await file(admin, expenses.id, 'Командировочные %_ правила');
    const scoped = await folder(admin, root.id, 'Закрытый отдел', acl(purchaser));
    const scopedFile = await file(admin, scoped.id, 'Командировочные закрытые сведения', acl(manager, purchaser));
    const restrictedFile = await file(admin, expenses.id, 'Командировочные закупки', acl(purchaser));
    const hiddenRoot = await folder(admin, null, 'Не раскрывать название закрытого раздела', acl(purchaser));
    const grantedChild = await folder(admin, hiddenRoot.id, 'Не раскрывать название дочернего раздела', acl(manager, purchaser));
    const hiddenFile = await file(admin, grantedChild.id, 'Командировочные секретные сведения', acl(manager, purchaser));
    const archivedFolder = await folder(admin, root.id, 'Командировочные архивные регламенты');
    const archivedDescendant = await file(admin, archivedFolder.id, 'Командировочные старые правила');
    await setKnowledgeBaseArchive(admin, archivedFolder.id, { expectedRevision: archivedFolder.revision, archived: true });
    const archivedFile = await file(admin, expenses.id, 'Командировочные архивные расходы');
    await setKnowledgeBaseArchive(admin, archivedFile.id, { expectedRevision: archivedFile.revision, archived: true });
    const common = [trip, duplicate, matchingFolder, special];

    await t.test('root searches all accessible active descendants, including Cyrillic case-insensitive partial titles', async () => {
      for (const search of ['командировоч', 'КОМАНДИРОВОЧ', '  КоМаНдИрОвОч  ']) {
        const result = await listKnowledgeBase(manager, { search });
        assert.deepEqual(ids(result.nodes), ids(common));
        assert.equal(result.nextCursor, null);
        assert.deepEqual(result.breadcrumbs, []);
        assert.equal(result.canManage, false);
        assert.ok(result.nodes.every(node => node.access === undefined));
        safeDto(result);
      }
      const result = await listKnowledgeBase(manager, { search: 'расходы' });
      assert.deepEqual(ids(result.nodes), ids([expenses, trip, duplicate]));
      assert.ok(!ids(result.nodes).includes(unrelated.id));
    });

    await t.test('every match has a root-to-parent path with only accessible IDs and titles', async () => {
      const result = await listKnowledgeBase(manager, { search: 'Командировоч' });
      assert.deepEqual(result.nodes.find(node => node.id === trip.id)?.path, pathOf(root, personnel, expenses));
      assert.deepEqual(result.nodes.find(node => node.id === duplicate.id)?.path, pathOf(root, finance));
      assert.deepEqual(result.nodes.find(node => node.id === matchingFolder.id)?.path, pathOf(root, personnel));
      const rootResult = await listKnowledgeBase(manager, { search: root.title });
      assert.deepEqual(rootResult.nodes.map(node => ({ id: node.id, path: node.path })), [{ id: root.id, path: [] }]);
      for (const node of result.nodes) {
        assert.ok(node.path);
        assert.ok(node.path.every(part => Object.keys(part).sort().join(',') === 'id,title'));
      }
      assert.doesNotMatch(JSON.stringify(result), /Не раскрывать|Закрытый отдел|секретные сведения|закрытые сведения|закупки/);
    });

    await t.test('a nested search stays inside that subtree but returns the full path from the root', async () => {
      const result = await listKnowledgeBase(manager, { parentId: personnel.id, search: 'Командировоч' });
      assert.deepEqual(ids(result.nodes), ids([trip, matchingFolder, special]));
      assert.deepEqual(result.breadcrumbs.map(node => node.id), [root.id, personnel.id]);
      assert.deepEqual(result.nodes.find(node => node.id === trip.id)?.path, pathOf(root, personnel, expenses));
      assert.ok(!ids(result.nodes).includes(duplicate.id));
      const self = await listKnowledgeBase(manager, { parentId: matchingFolder.id, search: 'Командировоч' });
      assert.deepEqual(self.nodes, [], 'search results do not include the selected folder itself');
    });

    await t.test('custom ancestor ACLs intersect leaf grants and restricted leaves remain hidden for every ordinary role', async () => {
      for (const employee of [manager, support, wholesale]) {
        const result = await listKnowledgeBase(employee, { search: 'Командировоч' });
        assert.deepEqual(ids(result.nodes), ids(common));
        assert.doesNotMatch(JSON.stringify(result), /Не раскрывать|Закрытый отдел|секретные сведения|закрытые сведения|закупки/);
      }
      const result = await listKnowledgeBase(purchaser, { search: 'Командировоч' });
      assert.deepEqual(ids(result.nodes), ids([...common, restrictedFile, scopedFile, hiddenFile]));
      assert.deepEqual(result.nodes.find(node => node.id === hiddenFile.id)?.path, pathOf(hiddenRoot, grantedChild));
    });

    await t.test('existing management roles retain access but active search never traverses archived branches', async () => {
      for (const supervisor of [admin, top, adminTop]) {
        const result = await listKnowledgeBase(supervisor, { search: 'Командировоч' });
        assert.equal(result.canManage, true);
        assert.deepEqual(ids(result.nodes), ids([...common, restrictedFile, scopedFile, hiddenFile]));
        assert.ok(!ids(result.nodes).some(id => [archivedFolder.id, archivedDescendant.id, archivedFile.id].includes(id)));
        safeDto(result);
      }
    });

    await t.test('no-search and archive listing preserve direct-child semantics; whitespace is not recursive', async () => {
      for (const search of [undefined, '', '   ']) {
        const result = await listKnowledgeBase(manager, { parentId: root.id, search });
        assert.deepEqual(ids(result.nodes), ids([personnel, finance]));
        assert.ok(result.nodes.every(node => node.path === undefined));
      }
      const archived = await listKnowledgeBase(admin, { parentId: root.id, archived: true, search: 'Командировоч' });
      assert.deepEqual(ids(archived.nodes), [archivedFolder.id]);
      assert.ok(archived.nodes.every(node => node.path === undefined));
      await assert.rejects(listKnowledgeBase(manager, { archived: true, search: 'Командировоч' }), status(403));
    });

    await t.test('missing, inaccessible, archived or file parent cannot turn into a root search', async () => {
      for (const parentId of [9_999_999, hiddenRoot.id, grantedChild.id, scoped.id, archivedFolder.id, trip.id]) {
        await assert.rejects(listKnowledgeBase(manager, { parentId, search: 'Командировоч' }), status(404));
      }
      await assert.rejects(listKnowledgeBase(admin, { parentId: archivedFolder.id, search: 'Командировоч' }), status(404));
      await assert.rejects(listKnowledgeBase(manager, { parentId: 0, search: 'Командировоч' }), status(400));
      await assert.rejects(listKnowledgeBase(manager, { after: -1, search: 'Командировоч' }), status(400));
      const literal = await listKnowledgeBase(manager, { parentId: root.id, search: '%_' });
      assert.deepEqual(ids(literal.nodes), [special.id]);
      assert.deepEqual((await listKnowledgeBase(manager, { search: "' OR 1=1 --" })).nodes, []);
    });

    await t.test('pagination filters IDs only after traversing low-ID ancestors and keeps equal-title matches distinct', async () => {
      const paginationRoot = await folder(admin, null, 'Pagination root', acl(manager));
      const left = await folder(admin, paginationRoot.id, 'Left');
      const right = await folder(admin, paginationRoot.id, 'Right');
      const leaves: KnowledgeBaseNode[] = [];
      for (let index = 0; index < 57; index++) {
        leaves.push(await file(admin, index % 2 === 0 ? left.id : right.id, 'Same pagination title'));
      }
      for (const parentId of [null, paginationRoot.id]) {
        const first = await listKnowledgeBase(manager, { parentId, search: 'Same pagination title' });
        assert.equal(first.nodes.length, 50);
        assert.ok(first.nextCursor && first.nextCursor > right.id);
        const second = await listKnowledgeBase(manager, { parentId, search: 'Same pagination title', after: first.nextCursor! });
        assert.equal(second.nodes.length, 7);
        assert.equal(second.nextCursor, null);
        assert.deepEqual([...first.nodes, ...second.nodes].map(node => node.id), leaves.map(node => node.id));
        assert.equal(new Set([...first.nodes, ...second.nodes].map(node => node.id)).size, 57);
        for (const node of second.nodes) {
          assert.deepEqual(node.path, pathOf(paginationRoot, node.parentId === left.id ? left : right));
        }
      }
    });

    await t.test('maximum-depth files remain searchable without path truncation', async () => {
      const ancestors = [await folder(admin, null, 'Search depth root', acl(manager))];
      for (let depth = 2; depth <= 12; depth++) ancestors.push(await folder(admin, ancestors.at(-1)!.id, `Search depth ${depth}`));
      const leaf = await file(admin, ancestors.at(-1)!.id, 'Unique deepest search result');
      const result = await listKnowledgeBase(manager, { search: 'Unique deepest' });
      assert.deepEqual(ids(result.nodes), [leaf.id]);
      assert.deepEqual(result.nodes[0].path, pathOf(...ancestors));
    });

    await t.test('search is read-only and permission revocation takes effect on the next request', async () => {
      const rows = async () => (await query('select row_to_json(n) as row from knowledge_base_nodes n order by n.id')).rows;
      const before = await rows();
      await listKnowledgeBase(manager, { search: 'Командировоч' });
      await listKnowledgeBase(admin, { parentId: personnel.id, search: 'Командировоч' });
      assert.deepEqual(await rows(), before);
      await updateKnowledgeBaseNode(admin, personnel.id, { expectedRevision: personnel.revision, access: acl(purchaser) });
      const result = await listKnowledgeBase(manager, { search: 'Командировоч' });
      assert.deepEqual(ids(result.nodes), [duplicate.id]);
      assert.doesNotMatch(JSON.stringify(result), /Персонал|Командировочные инструкции|%_ правила/);
      await assert.rejects(listKnowledgeBase(manager, { parentId: personnel.id, search: 'Командировоч' }), status(404));
      await query('update admin_sessions set revoked_at=clock_timestamp() where id=$1', [manager.sessionId]);
      await assert.rejects(listKnowledgeBase(manager, { search: 'Командировоч' }), status(401));
      await assert.rejects(listKnowledgeBase({ ...support, role: 'admin' }, { search: 'Командировоч' }), status(401));
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
  }
});
