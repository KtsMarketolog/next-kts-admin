import type { PoolClient } from 'pg';

import type { AdminSession } from '../adminAuth';
import { encryptClientPassword } from '../clientPasswordVault';
import { loginCredentialProof, LoginCredentialsChangedError } from '../loginCredentialProof';
import { query, withTransaction } from './client';
import { writeClientCompanyPriceListAssignments } from './clientCompanyPriceListAssignments';
import { revokeClientUserSessions } from './clientSessionsRepo';
import { ensureSiteSchema } from './schema';

export type {
  ClientCompany,
  ClientCompanyInput,
  ClientCompanyManagerAssignmentsInput,
  ClientPortalUserAuth,
  ClientPortalProfile,
  ClientCompanyPriceList
} from './clientCompanyTypes';
import type {
  ClientCompany,
  ClientCompanyInput,
  ClientCompanyManagerAssignmentsInput,
  ClientPortalUserAuth,
  ClientPortalProfile,
  ClientCompanyPriceList
} from './clientCompanyTypes';

import {
  canSeeAllClients,
  mapClientCompany,
  mapClientCompanyPriceList,
  normalizeClientLogin,
  normalizeManagerAssignments,
  upsertPrimaryClientUser,
  type ClientCompanyPriceListRow,
  type ClientCompanyRow,
} from './clientCompaniesRepo.helpers';

async function assertManagerAssignments(
  assignments: { managerId: number | null; supportManagerId: number | null },
  client?: Pick<PoolClient, 'query'>,
) {
  const db = client ?? { query };
  const ids = [assignments.managerId, assignments.supportManagerId].filter((id) => id !== null);
  if (!ids.length) return;
  // Same manager -> company -> price lock order as price-list saves.
  const result = await db.query<{ id: string; role: string; is_active: boolean }>(
    `select id::text, role, is_active
     from wholesale_managers
     where id = any($1::bigint[]) order by id${client ? ' for share' : ''}`,
    [ids],
  );
  for (const [id, role] of [[assignments.managerId, 'manager'], [assignments.supportManagerId, 'support_manager']] as const) {
    if (id && !result.rows.some((row) => Number(row.id) === id && row.role === role && row.is_active)) {
      throw new Error(role === 'manager' ? 'Менеджер по развитию не найден' : 'Менеджер по сопровождению не найден');
    }
  }
}

export async function assertClientCompanyVisible(id: number, session: AdminSession, client?: Pick<PoolClient, 'query'>) {
  if (!client && canSeeAllClients(session)) return;
  const db = client ?? { query };
  const managerId = session.managerId ?? 0;
  const result = await db.query<{ id: string }>(
    `select id::text
     from client_companies
     where id = $1
       and ($3::boolean or manager_id = $2 or support_manager_id = $2)
     limit 1${client ? ' for update' : ''}`,
    [id, managerId, canSeeAllClients(session)],
  );
  if (!result.rows[0]) throw new Error('Компания клиента не найдена');
}

/** Call inside the write transaction: archive and mutations serialize on the company row. */
export async function assertClientCompanyWritable(id: number, session: AdminSession, client: Pick<PoolClient, 'query'>) {
  await assertClientCompanyVisible(id, session, client);
  const result = await client.query<{ archived_at: string | null }>(
    'select archived_at::text from client_companies where id = $1', [id],
  );
  if (!result.rows[0]) throw new Error('Компания клиента не найдена');
  if (result.rows[0].archived_at) throw new Error('Клиент в архиве. Сначала восстановите его; данные не изменены.');
}

