import type { AdminSession } from '../adminAuth';
import { query, withTransaction } from './client';
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

export async function assertClientCompanyVisible(id: number, session: AdminSession) {
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
       cc.require_2fa,
       count(cu.id)::text as user_count,
       coalesce(primary_user.login, '') as client_login,
       primary_user.id::text as client_user_id,
       primary_user.password_changed_at::text as password_changed_at,
       coalesce(primary_user.display_password, '') as display_password,
       (
         select count(*)::text
         from client_chat_messages ccm
         left join client_chat_read_state crs on crs.company_id = cc.id
         where ccm.company_id = cc.id
           and ccm.author_type = 'client'
           and ccm.created_at > coalesce(crs.employee_read_at, 'epoch'::timestamptz)
       ) as chat_unread_count,
       cc.is_active,
       cc.created_at::text,
       cc.updated_at::text
     from client_companies cc
     left join wholesale_managers manager on manager.id = cc.manager_id
     left join wholesale_managers support on support.id = cc.support_manager_id
     left join client_users cu on cu.company_id = cc.id
     left join lateral (
       select id, login, password_changed_at, display_password
       from client_users
       where company_id = cc.id
       order by created_at asc, id asc
       limit 1
     ) primary_user on true
     where ($1::boolean = true or cc.manager_id = $2 or cc.support_manager_id = $2)
     group by cc.id, manager.name, support.name, primary_user.id, primary_user.login, primary_user.password_changed_at, primary_user.display_password
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
         ''::text as display_password,
         '0'::text as chat_unread_count,
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
      display_password: string | null;
    }>(
      `select
         count(*)::text as count,
         (select login from client_users where company_id = $1 order by created_at asc, id asc limit 1) as login,
         (select id::text from client_users where company_id = $1 order by created_at asc, id asc limit 1) as id,
         (select password_changed_at::text from client_users where company_id = $1 order by created_at asc, id asc limit 1) as password_changed_at,
         (select display_password from client_users where company_id = $1 order by created_at asc, id asc limit 1) as display_password
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
      displayPassword: primaryUser.rows[0]?.display_password ?? '',
    };
  });
}

export async function updateClientCompany(
  id: number,
  input: ClientCompanyInput,
  session: AdminSession,
): Promise<ClientCompany> {
  await ensureSiteSchema();
  await assertClientCompanyVisible(id, session);
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
           require_2fa = $12,
           is_active = $13,
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
         require_2fa,
         (select count(*)::text from client_users where company_id = client_companies.id) as user_count,
         coalesce((select login from client_users where company_id = client_companies.id order by created_at asc, id asc limit 1), '') as client_login,
         (select id::text from client_users where company_id = client_companies.id order by created_at asc, id asc limit 1) as client_user_id,
         (select password_changed_at::text from client_users where company_id = client_companies.id order by created_at asc, id asc limit 1) as password_changed_at,
         coalesce((select display_password from client_users where company_id = client_companies.id order by created_at asc, id asc limit 1), '') as display_password,
         (
           select count(*)::text
           from client_chat_messages ccm
           left join client_chat_read_state crs on crs.company_id = client_companies.id
           where ccm.company_id = client_companies.id
             and ccm.author_type = 'client'
             and ccm.created_at > coalesce(crs.employee_read_at, 'epoch'::timestamptz)
         ) as chat_unread_count,
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
      display_password: string | null;
    }>(
      `select
         count(*)::text as count,
         (select login from client_users where company_id = $1 order by created_at asc, id asc limit 1) as login,
         (select id::text from client_users where company_id = $1 order by created_at asc, id asc limit 1) as id,
         (select password_changed_at::text from client_users where company_id = $1 order by created_at asc, id asc limit 1) as password_changed_at,
         (select display_password from client_users where company_id = $1 order by created_at asc, id asc limit 1) as display_password
       from client_users
       where company_id = $1`,
      [id],
    );
    return {
      ...mapClientCompany(result.rows[0]),
      userCount: Number(userCount.rows[0]?.count ?? 0),
      clientLogin: userCount.rows[0]?.login ?? '',
      clientUserId: userCount.rows[0]?.id ? Number(userCount.rows[0].id) : null,
      passwordChangedAt: userCount.rows[0]?.password_changed_at ?? '',
      displayPassword: userCount.rows[0]?.display_password ?? '',
    };
  });
}

export async function updateClientCompanyManagerAssignments(
  id: number,
  input: ClientCompanyManagerAssignmentsInput,
  session: AdminSession,
) {
  await ensureSiteSchema();
  await assertClientCompanyVisible(id, session);
  const assignments = await normalizeManagerAssignments(input, session);
  await assertManagerRole(assignments.managerId, 'manager');
  await assertManagerRole(assignments.supportManagerId, 'support_manager');

  await query(
    `update client_companies
     set manager_id = $2,
         support_manager_id = $3,
         updated_at = now()
     where id = $1`,
    [id, assignments.managerId, assignments.supportManagerId],
  );
}

export async function deleteClientCompany(id: number, session: AdminSession): Promise<ClientCompany> {
  await ensureSiteSchema();
  await assertClientCompanyVisible(id, session);

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
         cc.require_2fa,
         count(cu.id)::text as user_count,
         coalesce(primary_user.login, '') as client_login,
         primary_user.id::text as client_user_id,
         primary_user.password_changed_at::text as password_changed_at,
         coalesce(primary_user.display_password, '') as display_password,
         (
           select count(*)::text
           from client_chat_messages ccm
           left join client_chat_read_state crs on crs.company_id = cc.id
           where ccm.company_id = cc.id
             and ccm.author_type = 'client'
             and ccm.created_at > coalesce(crs.employee_read_at, 'epoch'::timestamptz)
         ) as chat_unread_count,
         cc.is_active,
         cc.created_at::text,
         cc.updated_at::text
       from client_companies cc
       left join wholesale_managers manager on manager.id = cc.manager_id
       left join wholesale_managers support on support.id = cc.support_manager_id
       left join client_users cu on cu.company_id = cc.id
       left join lateral (
         select id, login, password_changed_at, display_password
         from client_users
         where company_id = cc.id
         order by created_at asc, id asc
         limit 1
       ) primary_user on true
       where cc.id = $1
       group by cc.id, manager.name, support.name, primary_user.id, primary_user.login, primary_user.password_changed_at, primary_user.display_password
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
       cc.is_active as company_is_active,
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
           and ccm.created_at > coalesce(crs.client_read_at, 'epoch'::timestamptz)
       ) as chat_unread_count
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

export async function updateClientUserPassword(clientUserId: number, passwordHash: string, displayPassword = '') {
  await ensureSiteSchema();
  await query(
    `update client_users
     set password_hash = $2,
         display_password = $3,
         password_changed_at = now(),
         updated_at = now()
     where id = $1`,
    [clientUserId, passwordHash, displayPassword],
  );
}

export async function recordClientUserLogin(clientUserId: number) {
  await ensureSiteSchema();
  await query(`update client_users set last_login_at = now(), updated_at = now() where id = $1`, [clientUserId]);
}
