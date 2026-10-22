import type { AdminSession } from '../adminAuth';
import type { ClientSession } from '../clientAuth';
import type { QueryResultRow } from 'pg';
import { query, withTransaction } from './client';
import { assertClientCompanyVisible, assertClientCompanyWritable } from './clientCompaniesRepo';
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
  readByViewer: boolean;
};

export type ClientChatConversation = {
  messages: ClientChatMessage[];
  unreadCount: number;
  olderCursor: number | null;
  newerCursor: number | null;
  hasOlder: boolean;
  hasNewer: boolean;
  readMessageIds: number[];
};

export type ClientChatPageOptions = { before?: number; after?: number; receiptIds?: number[] };
export type ClientChatReadReceipt = { acknowledgedIds: number[]; unreadCount: number; changed: boolean };
export const CLIENT_CHAT_PAGE_SIZE = 100;

export class ClientChatInputError extends Error {
  readonly status = 400;
}

type ChatDatabase = {
  query<T extends QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
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
  read_by_viewer?: boolean;
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
    readByViewer: Boolean(row.read_by_viewer),
  };
}

function unreadAuthorType(viewer: ClientChatAuthorType): ClientChatAuthorType {
  return viewer === 'client' ? 'employee' : 'client';
}

function readColumn(viewer: ClientChatAuthorType) {
  return viewer === 'client' ? 'client_read_at' : 'employee_read_at';
}

function validId(id: number) {
  return Number.isSafeInteger(id) && id > 0;
}