export async function getClientCompanyPriceLists(
  companyId: number,
  options: { session?: AdminSession; activeOnly?: boolean } = {},
): Promise<ClientCompanyPriceList[]> {
  await ensureSiteSchema();
  if (options.session) await assertClientCompanyVisible(companyId, options.session);

  const result = await query<ClientCompanyPriceListRow>(
    `select
       pl.id::text,
       pl.title,
       pl.token,
       pl.valid_until::text,
       pl.workflow_status,
       pl.is_active,
       pl.created_at::text,
       pl.updated_at::text,
       count(wpli.id)::text as item_count
     from wholesale_price_lists pl
     left join wholesale_price_list_items wpli on wpli.price_list_id = pl.id and wpli.visible = true
     where pl.client_company_id = $1
       and ($2::boolean = false or pl.is_active = true)
     group by pl.id
     order by pl.is_active desc, pl.updated_at desc, pl.created_at desc`,
    [companyId, options.activeOnly === true],
  );

  return result.rows.map(mapClientCompanyPriceList);
}

export async function getClientCompanies(session: AdminSession, scope: 'active' | 'archived' | 'all' = 'active'): Promise<ClientCompany[]> {
  await ensureSiteSchema();
  const result = await query<ClientCompanyRow>(
    `select
       cc.id::text,
       cc.title,
       cc.inn,
       cc.kpp,
       cc.contact_name,
       cc.email,
       cc.phone,
       cc.address,
       cc.note,
       cc.manager_id::text,
       coalesce(manager.name, '') as manager_name,
       cc.support_manager_id::text,
       coalesce(support.name, '') as support_manager_name,
       cc.require_2fa,
       count(cu.id)::text as user_count,
       coalesce(primary_user.login, '') as client_login,
       primary_user.id::text as client_user_id,
       primary_user.password_changed_at::text as password_changed_at,
       (
         select count(*)::text
         from client_chat_messages ccm
         left join client_chat_read_state crs on crs.company_id = cc.id
         where ccm.company_id = cc.id
           and ccm.author_type = 'client'
           and ccm.read_by_other_at is null
           and ccm.created_at > coalesce(crs.employee_read_at, 'epoch'::timestamptz)
       ) as chat_unread_count,
       cc.is_active,
       cc.archived_at::text,
       cc.created_at::text,
       cc.updated_at::text
     from client_companies cc
     left join wholesale_managers manager on manager.id = cc.manager_id
     left join wholesale_managers support on support.id = cc.support_manager_id
     left join client_users cu on cu.company_id = cc.id
     left join lateral (
       select id, login, password_changed_at
       from client_users
       where company_id = cc.id
       order by created_at asc, id asc
       limit 1
     ) primary_user on true
     where ($1::boolean = true or cc.manager_id = $2 or cc.support_manager_id = $2)
       and ($3::text = 'all' or ($3 = 'archived' and cc.archived_at is not null) or ($3 = 'active' and cc.archived_at is null))
     group by cc.id, manager.name, support.name, primary_user.id, primary_user.login, primary_user.password_changed_at
     order by cc.is_active desc, cc.title asc, cc.created_at desc`,
    [canSeeAllClients(session), session.managerId ?? 0, scope],
  );
  return result.rows.map(mapClientCompany);
}

