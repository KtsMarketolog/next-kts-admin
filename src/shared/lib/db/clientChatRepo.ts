import type { AdminSession } from '../adminAuth';
import type { ClientSession } from '../clientAuth';
import { query } from './client';
import { assertClientCompanyVisible } from './clientCompaniesRepo';
import { ensureSiteSchema } from './schema';

export type ClientChatAuthorType = 'client' | 'employee';

export type ClientChatMessage = {
  id: number;
  companyId: number;
  authorType: ClientChatAuthorType;
  authorName: string;
  body: string;
  createdAt: string;
  readByOther: boolean;
};

export type ClientChatConversation = {
  messages: ClientChatMessage[];
  unreadCount: number;
};

export type ClientChatUnreadCount = {
  companyId: number;
  unreadCount: number;
};

type ClientChatMessageRow = {
  id: string;
  company_id: string;
  author_type: ClientChatAuthorType;
  author_name: string;
  body: string;
  created_at: string;
  read_by_other?: boolean;
};

type ClientChatReadStateRow = {
  client_read_at: string;
  employee_read_at: string;
};

function mapClientChatMessage(row: ClientChatMessageRow): ClientChatMessage {
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    authorType: row.author_type,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
    readByOther: Boolean(row.read_by_other),
  };
}

function unreadAuthorType(viewer: ClientChatAuthorType): ClientChatAuthorType {
  return viewer === 'client' ? 'employee' : 'client';
}

function readColumn(viewer: ClientChatAuthorType) {
  return viewer === 'client' ? 'client_read_at' : 'employee_read_at';
}

async function ensureClientChatReadState(companyId: number) {
  await query(
    `insert into client_chat_read_state (company_id)
     values ($1)
     on conflict (company_id) do nothing`,
    [companyId],
  );
}

async function markClientChatRead(companyId: number, viewer: ClientChatAuthorType) {
  const column = readColumn(viewer);
  await query(
    `insert into client_chat_read_state (company_id, ${column}, updated_at)
     values ($1, now(), now())
     on conflict (company_id) do update
     set ${column} = greatest(client_chat_read_state.${column}, now()),
         updated_at = now()`,
    [companyId],
  );
}

async function getClientChatReadState(companyId: number) {
  await ensureClientChatReadState(companyId);
  const result = await query<ClientChatReadStateRow>(
    `select client_read_at::text, employee_read_at::text
     from client_chat_read_state
     where company_id = $1
     limit 1`,
    [companyId],
  );
  return result.rows[0] ?? { client_read_at: '1970-01-01T00:00:00.000Z', employee_read_at: '1970-01-01T00:00:00.000Z' };
}

async function getClientAuthorName(clientUserId: number) {
  const result = await query<{ name: string; company_title: string }>(
    `select cu.name, cc.title as company_title
     from client_users cu
     join client_companies cc on cc.id = cu.company_id
     where cu.id = $1
     limit 1`,
    [clientUserId],
  );
  const row = result.rows[0];
  return row?.name || row?.company_title || 'Клиент';
}

async function getEmployeeAuthorName(session: AdminSession) {
  if (session.managerId) {
    const result = await query<{ name: string }>(`select name from wholesale_managers where id = $1 limit 1`, [session.managerId]);
    return result.rows[0]?.name || 'Менеджер';
  }

  if (session.adminUserId) {
    const result = await query<{ name: string; login: string }>(`select name, login from admin_users where id = $1 limit 1`, [
      session.adminUserId,
    ]);
    return result.rows[0]?.name || result.rows[0]?.login || 'Администратор';
  }

  return session.role === 'wholesale_admin' ? 'Администратор прайсов' : 'Администратор';
}