function boundedMessageIds(ids: number[]) {
  if (!Array.isArray(ids) || ids.length > CLIENT_CHAT_PAGE_SIZE || ids.some((id) => !validId(id))) {
    throw new ClientChatInputError('Некорректный список сообщений чата');
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

function validatePageOptions(options: ClientChatPageOptions) {
  if ((options.before !== undefined && !validId(options.before))
    || (options.after !== undefined && options.after !== 0 && !validId(options.after))
    || (options.before !== undefined && options.after !== undefined)) {
    throw new ClientChatInputError('Некорректная страница истории чата');
  }
  return boundedMessageIds(options.receiptIds ?? []);
}

async function assertClientChatSession(session: ClientSession, db: ChatDatabase, lock = false) {
  const company = await db.query<{ id: string }>(
    `select id::text from client_companies
     where id = $1 and is_active = true and archived_at is null${lock ? ' for share' : ''}`,
    [session.companyId],
  );
  if (!company.rows[0]) throw new Error('Компания клиента отключена или находится в архиве');
  const user = await db.query<{ id: string }>(
    `select id::text from client_users
     where id = $1 and company_id = $2 and is_active = true${lock ? ' for share' : ''}`,
    [session.clientUserId, session.companyId],
  );
  if (!user.rows[0]) throw new Error('Учётная запись клиента отключена');
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

async function unreadCount(companyId: number, viewer: ClientChatAuthorType, db: ChatDatabase) {
  const column = readColumn(viewer);
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count
     from client_chat_messages messages
     left join client_chat_read_state reads on reads.company_id = messages.company_id
     where messages.company_id = $1
       and messages.author_type = $2
       and messages.read_by_other_at is null
       and messages.created_at > coalesce(reads.${column}, 'epoch'::timestamptz)`,
    [companyId, unreadAuthorType(viewer)],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function getClientChatUnreadCount(companyId: number, viewer: ClientChatAuthorType) {
  await ensureSiteSchema();
  return unreadCount(companyId, viewer, { query });
}

/** Keyset pagination keeps the PostgreSQL microsecond timestamp intact. IDs are
 * resolved within this company, never accepted as a cross-company anchor. */
export async function getClientChatConversation(
  companyId: number,
  viewer: ClientChatAuthorType,
  options: ClientChatPageOptions = {},
): Promise<ClientChatConversation> {
  const receiptIds = validatePageOptions(options);
  await ensureSiteSchema();
  // after=0 starts catch-up in an initially empty conversation, oldest first.
  const anchorId = options.before ?? (options.after === 0 ? undefined : options.after);
  let anchorCreatedAt: string | null = null;
  if (anchorId !== undefined) {
    const anchor = await query<{ created_at: string }>(
      'select created_at::text from client_chat_messages where company_id = $1 and id = $2',
      [companyId, anchorId],
    );
    if (!anchor.rows[0]) throw new ClientChatInputError('Страница истории чата больше недоступна. Обновите чат.');
    anchorCreatedAt = anchor.rows[0].created_at;
  }
  const direction = options.after !== undefined ? 'asc' : 'desc';
  const boundary = anchorId === undefined ? '' : `and (messages.created_at, messages.id) ${options.after !== undefined ? '>' : '<'} ($3::timestamptz, $4::bigint)`;
  const ownReadColumn = readColumn(unreadAuthorType(viewer));
  const viewerReadColumn = readColumn(viewer);
  const result = await query<ClientChatMessageRow>(
    `select
       messages.id::text, messages.company_id::text, messages.author_type,
       messages.author_name, messages.body, messages.created_at::text,
       (messages.author_type = $2 and (messages.read_by_other_at is not null
         or messages.created_at <= coalesce(reads.${ownReadColumn}, 'epoch'::timestamptz))) as read_by_other,
       (messages.author_type <> $2 and (messages.read_by_other_at is not null
         or messages.created_at <= coalesce(reads.${viewerReadColumn}, 'epoch'::timestamptz))) as read_by_viewer
     from client_chat_messages messages
     left join client_chat_read_state reads on reads.company_id = messages.company_id
     where messages.company_id = $1 ${boundary}
     order by messages.created_at ${direction}, messages.id ${direction}
     limit ${CLIENT_CHAT_PAGE_SIZE + 1}`,
    anchorId === undefined ? [companyId, viewer] : [companyId, viewer, anchorCreatedAt, anchorId],
  );
  const more = result.rows.length > CLIENT_CHAT_PAGE_SIZE;
  const rows = result.rows.slice(0, CLIENT_CHAT_PAGE_SIZE);
  if (direction === 'desc') rows.reverse();
  const messages = rows.map(mapClientChatMessage);
  const receipts = receiptIds.length ? await query<{ id: string }>(
    `select messages.id::text from client_chat_messages messages
     left join client_chat_read_state reads on reads.company_id = messages.company_id
     where messages.company_id = $1 and messages.author_type = $2
       and messages.id = any($3::bigint[])
       and (messages.read_by_other_at is not null
         or messages.created_at <= coalesce(reads.${ownReadColumn}, 'epoch'::timestamptz))
     order by messages.id`,
    [companyId, viewer, receiptIds],
  ) : { rows: [] };
  return {
    messages,
    unreadCount: await unreadCount(companyId, viewer, { query }),
    olderCursor: messages[0]?.id ?? null,
    newerCursor: messages.at(-1)?.id ?? null,
    hasOlder: options.after !== undefined ? options.after > 0 : more,
    hasNewer: options.after !== undefined ? more : options.before !== undefined,
    readMessageIds: receipts.rows.map((row) => Number(row.id)),
  };
}

export async function getClientChatMessages(companyId: number, viewer: ClientChatAuthorType = 'employee'): Promise<ClientChatMessage[]> {
  return (await getClientChatConversation(companyId, viewer)).messages;
}

export async function getClientChatMessagesForAdmin(companyId: number, session: AdminSession) {
  await assertClientCompanyVisible(companyId, session);
  return getClientChatMessages(companyId);
}

export async function getClientChatMessagesForClient(session: ClientSession) {
  return (await getClientChatConversationForClient(session)).messages;
}

export async function getClientChatConversationForAdmin(companyId: number, session: AdminSession, options: ClientChatPageOptions = {}) {
  await ensureSiteSchema();
  await assertClientCompanyVisible(companyId, session);
  return getClientChatConversation(companyId, 'employee', options);
}

export async function getClientChatConversationForClient(session: ClientSession, options: ClientChatPageOptions = {}) {
  await ensureSiteSchema();
  await assertClientChatSession(session, { query });
  return getClientChatConversation(session.companyId, 'client', options);
}

async function acknowledgeClientChatMessages(
  companyId: number, viewer: ClientChatAuthorType, ids: number[], client: ChatDatabase,
): Promise<ClientChatReadReceipt> {
  const column = readColumn(viewer);
  // Lock in ID order for concurrent acknowledgements. Old company-wide markers
  // are a read-only compatibility floor, not a watermark for newly seen pages.
  const updated = await client.query<{ id: string }>(
    `with targets as (
       select messages.id from client_chat_messages messages
       left join client_chat_read_state reads on reads.company_id = messages.company_id
       where messages.company_id = $1 and messages.author_type = $2
         and messages.id = any($3::bigint[]) and messages.read_by_other_at is null
         and messages.created_at > coalesce(reads.${column}, 'epoch'::timestamptz)
       order by messages.id for update of messages
     )
     update client_chat_messages messages set read_by_other_at = now()
     from targets where messages.id = targets.id returning messages.id::text`,
    [companyId, unreadAuthorType(viewer), ids],
  );
  const acknowledged = await client.query<{ id: string }>(
    `select messages.id::text from client_chat_messages messages
     left join client_chat_read_state reads on reads.company_id = messages.company_id
     where messages.company_id = $1 and messages.author_type = $2
       and messages.id = any($3::bigint[])
       and (messages.read_by_other_at is not null
         or messages.created_at <= coalesce(reads.${column}, 'epoch'::timestamptz))
     order by messages.id`,
    [companyId, unreadAuthorType(viewer), ids],
  );
  return {
    acknowledgedIds: acknowledged.rows.map((row) => Number(row.id)),
    unreadCount: await unreadCount(companyId, viewer, client),
    changed: updated.rows.length > 0,
  };
}

export async function markClientChatReadForAdmin(companyId: number, session: AdminSession, messageIds: number[]) {
  const ids = boundedMessageIds(messageIds);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await assertClientCompanyWritable(companyId, session, client);
    return acknowledgeClientChatMessages(companyId, 'employee', ids, client);
  }, { profile: 'interactive', retryOnConflict: true });
}

export async function markClientChatReadForClient(session: ClientSession, messageIds: number[]) {
  const ids = boundedMessageIds(messageIds);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await assertClientChatSession(session, client, true);
    return acknowledgeClientChatMessages(session.companyId, 'client', ids, client);
  }, { profile: 'interactive', retryOnConflict: true });
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
      and messages.read_by_other_at is null
      and messages.created_at > coalesce(reads.employee_read_at, 'epoch'::timestamptz)
     where cc.archived_at is null
       and ($1::boolean = true or cc.manager_id = $2 or cc.support_manager_id = $2)
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
  return withTransaction(async (client) => {
    // Both senders serialize on this company. Stamp after the lock, not with
    // transaction-start now(): a delayed send must sort after the prior commit
    // so incremental readers cannot skip it behind their current cursor.
    const company = await client.query<{ title: string }>(
      `select title from client_companies
       where id = $1 and is_active = true and archived_at is null for update`,
      [session.companyId],
    );
    if (!company.rows[0]) throw new Error('Компания клиента отключена или находится в архиве');
    const user = await client.query<{ name: string }>(
      `select name from client_users where id = $1 and company_id = $2 and is_active = true for share`,
      [session.clientUserId, session.companyId],
    );
    if (!user.rows[0]) throw new Error('Учётная запись клиента отключена');
    const result = await client.query<ClientChatMessageRow>(
      `insert into client_chat_messages (company_id, client_user_id, author_type, author_name, body, created_at)
       values ($1, $2, 'client', $3, $4, clock_timestamp())
       returning id::text, company_id::text, author_type, author_name, body, created_at::text`,
      [session.companyId, session.clientUserId, user.rows[0].name || company.rows[0].title || 'Клиент', body],
    );
    return mapClientChatMessage(result.rows[0]);
  });
}

export async function createClientChatMessageForAdmin(companyId: number, session: AdminSession, body: string) {
  await ensureSiteSchema();
  const authorName = await getEmployeeAuthorName(session);
  return withTransaction(async (client) => {
    await assertClientCompanyWritable(companyId, session, client);
    // assertClientCompanyWritable holds the same company lock as client sends.
    const result = await client.query<ClientChatMessageRow>(
      `insert into client_chat_messages (company_id, admin_user_id, manager_id, author_type, author_name, body, created_at)
       values ($1, $2, $3, 'employee', $4, $5, clock_timestamp())
       returning id::text, company_id::text, author_type, author_name, body, created_at::text`,
      [companyId, session.adminUserId ?? null, session.managerId ?? null, authorName, body],
    );
    return mapClientChatMessage(result.rows[0]);
  });
}
