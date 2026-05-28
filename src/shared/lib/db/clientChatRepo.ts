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
};

type ClientChatMessageRow = {
  id: string;
  company_id: string;
  author_type: ClientChatAuthorType;
  author_name: string;
  body: string;
  created_at: string;
};

function mapClientChatMessage(row: ClientChatMessageRow): ClientChatMessage {
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    authorType: row.author_type,
    authorName: row.author_name,
    body: row.body,
    createdAt: row.created_at,
  };
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

export async function getClientChatMessages(companyId: number): Promise<ClientChatMessage[]> {
  await ensureSiteSchema();
  const result = await query<ClientChatMessageRow>(
    `select *
     from (
       select id::text, company_id::text, author_type, author_name, body, created_at::text
       from client_chat_messages
       where company_id = $1
       order by created_at desc, id desc
       limit 300
     ) messages
     order by created_at asc, id asc`,
    [companyId],
  );
  return result.rows.map(mapClientChatMessage);
}

export async function getClientChatMessagesForAdmin(companyId: number, session: AdminSession) {
  await assertClientCompanyVisible(companyId, session);
  return getClientChatMessages(companyId);
}

export async function getClientChatMessagesForClient(session: ClientSession) {
  return getClientChatMessages(session.companyId);
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