export async function getClientChatUnreadCount(companyId: number, viewer: ClientChatAuthorType) {
  await ensureSiteSchema();
  const column = readColumn(viewer);
  const result = await query<{ count: string }>(
    `select count(*)::text as count
     from client_chat_messages messages
     left join client_chat_read_state reads on reads.company_id = messages.company_id
     where messages.company_id = $1
       and messages.author_type = $2
       and messages.created_at > coalesce(reads.${column}, 'epoch'::timestamptz)`,
    [companyId, unreadAuthorType(viewer)],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function getClientChatMessages(companyId: number, viewer?: ClientChatAuthorType): Promise<ClientChatMessage[]> {
  await ensureSiteSchema();
  const readState = viewer ? await getClientChatReadState(companyId) : null;
  const otherReadAt = viewer === 'client' ? readState?.employee_read_at : readState?.client_read_at;
  const result = await query<ClientChatMessageRow>(
    `select
       id::text,
       company_id::text,
       author_type,
       author_name,
       body,
       created_at::text,
       case when $2::text <> '' and author_type = $2 and created_at <= $3::timestamptz then true else false end as read_by_other
     from (
       select id, company_id, author_type, author_name, body, created_at
       from client_chat_messages
       where company_id = $1
       order by created_at desc, id desc
       limit 300
     ) messages
     order by created_at asc, id asc`,
    [companyId, viewer ?? '', otherReadAt ?? 'epoch'],
  );
  return result.rows.map(mapClientChatMessage);
}

export async function getClientChatConversation(companyId: number, viewer: ClientChatAuthorType): Promise<ClientChatConversation> {
  await ensureSiteSchema();
  await markClientChatRead(companyId, viewer);
  return {
    messages: await getClientChatMessages(companyId, viewer),
    unreadCount: 0,
  };
}

export async function getClientChatMessagesForAdmin(companyId: number, session: AdminSession) {
  await assertClientCompanyVisible(companyId, session);
  return getClientChatMessages(companyId);
}

export async function getClientChatMessagesForClient(session: ClientSession) {
  return getClientChatMessages(session.companyId);
}

export async function getClientChatConversationForAdmin(companyId: number, session: AdminSession) {
  await assertClientCompanyVisible(companyId, session);
  return getClientChatConversation(companyId, 'employee');
}

export async function getClientChatConversationForClient(session: ClientSession) {
  return getClientChatConversation(session.companyId, 'client');
}

export async function getClientChatUnreadCountForAdmin(companyId: number, session: AdminSession) {
  await assertClientCompanyVisible(companyId, session);
  return getClientChatUnreadCount(companyId, 'employee');
}

export async function getClientChatUnreadCountForClient(session: ClientSession) {
  return getClientChatUnreadCount(session.companyId, 'client');
}

export async function getClientChatUnreadCountsForAdmin(session: AdminSession): Promise<ClientChatUnreadCount[]> {
  await ensureSiteSchema();
  const canSeeAllClients = session.role === 'admin' || session.role === 'wholesale_admin';
  const result = await query<{ company_id: string; unread_count: string }>(
    `select cc.id::text as company_id,
            count(messages.id)::text as unread_count
     from client_companies cc
     left join client_chat_read_state reads on reads.company_id = cc.id
     left join client_chat_messages messages
       on messages.company_id = cc.id
      and messages.author_type = 'client'
      and messages.created_at > coalesce(reads.employee_read_at, 'epoch'::timestamptz)
     where ($1::boolean = true or cc.manager_id = $2 or cc.support_manager_id = $2)
     group by cc.id`,
    [canSeeAllClients, session.managerId ?? 0],
  );
  return result.rows.map((row) => ({
    companyId: Number(row.company_id),
    unreadCount: Number(row.unread_count),
  }));
}

export async function createClientChatMessageForClient(session: ClientSession, body: string) {
  await ensureSiteSchema();
  const authorName = await getClientAuthorName(session.clientUserId);
  const result = await query<ClientChatMessageRow>(
    `insert into client_chat_messages (company_id, client_user_id, author_type, author_name, body)
     values ($1, $2, 'client', $3, $4)
     returning id::text, company_id::text, author_type, author_name, body, created_at::text`,
    [session.companyId, session.clientUserId, authorName, body],
  );
  return mapClientChatMessage(result.rows[0]);
}

export async function createClientChatMessageForAdmin(companyId: number, session: AdminSession, body: string) {
  await ensureSiteSchema();
  await assertClientCompanyVisible(companyId, session);
  const authorName = await getEmployeeAuthorName(session);
  const result = await query<ClientChatMessageRow>(
    `insert into client_chat_messages (company_id, admin_user_id, manager_id, author_type, author_name, body)
     values ($1, $2, $3, 'employee', $4, $5)
     returning id::text, company_id::text, author_type, author_name, body, created_at::text`,
    [companyId, session.adminUserId ?? null, session.managerId ?? null, authorName, body],
  );
  return mapClientChatMessage(result.rows[0]);
}
