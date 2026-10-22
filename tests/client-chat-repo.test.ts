import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { applyClientChatReceiptsMigration } from '../src/shared/lib/db/clientChatReceiptsMigration';
import type { PoolClient } from 'pg';

type Options = { missingAnchor?: boolean; denied?: boolean; archived?: boolean; pageLength?: number };
function harness(options: Options = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  let writes = 0;
  let schemaCalls = 0;
  let transactionCalls = 0;
  const db = { query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.startsWith('select created_at::text')) return { rows: options.missingAnchor ? [] : [{ created_at: '2026-10-23 12:00:00.123456+00' }] };
    if (sql.includes('with targets as')) { writes++; return { rows: [{ id: '12' }] }; }
    if (sql.includes('count(*)::text as count')) return { rows: [{ count: '201' }] };
    if (sql.includes('as read_by_viewer')) return { rows: Array.from({ length: options.pageLength ?? 101 }, (_, i) => ({
      id: String(500 - i), company_id: '1', author_type: 'client', author_name: 'Client', body: 'Synthetic',
      created_at: '2026-10-23 12:00:00.123456+00', read_by_other: false, read_by_viewer: false,
    })) };
    return { rows: [{ id: '12' }] };
  } };
  const modules: Record<string, unknown> = {
    './client': { query: db.query, withTransaction: async (callback: (db: unknown) => unknown) => { transactionCalls++; return callback(db); } },
    './schema': { ensureSiteSchema: async () => { schemaCalls++; } },
    './clientCompaniesRepo': {
      assertClientCompanyVisible: async () => { if (options.denied) throw new Error('Forbidden company'); },
      assertClientCompanyWritable: async () => { if (options.denied || options.archived) throw new Error('Forbidden company'); },
    },
  };
  const source = ts.transpileModule(readFileSync('src/shared/lib/db/clientChatRepo.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const instance = { exports: {} };
  new Function('require', 'module', 'exports', source)((name: string) => {
    assert.ok(name in modules, `Unexpected module ${name}`); return modules[name];
  }, instance, instance.exports);
  return { repo: instance.exports as typeof import('../src/shared/lib/db/clientChatRepo'), calls,
    writes: () => writes, schemaCalls: () => schemaCalls, transactionCalls: () => transactionCalls };
}

test('chat GET returns a bounded chronological latest page and never changes read state', async () => {
  const h = harness();
  const page = await h.repo.getClientChatConversationForAdmin(1, { role: 'admin' });
  assert.equal(page.messages.length, 100);
  assert.equal(page.olderCursor, 401);
  assert.equal(page.newerCursor, 500);
  assert.equal(page.hasOlder, true);
  assert.equal(page.hasNewer, false);
  assert.equal(page.unreadCount, 201);
  assert.equal(page.messages[0].readByViewer, false);
  assert.equal(h.transactionCalls(), 0);
  assert.equal(h.writes(), 0);
  assert.ok(h.calls.every(({ sql }) => !/\b(insert|update|delete)\b/i.test(sql)));
  const sql = h.calls.find(({ sql }) => sql.includes('as read_by_viewer'))!.sql;
  assert.match(sql, /order by messages.created_at desc, messages.id desc\s+limit 101/);
  assert.match(sql, /read_by_other_at is not null/);
});

test('chat cursor retains PostgreSQL microseconds and is scoped to the current company', async () => {
  const h = harness();
  await h.repo.getClientChatConversationForAdmin(1, { role: 'admin' }, { before: 200 });
  assert.deepEqual(h.calls[0].params, [1, 200]);
  assert.match(h.calls[0].sql, /company_id = \$1 and id = \$2/);
  const page = h.calls.find(({ sql }) => sql.includes('as read_by_viewer'))!;
  assert.deepEqual(page.params, [1, 'employee', '2026-10-23 12:00:00.123456+00', 200]);
  assert.match(page.sql, /\(messages.created_at, messages.id\) < \(\$3::timestamptz, \$4::bigint\)/);
  assert.doesNotMatch(readFileSync('src/shared/lib/db/clientChatRepo.ts', 'utf8'), /Date\.parse|new Date\(/);
  const missing = harness({ missingAnchor: true });
  await assert.rejects(missing.repo.getClientChatConversationForAdmin(1, { role: 'admin' }, { before: 200 }), missing.repo.ClientChatInputError);
  assert.equal(missing.calls.length, 1);
});

test('chat after pagination is ascending, bounded and reports more new pages', async () => {
  const h = harness();
  const page = await h.repo.getClientChatConversationForAdmin(1, { role: 'admin' }, { after: 200 });
  assert.equal(page.hasNewer, true);
  const sql = h.calls.find(({ sql }) => sql.includes('as read_by_viewer'))!.sql;
  assert.match(sql, /\(messages.created_at, messages.id\) > \(\$3::timestamptz, \$4::bigint\)/);
  assert.match(sql, /order by messages.created_at asc, messages.id asc/);
});

test('chat after zero starts at the oldest message without looking up an anchor', async () => {
  const h = harness();
  const page = await h.repo.getClientChatConversationForAdmin(1, { role: 'admin' }, { after: 0 });
  assert.equal(page.hasOlder, false);
  assert.equal(page.hasNewer, true);
  assert.equal(h.calls.some(({ sql }) => sql.startsWith('select created_at::text')), false);
  const select = h.calls.find(({ sql }) => sql.includes('as read_by_viewer'))!;
  assert.deepEqual(select.params, [1, 'employee']);
  assert.doesNotMatch(select.sql, /\$3::timestamptz/);
  assert.match(select.sql, /order by messages.created_at asc, messages.id asc/);
});

test('chat validates cursors and bounded receipts before fetching message data', async () => {
  const h = harness();
  for (const options of [{ before: 0 }, { after: NaN }, { before: 1, after: 2 }, { before: Number.MAX_SAFE_INTEGER + 1 }, { receiptIds: Array(101).fill(1) }, { receiptIds: [-1] }]) {
    await assert.rejects(h.repo.getClientChatConversation(1, 'employee', options), h.repo.ClientChatInputError);
  }
  for (const ids of [Array(101).fill(1), [-1], [1.5], [NaN], [Number.MAX_SAFE_INTEGER + 1]]) {
    await assert.rejects(h.repo.markClientChatReadForAdmin(1, { role: 'admin' }, ids), h.repo.ClientChatInputError);
  }
  assert.equal(h.schemaCalls(), 0);
  assert.deepEqual(h.calls, []);
});

test('chat acknowledgement updates only exact incoming IDs, keeps legacy markers immutable and returns DB count', async () => {
  const h = harness();
  const result = await h.repo.markClientChatReadForAdmin(1, { role: 'admin' }, [15, 12, 15]);
  assert.deepEqual(result, { acknowledgedIds: [12], unreadCount: 201, changed: true });
  const update = h.calls.find(({ sql }) => sql.includes('with targets as'))!;
  assert.deepEqual(update.params, [1, 'client', [12, 15]]);
  assert.match(update.sql, /messages.company_id = \$1 and messages.author_type = \$2/);
  assert.match(update.sql, /messages.id = any\(\$3::bigint\[\]\)/);
  assert.match(update.sql, /order by messages.id for update of messages/);
  assert.match(update.sql, /messages.read_by_other_at is null/);
  assert.ok(h.calls.every(({ sql }) => !/(insert into|update) client_chat_read_state/i.test(sql)));
  assert.equal(h.transactionCalls(), 1);
});

test('chat read receipts recheck company write permission and do not update archived correspondence', async () => {
  for (const options of [{ denied: true }, { archived: true }]) {
    const h = harness(options);
    await assert.rejects(h.repo.markClientChatReadForAdmin(1, { role: 'manager', managerId: 1 }, [12]), /Forbidden/);
    assert.equal(h.writes(), 0);
  }
  const denied = harness({ denied: true });
  await assert.rejects(denied.repo.getClientChatConversationForAdmin(1, { role: 'manager', managerId: 1 }), /Forbidden/);
  assert.equal(denied.calls.length, 0);
});

test('client acknowledgements lock active company then active user before updating incoming employee messages', async () => {
  const h = harness();
  await h.repo.markClientChatReadForClient({ companyId: 1, clientUserId: 2 }, [12]);
  assert.match(h.calls[0].sql, /client_companies[\s\S]+is_active = true and archived_at is null for share/);
  assert.match(h.calls[1].sql, /client_users[\s\S]+company_id = \$2 and is_active = true for share/);
  assert.deepEqual(h.calls.find(({ sql }) => sql.includes('with targets as'))!.params, [1, 'employee', [12]]);
});

test('receipt polling is bounded to requested own messages, and all unread counters exclude exact receipts', async () => {
  const h = harness({ pageLength: 0 });
  const page = await h.repo.getClientChatConversationForAdmin(1, { role: 'admin' }, { receiptIds: [9, 7, 9] });
  const receipts = h.calls.find(({ sql }) => sql.includes('messages.id = any($3::bigint[])'))!;
  assert.deepEqual(receipts.params, [1, 'employee', [7, 9]]);
  assert.match(receipts.sql, /messages.author_type = \$2/);
  assert.deepEqual(page.readMessageIds, [12]);
  const companies = readFileSync('src/shared/lib/db/clientCompaniesRepo.ts', 'utf8');
  assert.equal((companies.match(/ccm\.read_by_other_at is null/g) ?? []).length, 4);
  const repo = readFileSync('src/shared/lib/db/clientChatRepo.ts', 'utf8');
  assert.match(repo, /and messages.author_type = 'client'\s+and messages.read_by_other_at is null/);
});

test('chat migration is additive without changing messages or legacy read state', async () => {
  let sql = '';
  await applyClientChatReceiptsMigration({ query: async (value: string) => { sql = value; } } as unknown as PoolClient);
  assert.match(sql, /add column read_by_other_at timestamptz/);
  assert.match(sql, /where read_by_other_at is null/);
  assert.doesNotMatch(sql, /\b(update|delete|drop|truncate)\b/i);
  assert.doesNotMatch(sql, /client_chat_read_state/);
});