export async function createClientCompany(input: ClientCompanyInput, session: AdminSession): Promise<ClientCompany> {
  await ensureSiteSchema();
  const assignments = await normalizeManagerAssignments(input, session);

  return withTransaction(async (client) => {
    await assertManagerAssignments(assignments, client);
    const result = await client.query<ClientCompanyRow>(
      `insert into client_companies (
         title, inn, kpp, contact_name, email, phone, address, note,
         manager_id, support_manager_id, require_2fa, is_active
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       returning
         id::text,
         title,
         inn,
         kpp,
         contact_name,
         email,
         phone,
         address,
         note,
         manager_id::text,
         coalesce((select name from wholesale_managers where id = client_companies.manager_id), '') as manager_name,
         support_manager_id::text,
         coalesce((select name from wholesale_managers where id = client_companies.support_manager_id), '') as support_manager_name,
         require_2fa,
         '0'::text as user_count,
         ''::text as client_login,
         null::text as client_user_id,
         null::text as password_changed_at,
         '0'::text as chat_unread_count,
         is_active,
         archived_at::text,
         created_at::text,
         updated_at::text`,
      [
        input.title,
        input.inn,
        input.kpp,
        input.contactName,
        input.email,
        input.phone,
        input.address,
        input.note,
        assignments.managerId,
        assignments.supportManagerId,
        input.requireTwoFactor,
        input.isActive,
      ],
    );
    const companyId = Number(result.rows[0].id);
    await upsertPrimaryClientUser(companyId, input, client);
    const primaryUser = await client.query<{
      count: string;
      login: string | null;
      id: string | null;
      password_changed_at: string | null;
    }>(
      `select
         count(*)::text as count,
         (select login from client_users where company_id = $1 order by created_at asc, id asc limit 1) as login,
         (select id::text from client_users where company_id = $1 order by created_at asc, id asc limit 1) as id,
         (select password_changed_at::text from client_users where company_id = $1 order by created_at asc, id asc limit 1) as password_changed_at
       from client_users
       where company_id = $1`,
      [companyId],
    );
    return {
      ...mapClientCompany(result.rows[0]),
      userCount: Number(primaryUser.rows[0]?.count ?? 0),
      clientLogin: primaryUser.rows[0]?.login ?? '',
      clientUserId: primaryUser.rows[0]?.id ? Number(primaryUser.rows[0].id) : null,
      passwordChangedAt: primaryUser.rows[0]?.password_changed_at ?? '',
    };
  }, { trackCommitOutcome: true });
}

export async function updateClientCompany(
  id: number,
  input: ClientCompanyInput,
  session: AdminSession,
): Promise<ClientCompany> {
  await ensureSiteSchema();
  const assignments = await normalizeManagerAssignments(input, session);

  return withTransaction(async (client) => {
    await assertManagerAssignments(assignments, client);
    // Permission cannot become stale between checking and updating ownership.
    await assertClientCompanyWritable(id, session, client);
    if (!input.expectedUpdatedAt || !Number.isFinite(Date.parse(input.expectedUpdatedAt))) throw new ClientArchiveConflictError();
    const version = await client.query<{ matches: boolean }>(
      'select updated_at = $2::timestamptz as matches from client_companies where id = $1', [id, input.expectedUpdatedAt],
    );
    if (!version.rows[0]?.matches) throw new ClientArchiveConflictError();
    const result = await client.query<ClientCompanyRow>(
      `update client_companies
       set title = $2,
           inn = $3,
           kpp = $4,
           contact_name = $5,
           email = $6,
           phone = $7,
           address = $8,
           note = $9,
           manager_id = $10,
           support_manager_id = $11,
           require_2fa = $12,
           is_active = $13,
           updated_at = clock_timestamp()
       where id = $1
       returning
         id::text,
         title,
         inn,
         kpp,
         contact_name,
         email,
         phone,
         address,
         note,
         manager_id::text,
         coalesce((select name from wholesale_managers where id = client_companies.manager_id), '') as manager_name,
         support_manager_id::text,
         coalesce((select name from wholesale_managers where id = client_companies.support_manager_id), '') as support_manager_name,
         require_2fa,
         (select count(*)::text from client_users where company_id = client_companies.id) as user_count,
         coalesce((select login from client_users where company_id = client_companies.id order by created_at asc, id asc limit 1), '') as client_login,
         (select id::text from client_users where company_id = client_companies.id order by created_at asc, id asc limit 1) as client_user_id,
         (select password_changed_at::text from client_users where company_id = client_companies.id order by created_at asc, id asc limit 1) as password_changed_at,
         (
           select count(*)::text
           from client_chat_messages ccm
           left join client_chat_read_state crs on crs.company_id = client_companies.id
           where ccm.company_id = client_companies.id
             and ccm.author_type = 'client'
             and ccm.read_by_other_at is null
             and ccm.created_at > coalesce(crs.employee_read_at, 'epoch'::timestamptz)
         ) as chat_unread_count,
         is_active,
         archived_at::text,
         created_at::text,
         updated_at::text`,
      [
        id,
        input.title,
        input.inn,
        input.kpp,
        input.contactName,
        input.email,
        input.phone,
        input.address,
        input.note,
        assignments.managerId,
        assignments.supportManagerId,
        input.requireTwoFactor,
        input.isActive,
      ],
    );
    if (!result.rows[0]) throw new Error('Компания клиента не найдена');
    await upsertPrimaryClientUser(id, input, client);
    const userCount = await client.query<{
      count: string;
      login: string | null;
      id: string | null;
      password_changed_at: string | null;
    }>(
      `select
         count(*)::text as count,
         (select login from client_users where company_id = $1 order by created_at asc, id asc limit 1) as login,
         (select id::text from client_users where company_id = $1 order by created_at asc, id asc limit 1) as id,
         (select password_changed_at::text from client_users where company_id = $1 order by created_at asc, id asc limit 1) as password_changed_at
       from client_users
       where company_id = $1`,
      [id],
    );
    const company = {
      ...mapClientCompany(result.rows[0]),
      userCount: Number(userCount.rows[0]?.count ?? 0),
      clientLogin: userCount.rows[0]?.login ?? '',
      clientUserId: userCount.rows[0]?.id ? Number(userCount.rows[0].id) : null,
      passwordChangedAt: userCount.rows[0]?.password_changed_at ?? '',
    };
    await writeClientCompanyPriceListAssignments(client, id, assignments);
    if (input.passwordHash && company.clientUserId) {
      await revokeClientUserSessions(company.clientUserId, client);
    }
    return company;
  }, { trackCommitOutcome: true });
}

