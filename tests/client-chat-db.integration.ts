/** Synthetic acceptance only. Run via scripts/test-client-chat-postgres.sh. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';
import type { AdminSession } from '../src/shared/lib/adminAuth';
import { query, withTransaction } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { applyClientChatReceiptsMigration } from '../src/shared/lib/db/clientChatReceiptsMigration';
import {
  createClientChatMessageForAdmin, createClientChatMessageForClient,
  getClientChatConversationForAdmin, getClientChatConversationForClient,
  getClientChatUnreadCountsForAdmin, markClientChatReadForAdmin, markClientChatReadForClient,
} from '../src/shared/lib/db/clientChatRepo';
import { getClientCompanies, getClientPortalProfile } from '../src/shared/lib/db/clientCompaniesRepo';

const admin: AdminSession = { role: 'admin' };
function guard() {
  assert.equal(process.env.KTS_CLIENT_CHAT_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_client_chat_integration');
  assert.equal(url.username, 'chat_app');
  assert.equal(url.password, '');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-client-chat-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55505');
}

async function fixture(managerId: number | null = null) {
  const company = (await query<{ id: string }>(`insert into client_companies (title,manager_id)
    values ('Synthetic chat company',$1) returning id::text`, [managerId])).rows[0];
  const user = (await query<{ id: string }>(`insert into client_users (company_id,login,name)
    values ($1,$2,'Synthetic client') returning id::text`, [company.id, `chat-${company.id}@example.test`])).rows[0];
  return { companyId: Number(company.id), clientUserId: Number(user.id) };
}

async function seed(companyId: number, author: 'client' | 'employee', count: number, timestamp = '2026-01-01 00:00:00.123456+00') {
  return (await query<{ id: string }>(`insert into client_chat_messages (company_id,author_type,body,created_at)
    select $1,$2,'Synthetic message ' || n::text,$4::timestamptz + (n / 200) * interval '1 microsecond'
    from generate_series(1,$3::int) n returning id::text`, [companyId, author, count, timestamp])).rows.map((row) => Number(row.id));
}

async function until(check: () => Promise<boolean>) {
  const limit = Date.now() + 4_000;
  while (Date.now() < limit) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Synthetic concurrent transaction did not reach its lock');
}

test('client chat exact receipts and complete keyset history', { timeout: 180_000 }, async (t) => {
  guard();
  try {
    assert.equal((await query("select to_regclass('public.client_companies')::text as present")).rows[0].present, null);
    await ensureSiteSchema();
    const role = (await query('select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user')).rows[0];
    assert.deepEqual(role, { rolsuper: false, rolcreatedb: false, rolcreaterole: false });

    await t.test('legacy upgrade adds receipts without altering message bodies, dates or old read markers', async () => {
      await withTransaction(async (client) => {
        await client.query(`create schema synthetic_chat_legacy;
          set local search_path=synthetic_chat_legacy;
          create table client_chat_messages(id bigint,company_id bigint,author_type text,body text,created_at timestamptz);
          create table client_chat_read_state(company_id bigint,employee_read_at timestamptz);
          insert into client_chat_messages values (1,1,'client','Preserve bytes','2026-01-01 00:00:00.123456+00');
          insert into client_chat_read_state values (1,'2026-01-02');`);
        const before = (await client.query('select id,body,created_at::text from client_chat_messages')).rows;
        const reads = (await client.query('select * from client_chat_read_state')).rows;
        await applyClientChatReceiptsMigration(client);
        assert.deepEqual((await client.query('select id,body,created_at::text from client_chat_messages')).rows, before);
        assert.deepEqual((await client.query('select * from client_chat_read_state')).rows, reads);
        assert.equal((await client.query('select read_by_other_at from client_chat_messages')).rows[0].read_by_other_at, null);
        await client.query('drop schema synthetic_chat_legacy cascade');
      });
    });

    await t.test('301 incoming messages remain unread after GET; only displayed IDs are acknowledged and all older pages are reachable', async () => {
      const session = await fixture();
      const ids = await seed(session.companyId, 'client', 301);
      let page = await getClientChatConversationForAdmin(session.companyId, admin);
      assert.equal(page.messages.length, 100);
      assert.equal(page.unreadCount, 301);
      assert.equal(page.hasOlder, true);
      assert.equal(page.hasNewer, false);
      assert.deepEqual(page.messages.map((row) => row.id), ids.slice(-100));
      assert.ok(page.messages.every((row) => !row.readByViewer));
      const originalBody = (await query('select id,body,created_at::text from client_chat_messages where company_id=$1 order by id', [session.companyId])).rows;
      const ack = await markClientChatReadForAdmin(session.companyId, admin, page.messages.map((row) => row.id));
      assert.equal(ack.unreadCount, 201);
      assert.equal(ack.changed, true);
      assert.deepEqual((await markClientChatReadForAdmin(session.companyId, admin, ack.acknowledgedIds)), { ...ack, changed: false });
      assert.equal((await getClientCompanies(admin)).find((row) => row.id === session.companyId)?.chatUnreadCount, 201);
      assert.equal((await getClientChatUnreadCountsForAdmin(admin)).find((row) => row.companyId === session.companyId)?.unreadCount, 201);
      const allIds = page.messages.map((row) => row.id);
      while (page.hasOlder) {
        page = await getClientChatConversationForAdmin(session.companyId, admin, { before: page.olderCursor! });
        allIds.unshift(...page.messages.map((row) => row.id));
        await markClientChatReadForAdmin(session.companyId, admin, page.messages.map((row) => row.id));
      }
      assert.deepEqual(allIds, ids);
      assert.equal(new Set(allIds).size, 301);
      assert.equal((await getClientChatConversationForAdmin(session.companyId, admin)).unreadCount, 0);
      assert.equal((await query('select count(*)::int as count from client_chat_read_state where company_id=$1', [session.companyId])).rows[0].count, 0);
      assert.deepEqual((await query('select id,body,created_at::text from client_chat_messages where company_id=$1 order by id', [session.companyId])).rows, originalBody);
      const clientPage = await getClientChatConversationForClient(session, { receiptIds: [ids[0], ids.at(-1)!] });
      assert.deepEqual(clientPage.readMessageIds, [ids[0], ids.at(-1)!]);
      assert.ok(clientPage.messages.every((row) => row.readByOther));
    });

    await t.test('empty conversation catch-up and >100 new messages use bounded ascending pages without gaps', async () => {
      const session = await fixture();
      assert.equal((await getClientChatConversationForAdmin(session.companyId, admin)).newerCursor, null);
      const ids = await seed(session.companyId, 'client', 301);
      let cursor = 0;
      const received: number[] = [];
      for (;;) {
        const page = await getClientChatConversationForAdmin(session.companyId, admin, { after: cursor });
        if (cursor === 0) assert.equal(page.hasOlder, false);
        assert.ok(page.messages.length <= 100);
        received.push(...page.messages.map((row) => row.id));
        cursor = page.newerCursor!;
        if (!page.hasNewer) break;
      }
      assert.deepEqual(received, ids);
      const extraIds = await seed(session.companyId, 'client', 205, '2026-01-02 00:00:00.123456+00');
      const extra: number[] = [];
      for (;;) {
        const page = await getClientChatConversationForAdmin(session.companyId, admin, { after: cursor });
        extra.push(...page.messages.map((row) => row.id));
        cursor = page.newerCursor!;
        if (!page.hasNewer) break;
      }
      assert.deepEqual(extra, extraIds);
    });

    await t.test('client-side receipts exclude hidden, newly arrived, own and other-company messages', async () => {
      const session = await fixture();
      const foreign = await fixture();
      const ids = await seed(session.companyId, 'employee', 301);
      const foreignIds = await seed(foreign.companyId, 'employee', 1);
      const ownIds = await seed(session.companyId, 'client', 1);
      const page = await getClientChatConversationForClient(session);
      const newMessage = await createClientChatMessageForAdmin(session.companyId, admin, 'Arrived after GET');
      const shown = page.messages.filter((row) => row.authorType === 'employee').map((row) => row.id).slice(-98);
      const ack = await markClientChatReadForClient(session, [...shown, foreignIds[0], ownIds[0]]);
      assert.deepEqual(ack.acknowledgedIds, shown);
      assert.equal(ack.unreadCount, 302 - shown.length);
      assert.equal((await getClientPortalProfile(session.clientUserId))?.company.chatUnreadCount, ack.unreadCount);
      assert.equal((await query('select read_by_other_at from client_chat_messages where id=$1', [newMessage.id])).rows[0].read_by_other_at, null);
      assert.equal((await query('select read_by_other_at from client_chat_messages where id=$1', [ids[0]])).rows[0].read_by_other_at, null);
      assert.equal((await getClientChatConversationForAdmin(session.companyId, admin, { receiptIds: [shown[0], foreignIds[0], ownIds[0]] })).readMessageIds[0], shown[0]);
      assert.equal((await getClientChatConversationForAdmin(session.companyId, admin, { receiptIds: [foreignIds[0], ownIds[0]] })).readMessageIds.length, 0);
    });

    await t.test('legacy markers stay fixed, concurrent acknowledgement is idempotent, and future messages remain unread', async () => {
      const session = await fixture();
      const old = await seed(session.companyId, 'client', 1);
      const ids = await seed(session.companyId, 'client', 2, '2026-01-03');
      await query("insert into client_chat_read_state(company_id,employee_read_at) values ($1,'2026-01-02')", [session.companyId]);
      const before = (await query('select row_to_json(r) as row from client_chat_read_state r where company_id=$1', [session.companyId])).rows[0];
      const page = await getClientChatConversationForAdmin(session.companyId, admin);
      assert.equal(page.unreadCount, 2);
      assert.equal(page.messages.find((row) => row.id === old[0])?.readByViewer, true);
      const results = await Promise.all(Array.from({ length: 8 }, () => markClientChatReadForAdmin(session.companyId, admin, [ids[1]])));
      assert.equal(results.filter((result) => result.changed).length, 1);
      assert.ok(results.every((result) => result.unreadCount === 1));
      assert.deepEqual((await query('select row_to_json(r) as row from client_chat_read_state r where company_id=$1', [session.companyId])).rows[0], before);
      await createClientChatMessageForClient(session, 'Future message');
      assert.equal((await getClientChatConversationForAdmin(session.companyId, admin)).unreadCount, 2);
    });

    await t.test('cross-company cursors, unassigned managers, archived companies and disabled client users cannot acknowledge', async () => {
      const session = await fixture();
      const foreign = await fixture();
      const ids = await seed(session.companyId, 'client', 1);
      const foreignIds = await seed(foreign.companyId, 'client', 1);
      await assert.rejects(getClientChatConversationForAdmin(session.companyId, admin, { before: foreignIds[0] }), /недоступна/);
      await assert.rejects(getClientChatConversationForAdmin(session.companyId, { role: 'manager', managerId: 999999 }), /не найдена/);
      await assert.rejects(markClientChatReadForAdmin(session.companyId, { role: 'manager', managerId: 999999 }, ids), /не найдена/);
      await query('update client_users set is_active=false where id=$1', [session.clientUserId]);
      await assert.rejects(markClientChatReadForClient(session, ids), /отключена/);
      await assert.rejects(getClientChatConversationForClient(session), /отключена/);
      await query('update client_companies set archived_at=clock_timestamp(),is_active=false where id=$1', [session.companyId]);
      const before = (await query('select row_to_json(m) as row from client_chat_messages m where company_id=$1', [session.companyId])).rows;
      assert.equal((await getClientChatConversationForAdmin(session.companyId, admin)).messages.length, 1);
      await assert.rejects(markClientChatReadForAdmin(session.companyId, admin, ids), /архиве/);
      assert.deepEqual((await query('select row_to_json(m) as row from client_chat_messages m where company_id=$1', [session.companyId])).rows, before);
    });

    await t.test('message timestamps are assigned after company serialization, not at an older waiting transaction start', async () => {
      const session = await fixture();
      const blocker = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'synthetic-chat-blocker' });
      await blocker.connect();
      let waiting: Promise<unknown> | undefined;
      try {
        await blocker.query('begin');
        await blocker.query('select id from client_companies where id=$1 for update', [session.companyId]);
        waiting = createClientChatMessageForClient(session, 'Waiting client message');
        await until(async () => Number((await query(`select count(*)::int as count from pg_stat_activity
          where application_name like 'kts-next-admin:%' and wait_event_type='Lock'
          and query like '%select title from client_companies%'`)).rows[0].count) > 0);
        const first = (await blocker.query<{ id: string }>(`insert into client_chat_messages(company_id,author_type,body,created_at)
          values ($1,'employee','Earlier committed message',clock_timestamp()) returning id::text`, [session.companyId])).rows[0];
        await blocker.query('commit');
        await waiting;
        const after = await getClientChatConversationForAdmin(session.companyId, admin, { after: Number(first.id) });
        assert.equal(after.messages.length, 1);
        assert.equal(after.messages[0].body, 'Waiting client message');
      } finally {
        await blocker.query('rollback').catch(() => {});
        await waiting?.catch(() => {});
        await blocker.end();
      }
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
