import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import type { AdminSession } from '../adminAuth';
import { query, withTransaction } from './client';
import { ClientArchiveConflictError } from './clientCompaniesRepo';
import { canSeeAllClients } from './clientCompaniesRepo.helpers';
import { ensureSiteSchema } from './schema';

export type ClientCompanyDeletionCounts = {
  users: number;
  sessions: number;
  twoFactorChallenges: number;
  chatMessages: number;
  chatReadStates: number;
  documents: number;
  files: number;
  fileBytes: number;
  priceRequests: number;
  priceLists: number;
};

export type ClientCompanyDeletionPreview = {
  id: number;
  title: string;
  archivedAt: string;
  updatedAt: string;
  revision: string;
  counts: ClientCompanyDeletionCounts;
};

type PreviewRow = {
  id: string;
  title: string;
  archived_at: string | null;
  updated_at: string;
} & Record<keyof ClientCompanyDeletionCounts, string>;

function assertPurgeAllowed(session: AdminSession) {
  if (!canSeeAllClients(session)) throw new Error('Окончательное удаление доступно только администратору клиентов');
}

const PREVIEW_SELECT = `select cc.id::text, cc.title, cc.archived_at::text, cc.updated_at::text,
  (select count(*)::text from client_users where company_id=cc.id) as "users",
  (select count(*)::text from client_sessions s join client_users u on u.id=s.client_user_id where u.company_id=cc.id) as "sessions",
  (select count(*)::text from admin_2fa_challenges c join client_users u on u.id=c.client_user_id where u.company_id=cc.id) as "twoFactorChallenges",
  (select count(*)::text from client_chat_messages where company_id=cc.id) as "chatMessages",
  (select count(*)::text from client_chat_read_state where company_id=cc.id) as "chatReadStates",
  (select count(*)::text from client_documents where company_id=cc.id) as "documents",
  (select count(distinct file_path)::text from client_documents where company_id=cc.id) as "files",
  (select coalesce(sum(d.size),0)::text from
    (select max(file_size) as size from client_documents where company_id=cc.id group by file_path) d) as "fileBytes",
  (select count(*)::text from client_price_requests where company_id=cc.id) as "priceRequests",
  (select count(*)::text from wholesale_price_lists where client_company_id=cc.id) as "priceLists"
  from client_companies cc where cc.id=$1`;

function mapPreview(row: PreviewRow | undefined): ClientCompanyDeletionPreview {
  if (!row) throw new Error('Компания клиента не найдена');
  if (!row.archived_at) throw new Error('Окончательно удалить можно только клиента из архива');
  const keys: (keyof ClientCompanyDeletionCounts)[] = ['users', 'sessions', 'twoFactorChallenges', 'chatMessages',
    'chatReadStates', 'documents', 'files', 'fileBytes', 'priceRequests', 'priceLists'];
  const counts = Object.fromEntries(keys.map((key) => [key, Number(row[key])])) as ClientCompanyDeletionCounts;
  const revision = createHash('sha256').update(JSON.stringify({ updatedAt: row.updated_at, counts })).digest('hex');
  return { id: Number(row.id), title: row.title, archivedAt: row.archived_at, updatedAt: row.updated_at, revision, counts };
}

async function readPreview(db: Pick<PoolClient, 'query'>, id: number) {
  return mapPreview((await db.query<PreviewRow>(PREVIEW_SELECT, [id])).rows[0]);
}

export async function getClientCompanyDeletionPreview(id: number, session: AdminSession) {
  assertPurgeAllowed(session);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Некорректная компания клиента');
  await ensureSiteSchema();
  // One SQL snapshot gives consistent counts without reserving/deleting anything.
  return mapPreview((await query<PreviewRow>(PREVIEW_SELECT, [id])).rows[0]);
}

export async function purgeArchivedClientCompany(
  id: number,
  session: AdminSession,
  input: { expectedUpdatedAt: string; expectedRevision: string; confirmationTitle: string },
) {
  assertPurgeAllowed(session);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Некорректная компания клиента');
  if (!input.expectedUpdatedAt || input.expectedUpdatedAt.length > 64 || !Number.isFinite(Date.parse(input.expectedUpdatedAt))) {
    throw new ClientArchiveConflictError();
  }
  if (typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) throw new ClientArchiveConflictError();
  if (typeof input.confirmationTitle !== 'string' || input.confirmationTitle.length > 200) {
    throw new Error('Для подтверждения введите точное название клиента');
  }
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    // The company lock serializes archive/restore, document mutations and FK
    // inserts (including incoming public-price requests) with permanent deletion.
    const locked = await client.query<{ title: string; archived_at: string | null; matches: boolean }>(
      `select title, archived_at::text, updated_at=$2::timestamptz as matches
       from client_companies where id=$1 for update`, [id, input.expectedUpdatedAt],
    );
    const company = locked.rows[0];
    if (!company) throw new Error('Компания клиента не найдена');
    if (!company.archived_at) throw new Error('Окончательно удалить можно только клиента из архива');
    if (!company.matches) throw new ClientArchiveConflictError();
    if (company.title !== input.confirmationTitle) throw new Error('Название клиента не совпадает. Удаление не выполнено.');
    await client.query('select id from client_users where company_id=$1 order by id for update', [id]);
    await client.query('select id from client_documents where company_id=$1 order by id for update', [id]);
    await client.query('select id from wholesale_price_lists where client_company_id=$1 order by id for update', [id]);
    const preview = await readPreview(client, id);
    // Incoming public-price requests remain possible while archived. They do not
    // update the company timestamp, so confirmation also binds the shown counts.
    if (preview.revision !== input.expectedRevision) throw new ClientArchiveConflictError();
    // Receipts survive the cascaded metadata deletion. No filesystem operation
    // may run until this transaction has committed successfully.
    const queued = await client.query<{ id: string }>(
      `insert into client_document_file_cleanup (document_id,company_id,file_path)
       select id,company_id,file_path from client_documents where company_id=$1 order by id returning id::text`, [id],
    );
    if (queued.rows.length !== preview.counts.documents) throw new Error('Не удалось подготовить очистку всех документов');
    const removed = await client.query('delete from client_companies where id=$1 and archived_at is not null', [id]);
    if (removed.rowCount !== 1) throw new Error('Окончательное удаление клиента не выполнено');
    const { priceLists, ...removedCounts } = preview.counts;
    return {
      id, title: company.title, removed: removedCounts, detachedPriceLists: priceLists,
      cleanupIds: queued.rows.map((row) => Number(row.id)),
    };
  }, { profile: 'interactive', trackCommitOutcome: true });
}