export async function updateClientCompanyManagerAssignments(
  id: number,
  input: ClientCompanyManagerAssignmentsInput,
  session: AdminSession,
) {
  await ensureSiteSchema();
  const assignments = await normalizeManagerAssignments(input, session);
  await withTransaction(async (client) => {
    await assertManagerAssignments(assignments, client);
    await assertClientCompanyWritable(id, session, client);
    await client.query(
    `update client_companies
     set manager_id = $2,
         support_manager_id = $3,
         updated_at = now()
     where id = $1`,
    [id, assignments.managerId, assignments.supportManagerId],
    );
  }, { trackCommitOutcome: true });
}

export class ClientArchiveConflictError extends Error {
  constructor() { super('Данные клиента уже изменены другим пользователем. Обновите список перед повторной попыткой.'); }
}

// Kept as a compatibility export for the old DELETE endpoint. Never physically deletes a company.
export async function deleteClientCompany(id: number, session: AdminSession, expectedUpdatedAt: string): Promise<ClientCompany> {
  return changeClientArchiveState(id, session, expectedUpdatedAt, true);
}

export async function restoreClientCompany(id: number, session: AdminSession, expectedUpdatedAt: string): Promise<ClientCompany> {
  return changeClientArchiveState(id, session, expectedUpdatedAt, false);
}

