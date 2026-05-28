import type { PoolClient } from 'pg';

import type { AdminSession } from '../adminAuth';
import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';

export type ClientCompany = {
  id: number;
  title: string;
  inn: string;
  kpp: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  note: string;
  managerId: number | null;
  managerName: string;
  supportManagerId: number | null;
  supportManagerName: string;
  userCount: number;
  clientLogin: string;
  clientUserId: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ClientCompanyInput = {
  title: string;
  inn: string;
  kpp: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  note: string;
  managerId: number | null;
  supportManagerId: number | null;
  isActive: boolean;
  passwordHash?: string;
};

export type ClientPortalUserAuth = {
  id: number;
  companyId: number;
  companyTitle: string;
  name: string;
  email: string;
  phone: string;
  login: string;
  passwordHash: string;
  isActive: boolean;
  companyIsActive: boolean;
  passwordChangedAt: string | null;
};

export type ClientPortalProfile = {
  id: number;
  name: string;
  email: string;
  phone: string;
  login: string;
  company: {
    id: number;
    title: string;
    email: string;
    phone: string;
    managerName: string;
    supportManagerName: string;
  };
};

type ClientCompanyRow = {
  id: string;
  title: string;
  inn: string;
  kpp: string;
  contact_name: string;
  email: string;
  phone: string;
  address: string;
  note: string;
  manager_id: string | null;
  manager_name: string | null;
  support_manager_id: string | null;
  support_manager_name: string | null;
  user_count: string;
  client_login: string | null;
  client_user_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

function canSeeAllClients(session: AdminSession) {
  return session.role === 'admin' || session.role === 'wholesale_admin';
}

function mapClientCompany(row: ClientCompanyRow): ClientCompany {
  return {
    id: Number(row.id),
    title: row.title,
    inn: row.inn,
    kpp: row.kpp,
    contactName: row.contact_name,
    email: row.email,
    phone: row.phone,
    address: row.address,
    note: row.note,
    managerId: row.manager_id ? Number(row.manager_id) : null,
    managerName: row.manager_name ?? '',
    supportManagerId: row.support_manager_id ? Number(row.support_manager_id) : null,
    supportManagerName: row.support_manager_name ?? '',
    userCount: Number(row.user_count),
    clientLogin: row.client_login ?? '',
    clientUserId: row.client_user_id ? Number(row.client_user_id) : null,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeClientLogin(value: string) {
  return value.trim().toLowerCase();
}

async function upsertPrimaryClientUser(
  companyId: number,
  input: ClientCompanyInput,
  client?: Pick<PoolClient, 'query'>,
) {
  const db = client ?? { query };
  const login = normalizeClientLogin(input.email);
  if (!login) return;

  const existing = await db.query<{ id: string }>(
    `select id::text
     from client_users
     where company_id = $1
     order by created_at asc, id asc
     limit 1`,
    [companyId],
  );
  const existingId = existing.rows[0]?.id ? Number(existing.rows[0].id) : null;
  const name = input.title;
  const passwordHash = input.passwordHash || null;

  if (existingId) {
    await db.query(
      `update client_users
       set name = $2,
           email = $3,
           login = $3,
           phone = $4,
           password_hash = case when $5::text is null then password_hash else $5 end,
           password_changed_at = case when $5::text is null then password_changed_at else now() end,
           is_active = $6,
           updated_at = now()
       where id = $1`,
      [existingId, name, login, input.phone, passwordHash, input.isActive],
    );
    return;
  }

  if (!passwordHash) return;
  await db.query(
    `insert into client_users (company_id, name, email, phone, login, password_hash, is_active, password_changed_at)
     values ($1, $2, $3, $4, $3, $5, $6, now())`,
    [companyId, name, login, input.phone, passwordHash, input.isActive],
  );
}

function numberOrNull(value: number | null | undefined) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

async function normalizeManagerAssignments(input: ClientCompanyInput, session: AdminSession) {
  const managerId = numberOrNull(input.managerId);
  const supportManagerId = numberOrNull(input.supportManagerId);

  if (session.role === 'manager') {
    return { managerId: session.managerId ?? null, supportManagerId };
  }

  if (session.role === 'support_manager') {
    return { managerId, supportManagerId: session.managerId ?? null };
  }

  return { managerId, supportManagerId };
}

async function assertManagerRole(id: number | null, role: 'manager' | 'support_manager') {
  if (!id) return;
  const result = await query<{ id: string }>(
    `select id::text
     from wholesale_managers
     where id = $1 and role = $2 and is_active = true
     limit 1`,
    [id, role],
  );
  if (!result.rows[0]) {
    throw new Error(role === 'manager' ? 'Менеджер по развитию не найден' : 'Менеджер по сопровождению не найден');
  }
}

async function assertCompanyVisible(id: number, session: AdminSession) {
  if (canSeeAllClients(session)) return;
  const managerId = session.managerId ?? 0;
  const result = await query<{ id: string }>(
    `select id::text
     from client_companies
     where id = $1
       and (manager_id = $2 or support_manager_id = $2)
     limit 1`,
    [id, managerId],
  );
  if (!result.rows[0]) throw new Error('Компания клиента не найдена');
}

export async function getClientCompanies(session: AdminSession): Promise<ClientCompany[]> {
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
       count(cu.id)::text as user_count,
       coalesce(primary_user.login, '') as client_login,
       primary_user.id::text as client_user_id,
       cc.is_active,
       cc.created_at::text,
       cc.updated_at::text
     from client_companies cc
     left join wholesale_managers manager on manager.id = cc.manager_id
     left join wholesale_managers support on support.id = cc.support_manager_id
     left join client_users cu on cu.company_id = cc.id
     left join lateral (
       select id, login
       from client_users
       where company_id = cc.id
       order by created_at asc, id asc
       limit 1
     ) primary_user on true
     where ($1::boolean = true or cc.manager_id = $2 or cc.support_manager_id = $2)
     group by cc.id, manager.name, support.name, primary_user.id, primary_user.login
     order by cc.is_active desc, cc.title asc, cc.created_at desc`,
    [canSeeAllClients(session), session.managerId ?? 0],
  );
  return result.rows.map(mapClientCompany);
}

export async function createClientCompany(input: ClientCompanyInput, session: AdminSession): Promise<ClientCompany> {
  await ensureSiteSchema();
  const assignments = await normalizeManagerAssignments(input, session);
  await assertManagerRole(assignments.managerId, 'manager');
  await assertManagerRole(assignments.supportManagerId, 'support_manager');

  return withTransaction(async (client) => {
    const result = await client.query<ClientCompanyRow>(
      `insert into client_companies (
         title, inn, kpp, contact_name, email, phone, address, note,
         manager_id, support_manager_id, is_active
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
         '0'::text as user_count,
         ''::text as client_login,
         null::text as client_user_id,
         is_active,
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
        input.isActive,
      ],
    );
    const companyId = Number(result.rows[0].id);
    await upsertPrimaryClientUser(companyId, input, client);
    return {
      ...mapClientCompany(result.rows[0]),
      userCount: input.passwordHash && input.email ? 1 : 0,
      clientLogin: input.email ? normalizeClientLogin(input.email) : '',
    };
  });
}

export async function updateClientCompany(
  id: number,
  input: ClientCompanyInput,
  session: AdminSession,
): Promise<ClientCompany> {
  await ensureSiteSchema();
  await assertCompanyVisible(id, session);
  const assignments = await normalizeManagerAssignments(input, session);
  await assertManagerRole(assignments.managerId, 'manager');
  await assertManagerRole(assignments.supportManagerId, 'support_manager');

  return withTransaction(async (client) => {
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
           is_active = $12,
           updated_at = now()
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
         (select count(*)::text from client_users where company_id = client_companies.id) as user_count,
         coalesce((select login from client_users where company_id = client_companies.id order by created_at asc, id asc limit 1), '') as client_login,
         (select id::text from client_users where company_id = client_companies.id order by created_at asc, id asc limit 1) as client_user_id,
         is_active,
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
        input.isActive,
      ],
    );
    if (!result.rows[0]) throw new Error('Компания клиента не найдена');
    await upsertPrimaryClientUser(id, input, client);
    const userCount = await client.query<{ count: string; login: string | null; id: string | null }>(
      `select
         count(*)::text as count,
         (select login from client_users where company_id = $1 order by created_at asc, id asc limit 1) as login,
         (select id::text from client_users where company_id = $1 order by created_at asc, id asc limit 1) as id
       from client_users
       where company_id = $1`,
      [id],
    );
    return {
      ...mapClientCompany(result.rows[0]),
      userCount: Number(userCount.rows[0]?.count ?? 0),
      clientLogin: userCount.rows[0]?.login ?? '',
      clientUserId: userCount.rows[0]?.id ? Number(userCount.rows[0].id) : null,
    };
  });
}

