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
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
       cc.is_active,
       cc.created_at::text,
       cc.updated_at::text
     from client_companies cc
     left join wholesale_managers manager on manager.id = cc.manager_id
     left join wholesale_managers support on support.id = cc.support_manager_id
     left join client_users cu on cu.company_id = cc.id
     where ($1::boolean = true or cc.manager_id = $2 or cc.support_manager_id = $2)
     group by cc.id, manager.name, support.name
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

  const result = await query<ClientCompanyRow>(
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
  return mapClientCompany(result.rows[0]);
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
    return mapClientCompany(result.rows[0]);
  });
}