async function changeClientArchiveState(id: number, session: AdminSession, expectedUpdatedAt: string, archive: boolean): Promise<ClientCompany> {
  await ensureSiteSchema();

  return withTransaction(async (client) => {
    await assertClientCompanyVisible(id, session, client);
    const version = await client.query<{ matches: boolean }>(
      'select updated_at = $2::timestamptz as matches from client_companies where id = $1', [id, expectedUpdatedAt],
    );
    if (!version.rows[0]?.matches) throw new ClientArchiveConflictError();
    const result = await client.query<ClientCompanyRow>(
      `select
         cc.id::text,
         cc.title,
         cc.inn,
         cc.kpp,
         cc.contact_name,
         cc.email,
         cc.phone,
         cc.address,
         cc.note,
         cc.manager_id::text,
         coalesce(manager.name, '') as manager_name,
         cc.support_manager_id::text,
         coalesce(support.name, '') as support_manager_name,
         cc.require_2fa,
         count(cu.id)::text as user_count,
         coalesce(primary_user.login, '') as client_login,
         primary_user.id::text as client_user_id,
         primary_user.password_changed_at::text as password_changed_at,
         (
           select count(*)::text
           from client_chat_messages ccm
           left join client_chat_read_state crs on crs.company_id = cc.id
           where ccm.company_id = cc.id
             and ccm.author_type = 'client'
             and ccm.read_by_other_at is null
             and ccm.created_at > coalesce(crs.employee_read_at, 'epoch'::timestamptz)
         ) as chat_unread_count,
         cc.is_active,
         cc.archived_at::text,
         cc.created_at::text,
         cc.updated_at::text
       from client_companies cc
       left join wholesale_managers manager on manager.id = cc.manager_id
       left join wholesale_managers support on support.id = cc.support_manager_id
       left join client_users cu on cu.company_id = cc.id
       left join lateral (
         select id, login, password_changed_at
         from client_users
         where company_id = cc.id
         order by created_at asc, id asc
         limit 1
       ) primary_user on true
       where cc.id = $1
       group by cc.id, manager.name, support.name, primary_user.id, primary_user.login, primary_user.password_changed_at
       limit 1`,
      [id],
    );
    if (!result.rows[0]) throw new Error('Компания клиента не найдена');

    const company = mapClientCompany(result.rows[0]);
    if (Boolean(company.archivedAt) === archive) return company;
    const changed = await client.query<{ archived_at: string | null; updated_at: string }>(
      `update client_companies set archived_at = case when $2::boolean then clock_timestamp() else null end,
         is_active = false, updated_at = clock_timestamp() where id = $1
       returning archived_at::text, updated_at::text`, [id, archive],
    );
    // Restore also revokes sessions; it never reopens access automatically.
    await client.query(`update client_sessions set revoked_at = coalesce(revoked_at, now())
      where client_user_id in (select id from client_users where company_id = $1) and revoked_at is null`, [id]);
    return { ...company, isActive: false, archivedAt: changed.rows[0].archived_at, updatedAt: changed.rows[0].updated_at };
  }, { trackCommitOutcome: true });
}

export async function getClientUserByLogin(login: string): Promise<ClientPortalUserAuth | null> {
  await ensureSiteSchema();
  const normalizedLogin = normalizeClientLogin(login);
  if (!normalizedLogin) return null;

  const result = await query<{
    id: string;
    company_id: string;
    company_title: string;
    name: string;
    email: string;
    phone: string;
    login: string;
    password_hash: string;
    is_active: boolean;
    company_is_active: boolean;
    require_2fa: boolean;
    password_changed_at: string | null;
  }>(
    `select
       cu.id::text,
       cu.company_id::text,
       cc.title as company_title,
       cu.name,
       cu.email,
       cu.phone,
       cu.login,
       cu.password_hash,
       cu.is_active,
       (cc.is_active and cc.archived_at is null) as company_is_active,
       cc.require_2fa,
       cu.password_changed_at::text
     from client_users cu
     join client_companies cc on cc.id = cu.company_id
     where lower(cu.login) = $1 or lower(cu.email) = $1
     limit 1`,
    [normalizedLogin],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    companyTitle: row.company_title,
    name: row.name,
    email: row.email,
    phone: row.phone,
    login: row.login,
    passwordHash: row.password_hash,
    isActive: row.is_active,
    companyIsActive: row.company_is_active,
    requireTwoFactor: row.require_2fa,
    passwordChangedAt: row.password_changed_at,
  };
}