export async function deleteClientCompany(id: number, session: AdminSession): Promise<ClientCompany> {
  await ensureSiteSchema();
  await assertCompanyVisible(id, session);

  return withTransaction(async (client) => {
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
         count(cu.id)::text as user_count,
         coalesce(primary_user.login, '') as client_login,
         primary_user.id::text as client_user_id,
         cc.is_active,
         cc.created_at::text,
         cc.updated_at::text
       from client_companies cc
       left join wholesale_managers manager on manager.id = cc.manager_id
       left join wholesale_managers support on support.id = cc.support_manager_id
       left join client_users cu on cu.company_id = cc.id
       left join lateral (
         select id, login
         from client_users
         where company_id = cc.id
         order by created_at asc, id asc
         limit 1
       ) primary_user on true
       where cc.id = $1
       group by cc.id, manager.name, support.name, primary_user.id, primary_user.login
       limit 1`,
      [id],
    );
    if (!result.rows[0]) throw new Error('Компания клиента не найдена');

    const company = mapClientCompany(result.rows[0]);
    await client.query(`delete from client_companies where id = $1`, [id]);
    return company;
  });
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
       cc.is_active as company_is_active,
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
    support_manager_name: string | null;
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
       support.name as support_manager_name
     from client_users cu
     join client_companies cc on cc.id = cu.company_id
     left join wholesale_managers manager on manager.id = cc.manager_id
     left join wholesale_managers support on support.id = cc.support_manager_id
     where cu.id = $1
       and cu.is_active = true
       and cc.is_active = true
     limit 1`,
    [clientUserId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    email: row.email,
    phone: row.phone,
    login: row.login,
    company: {
      id: Number(row.company_id),
      title: row.company_title,
      email: row.company_email,
      phone: row.company_phone,
      managerName: row.manager_name ?? '',
      supportManagerName: row.support_manager_name ?? '',
    },
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

export async function updateClientUserPassword(clientUserId: number, passwordHash: string) {
  await ensureSiteSchema();
  await query(
    `update client_users
     set password_hash = $2,
         password_changed_at = now(),
         updated_at = now()
     where id = $1`,
    [clientUserId, passwordHash],
  );
}

export async function recordClientUserLogin(clientUserId: number) {
  await ensureSiteSchema();
  await query(`update client_users set last_login_at = now(), updated_at = now() where id = $1`, [clientUserId]);
}