export async function getClientPortalProfile(clientUserId: number): Promise<ClientPortalProfile | null> {
  await ensureSiteSchema();
  const result = await query<{
    id: string;
    name: string;
    email: string;
    phone: string;
    login: string;
    company_id: string;
    company_title: string;
    company_email: string;
    company_phone: string;
    manager_name: string | null;
    manager_email: string | null;
    manager_phone: string | null;
    support_manager_name: string | null;
    support_manager_email: string | null;
    support_manager_phone: string | null;
    chat_unread_count: string;
  }>(
    `select
       cu.id::text,
       cu.name,
       cu.email,
       cu.phone,
       cu.login,
       cc.id::text as company_id,
       cc.title as company_title,
       cc.email as company_email,
       cc.phone as company_phone,
       manager.name as manager_name,
       manager.email as manager_email,
       manager.phone as manager_phone,
       support.name as support_manager_name,
       support.email as support_manager_email,
       support.phone as support_manager_phone,
       (
         select count(*)::text
         from client_chat_messages ccm
         left join client_chat_read_state crs on crs.company_id = cc.id
         where ccm.company_id = cc.id
           and ccm.author_type = 'employee'
           and ccm.read_by_other_at is null
           and ccm.created_at > coalesce(crs.client_read_at, 'epoch'::timestamptz)
       ) as chat_unread_count
     from client_users cu
     join client_companies cc on cc.id = cu.company_id
     left join wholesale_managers manager on manager.id = cc.manager_id
     left join wholesale_managers support on support.id = cc.support_manager_id
     where cu.id = $1
       and cu.is_active = true
       and cc.is_active = true
       and cc.archived_at is null
     limit 1`,
    [clientUserId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const companyId = Number(row.company_id);
  const priceLists = await getClientCompanyPriceLists(companyId, { activeOnly: true });
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    phone: row.phone,
    login: row.login,
    company: {
      id: companyId,
      title: row.company_title,
      email: row.company_email,
      phone: row.company_phone,
      managerName: row.manager_name ?? '',
      managerEmail: row.manager_email ?? '',
      managerPhone: row.manager_phone ?? '',
      supportManagerName: row.support_manager_name ?? '',
      supportManagerEmail: row.support_manager_email ?? '',
      supportManagerPhone: row.support_manager_phone ?? '',
      chatUnreadCount: Number(row.chat_unread_count ?? 0),
    },
    priceLists,
  };
}

export async function getClientUserPasswordHash(clientUserId: number) {
  await ensureSiteSchema();
  const result = await query<{ password_hash: string }>(
    `select password_hash from client_users where id = $1 and is_active = true limit 1`,
    [clientUserId],
  );
  return result.rows[0]?.password_hash ?? '';
}

export async function updateClientUserPassword(clientUserId: number, passwordHash: string, displayPassword = '', expectedPasswordHash?: string) {
  await ensureSiteSchema();
  const ciphertext = displayPassword ? encryptClientPassword(displayPassword, passwordHash) : null;
  return withTransaction(async (client) => {
    const company = await client.query(`select cc.id from client_companies cc
      join client_users cu on cu.company_id = cc.id
      where cu.id = $1 and cu.is_active = true and cc.is_active = true and cc.archived_at is null
      for update of cc`, [clientUserId]);
    if (!company.rows[0]) throw new Error('Клиент недоступен');
    const changed = await client.query<{ id: string; login: string; email: string; password_hash: string; password_changed_at: string }>(
    `update client_users
     set password_hash = $2,
         password_ciphertext = $3,
         display_password = '',
         password_changed_at = clock_timestamp(),
         updated_at = now()
     where id = $1 and ($4::text is null or (password_hash = $4 and is_active = true))
     returning id::text, login, email, password_hash, password_changed_at::text`,
    [clientUserId, passwordHash, ciphertext, expectedPasswordHash ?? null],
    );
    const row = changed.rows[0];
    if (!row) throw new LoginCredentialsChangedError();
    // Keep credential replacement and revocation atomic, including sessions
    // created while this transaction was waiting for the company lock.
    await revokeClientUserSessions(clientUserId, client);
    return loginCredentialProof('client', 'client', { id: Number(row.id), login: row.login, email: row.email,
      passwordHash: row.password_hash, passwordChangedAt: row.password_changed_at });
  }, { trackCommitOutcome: true });
}

export async function recordClientUserLogin(clientUserId: number) {
  await ensureSiteSchema();
  await query(`update client_users set last_login_at = now(), updated_at = now() where id = $1`, [clientUserId]);
}
