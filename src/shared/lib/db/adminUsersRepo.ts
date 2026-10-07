import type { PoolClient } from 'pg';

import { parseDashboardAccess } from '../dashboardAccess';
import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';
import { dashboardAccessVersion, getDashboardGrants, saveDashboardGrants, DASHBOARD_ACCESS_LOCK } from './dashboardAccessRepo';

export type AdminUserRole = 'admin' | 'wholesale_admin' | 'top' | 'admintop' | 'purchaser';
export type ManagerAccessRole = 'manager' | 'support_manager';
export type AccessUserRole = AdminUserRole | ManagerAccessRole;
export type AccessUserSource = 'admin' | 'manager';

export type AdminUserAuth = {
  id: number;
  login: string;
  name: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
  role: AdminUserRole;
  canManageTopDashboard: boolean;
  passwordChangedAt: string | null;
};

export type AccessUser = {
  id: string;
  source: AccessUserSource;
  numericId: number;
  name: string;
  login: string;
  email: string;
  role: AccessUserRole;
  isActive: boolean;
  canManageTopDashboard: boolean;
  dashboardAccess: string[];
  dashboardAccessVersion?: string;
  accesses: string[];
  priceListCount: number;
  supportManagerId: number | null;
  supportManagerName: string;
  isCurrent: boolean;
  createdAt: string;
  updatedAt: string;
};

type AccessUserInput = {
  name: string;
  login: string;
  email: string;
  role: AccessUserRole;
  isActive: boolean;
  canManageTopDashboard: boolean;
  dashboardAccess?: string[];
  dashboardAccessVersion?: string;
  passwordHash?: string;
  supportManagerId?: number | null;
};

type AccessUserRow = {
  source: AccessUserSource;
  id: string;
  name: string;
  login: string;
  email: string;
  role: string;
  is_active: boolean;
  can_manage_top_dashboard: boolean;
  price_list_count: string;
  support_manager_id: string | null;
  support_manager_name: string | null;
  created_at: string;
  updated_at: string;
};

type ParsedAccessUserId = {
  source: AccessUserSource;
  numericId: number;
};

function normalizeLogin(login: string) {
  return login.trim().toLowerCase();
}

function normalizeAdminRole(role: string): AdminUserRole {
  if (role === 'admin' || role === 'wholesale_admin' || role === 'top' || role === 'admintop' || role === 'purchaser') return role;
  throw new Error('Некорректная роль пользователя');
}

function normalizeAccessRole(role: string): AccessUserRole | null {
  if (
    role === 'admin'
    || role === 'wholesale_admin'
    || role === 'manager'
    || role === 'support_manager'
    || role === 'top'
    || role === 'admintop'
    || role === 'purchaser'
  ) {
    return role;
  }
  return null;
}

function isManagerAccessRole(role: AccessUserRole): role is ManagerAccessRole {
  return role === 'manager' || role === 'support_manager';
}

function normalizeTopManagementAccess(role: AccessUserRole, value: unknown) {
  return (role === 'top' || role === 'manager' || role === 'support_manager') && value === true;
}

function accessLabels(role: AccessUserRole, canManageTopDashboard: boolean) {
  if (role === 'admin') return ['Сайт', 'Прайсы', 'Пользователи'];
  if (role === 'wholesale_admin') return ['Индивидуальные прайсы'];
  if (role === 'top') {
    return canManageTopDashboard
      ? ['HTML-страницы: просмотр', 'HTML-страницы: управление']
      : ['HTML-страницы: просмотр'];
  }
  if (role === 'admintop') return ['HTML-страницы: управление'];
  if (role === 'purchaser') return ['Только выбранные дашборды: просмотр'];
  if (role === 'support_manager') return ['Прайсы менеджера'];
  return ['Свои прайсы'];
}

function mapAccessUser(row: AccessUserRow, currentAdminUserId?: number | null): AccessUser {
  const role = normalizeAccessRole(row.role);
  if (!role) throw new Error('Некорректная роль пользователя');
  const numericId = Number(row.id);
  const canManageTopDashboard = normalizeTopManagementAccess(role, row.can_manage_top_dashboard);
  return {
    id: `${row.source}:${numericId}`,
    source: row.source,
    numericId,
    name: row.name,
    login: row.login,
    email: row.email,
    role,
    isActive: row.is_active,
    canManageTopDashboard,
    dashboardAccess: [],
    accesses: accessLabels(role, canManageTopDashboard),
    priceListCount: Number(row.price_list_count),
    supportManagerId: row.support_manager_id ? Number(row.support_manager_id) : null,
    supportManagerName: row.support_manager_name ?? '',
    isCurrent: row.source === 'admin' && Boolean(currentAdminUserId) && numericId === currentAdminUserId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseAccessUserId(id: string): ParsedAccessUserId | null {
  const normalized = decodeURIComponent(id).trim();
  const [source, numeric] = normalized.split(':');
  const numericId = Number(numeric);
  if ((source !== 'admin' && source !== 'manager') || !Number.isInteger(numericId) || numericId <= 0) return null;
  return { source, numericId };
}

/** User changes and access changes share a transaction; no partial profile can be saved. */
async function saveDashboardAccess(
  client: Pick<PoolClient, 'query'>,
  userId: number,
  role: AccessUserRole,
  value: string[] | undefined,
  previous?: AccessUser,
) {
  return saveDashboardGrants(client,{source:isManagerAccessRole(role)?'manager':'admin',numericId:userId,role},value ?? previous?.dashboardAccess);
}

async function assertLoginAvailable(
  login: string,
  exclude?: { source: AccessUserSource; numericId: number },
  client?: Pick<PoolClient, 'query'>,
) {
  const db = client ?? { query };
  const normalizedLogin = normalizeLogin(login);
  const adminResult = await db.query<{ id: string }>(
    `select id::text
     from admin_users
     where login = $1
       and ($2::text <> 'admin' or id <> $3::bigint)
     limit 1`,
    [normalizedLogin, exclude?.source ?? '', exclude?.numericId ?? 0],
  );
  if (adminResult.rows.length > 0) {
    throw new Error('Пользователь с таким логином уже есть');
  }

  const managerResult = await db.query<{ id: string }>(
    `select id::text
     from wholesale_managers
     where login = $1
       and ($2::text <> 'manager' or id <> $3::bigint)
     limit 1`,
    [normalizedLogin, exclude?.source ?? '', exclude?.numericId ?? 0],
  );
  if (managerResult.rows.length > 0) {
    throw new Error('Пользователь с таким логином уже есть');
  }
}

async function countActiveSiteAdmins(client?: Pick<PoolClient, 'query'>) {
  const db = client ?? { query };
  const result = await db.query<{ count: string }>(
    `select count(*)::text as count
     from admin_users
     where role = 'admin' and is_active = true`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function normalizeSupportManagerId(
  role: AccessUserRole,
  supportManagerId: number | null | undefined,
  self?: { source: AccessUserSource; numericId: number },
  client?: Pick<PoolClient, 'query'>,
) {
  if (role !== 'manager') return null;
  if (supportManagerId === null || supportManagerId === undefined || supportManagerId === 0) return null;

  const numericId = Number(supportManagerId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error('Некорректный менеджер по сопровождению');
  }
  if (self?.source === 'manager' && self.numericId === numericId) {
    throw new Error('Нельзя назначить менеджера сопровождения самим собой');
  }

  const db = client ?? { query };
  const result = await db.query<{ id: string }>(
    `select id::text
     from wholesale_managers
     where id = $1 and role = 'support_manager'
     limit 1`,
    [numericId],
  );
  if (!result.rows[0]) {
    throw new Error('Менеджер по сопровождению не найден');
  }
  return numericId;
}

export async function getAdminUserByLogin(login: string): Promise<AdminUserAuth | null> {
  await ensureSiteSchema();
  const result = await query<{
    id: string;
    login: string;
    name: string;
    email: string;
    password_hash: string;
    is_active: boolean;
    role: string;
    can_manage_top_dashboard: boolean;
    password_changed_at: string | null;
  }>(
    `select id::text, login, name, email, password_hash, is_active, role,
            can_manage_top_dashboard, password_changed_at::text
     from admin_users
     where login = $1 or lower(email) = $1
     limit 1`,
    [normalizeLogin(login)],
  );

  const row = result.rows[0];
  if (!row) return null;
  const role = normalizeAdminRole(row.role);

  return {
    id: Number(row.id),
    login: row.login,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    isActive: row.is_active,
    role,
    canManageTopDashboard: normalizeTopManagementAccess(role, row.can_manage_top_dashboard),
    passwordChangedAt: row.password_changed_at,
  };
}

export async function getAccessUsers(currentAdminUserId?: number | null): Promise<AccessUser[]> {
  await ensureSiteSchema();
  const result = await query<AccessUserRow>(`
    select *
    from (
      select
        'admin'::text as source,
        au.id::text,
        au.name,
        au.login,
        au.email,
        au.role,
        au.is_active,
        au.can_manage_top_dashboard,
        '0'::text as price_list_count,
        null::text as support_manager_id,
        ''::text as support_manager_name,
        au.created_at::text,
        au.updated_at::text
      from admin_users au
      union all
      select
        'manager'::text as source,
        wm.id::text,
        wm.name,
        wm.login,
        wm.email,
        coalesce(nullif(wm.role, ''), 'manager') as role,
        wm.is_active,
        wm.can_manage_top_dashboard,
        count(pl.id)::text as price_list_count,
        wm.support_manager_id::text as support_manager_id,
        coalesce(support.name, '') as support_manager_name,
        wm.created_at::text,
        wm.updated_at::text
      from wholesale_managers wm
      left join wholesale_price_lists pl on pl.manager_id = wm.id
      left join wholesale_managers support on support.id = wm.support_manager_id
      group by wm.id, support.name
    ) users
    order by
      case role when 'admin' then 1 when 'wholesale_admin' then 2 when 'admintop' then 3 when 'top' then 4 when 'manager' then 5 when 'support_manager' then 6 else 7 end,
      is_active desc,
      name asc,
      login asc
  `);

  const users = result.rows.map((row) => mapAccessUser(row, currentAdminUserId));
  const grants=await query<{admin_user_id:string|null;manager_id:string|null;key:string}>('select admin_user_id::text,manager_id::text,key from dashboard_view_grants order by key');
  for (const user of users) {
    user.dashboardAccess=grants.rows.filter((grant)=>Number(user.source==='admin'?grant.admin_user_id:grant.manager_id)===user.numericId).map((grant)=>grant.key);
    user.dashboardAccessVersion=dashboardAccessVersion(user.dashboardAccess);
  }
  return users;
}

export async function createAccessUser(input: AccessUserInput & { passwordHash: string }): Promise<AccessUser> {
  if (input.dashboardAccess !== undefined && parseDashboardAccess(input.dashboardAccess) === null) {
    throw new Error('Некорректный список доступных дашбордов');
  }
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))',[DASHBOARD_ACCESS_LOCK]);
    await assertLoginAvailable(input.login, undefined, client);

    if (isManagerAccessRole(input.role)) {
      const supportManagerId = await normalizeSupportManagerId(input.role, input.supportManagerId, undefined, client);
      const result = await client.query<AccessUserRow>(
        `insert into wholesale_managers (name, login, email, phone, role, support_manager_id, password_hash, is_active, password_changed_at)
         values ($1, $2, $3, '', $4, $5, $6, $7, now())
         returning
           'manager'::text as source,
           id::text,
           name,
           login,
           email,
           role,
           is_active,
           false as can_manage_top_dashboard,
           '0'::text as price_list_count,
           support_manager_id::text as support_manager_id,
           coalesce((select name from wholesale_managers support where support.id = wholesale_managers.support_manager_id), '') as support_manager_name,
           created_at::text,
           updated_at::text`,
        [input.name, normalizeLogin(input.login), input.email, input.role, supportManagerId, input.passwordHash, input.isActive],
      );
      const user=mapAccessUser(result.rows[0]);
      user.dashboardAccess=await saveDashboardAccess(client,user.numericId,user.role,input.dashboardAccess);
      user.dashboardAccessVersion=dashboardAccessVersion(user.dashboardAccess);
      return user;
    }

    const result = await client.query<AccessUserRow>(
      `insert into admin_users (
         name, login, email, role, can_manage_top_dashboard, password_hash, is_active, password_changed_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, now())
       returning
         'admin'::text as source,
         id::text,
         name,
         login,
         email,
         role,
         is_active,
         can_manage_top_dashboard,
         '0'::text as price_list_count,
         null::text as support_manager_id,
         ''::text as support_manager_name,
         created_at::text,
         updated_at::text`,
      [
        input.name,
        normalizeLogin(input.login),
        input.email,
        input.role,
        normalizeTopManagementAccess(input.role, input.canManageTopDashboard),
        input.passwordHash,
        input.isActive,
      ],
    );
    const user = mapAccessUser(result.rows[0]);
    user.dashboardAccess = await saveDashboardAccess(client, user.numericId, user.role, input.dashboardAccess);
    user.dashboardAccessVersion=dashboardAccessVersion(user.dashboardAccess);
    return user;
  });
}

export async function updateAccessUser(
  id: string,
  input: AccessUserInput,
  currentAdminUserId?: number | null,
): Promise<{
  user: AccessUser;
  previous: AccessUser;
  roleChanged: boolean;
  permissionsChanged: boolean;
  passwordChanged: boolean;
}> {
  if (input.dashboardAccess !== undefined && parseDashboardAccess(input.dashboardAccess) === null) {
    throw new Error('Некорректный список доступных дашбордов');
  }
  await ensureSiteSchema();
  const parsed = parseAccessUserId(id);
  if (!parsed) throw new Error('Некорректный пользователь');

  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))',[DASHBOARD_ACCESS_LOCK]);
    await assertLoginAvailable(input.login, parsed, client);

    if (parsed.source === 'admin') {
      const existingResult = await client.query<AccessUserRow>(
        `select
           'admin'::text as source,
           id::text,
           name,
           login,
           email,
           role,
           is_active,
           can_manage_top_dashboard,
           '0'::text as price_list_count,
           null::text as support_manager_id,
           ''::text as support_manager_name,
           created_at::text,
           updated_at::text
         from admin_users
         where id = $1
         limit 1 for update`,
        [parsed.numericId],
      );
      const existingRow = existingResult.rows[0];
      if (!existingRow) throw new Error('Пользователь не найден');
      const previous = mapAccessUser(existingRow, currentAdminUserId);
      previous.dashboardAccess = await getDashboardGrants(client,'admin',previous.numericId);
      if(input.dashboardAccessVersion!==undefined && input.dashboardAccessVersion!==dashboardAccessVersion(previous.dashboardAccess)) throw new Error('Доступы уже изменены в другом окне. Обновите список сотрудников.');
      const isSelf = previous.isCurrent;
      const nextRole = input.role;
      const nextCanManageTopDashboard = normalizeTopManagementAccess(
        nextRole,
        input.canManageTopDashboard,
      );
      const activeAdminCount = await countActiveSiteAdmins(client);

      if (isSelf && (nextRole !== 'admin' || !input.isActive)) {
        throw new Error('Нельзя снять с себя права администратора');
      }
      if (previous.role === 'admin' && (nextRole !== 'admin' || !input.isActive) && activeAdminCount <= 1) {
        throw new Error('Нельзя удалить или отключить последнего администратора');
      }

      if (isManagerAccessRole(nextRole)) {
        const supportManagerId = await normalizeSupportManagerId(nextRole, input.supportManagerId, undefined, client);
        const insertResult = await client.query<AccessUserRow>(
          `insert into wholesale_managers (name, login, email, phone, role, support_manager_id, password_hash, is_active, password_changed_at)
           select $1, $2, $3, '', $4, $5, coalesce($6::text, password_hash), $7, case when $6::text is null then password_changed_at else now() end
           from admin_users
           where id = $8
           returning
             'manager'::text as source,
             id::text,
             name,
             login,
             email,
             role,
             is_active,
             can_manage_top_dashboard,
             '0'::text as price_list_count,
             support_manager_id::text as support_manager_id,
             coalesce((select name from wholesale_managers support where support.id = wholesale_managers.support_manager_id), '') as support_manager_name,
             created_at::text,
             updated_at::text`,
          [
            input.name,
            normalizeLogin(input.login),
            input.email,
            nextRole,
            supportManagerId,
            input.passwordHash ?? null,
            input.isActive,
            parsed.numericId,
          ],
        );
        await client.query(`delete from admin_users where id = $1`, [parsed.numericId]);
        const user=mapAccessUser(insertResult.rows[0],currentAdminUserId);
        user.dashboardAccess=await saveDashboardAccess(client,user.numericId,user.role,input.dashboardAccess,previous);
        user.dashboardAccessVersion=dashboardAccessVersion(user.dashboardAccess);
        return {
          previous,
          user,
          roleChanged: true,
          permissionsChanged: previous.canManageTopDashboard || previous.dashboardAccess.length > 0,
          passwordChanged: Boolean(input.passwordHash),
        };
      }

      const updateResult = await client.query<AccessUserRow>(
        `update admin_users
         set name = $2,
             login = $3,
             email = $4,
             role = $5,
             can_manage_top_dashboard = $6,
             password_hash = case when $7::text is null then password_hash else $7 end,
             password_changed_at = case when $7::text is null then password_changed_at else now() end,
             is_active = $8,
             updated_at = now()
         where id = $1
         returning
           'admin'::text as source,
           id::text,
           name,
           login,
           email,
           role,
           is_active,
           can_manage_top_dashboard,
           '0'::text as price_list_count,
           null::text as support_manager_id,
           ''::text as support_manager_name,
           created_at::text,
           updated_at::text`,
        [
          parsed.numericId,
          input.name,
          normalizeLogin(input.login),
          input.email,
          nextRole,
          nextCanManageTopDashboard,
          input.passwordHash ?? null,
          input.isActive,
        ],
      );
      const user = mapAccessUser(updateResult.rows[0], currentAdminUserId);
      user.dashboardAccess = await saveDashboardAccess(
        client, user.numericId, nextRole, input.dashboardAccess, previous,
      );
      user.dashboardAccessVersion=dashboardAccessVersion(user.dashboardAccess);
      return {
        previous,
        user,
        roleChanged: previous.role !== nextRole || previous.isActive !== input.isActive,
        permissionsChanged: previous.canManageTopDashboard !== nextCanManageTopDashboard
          || JSON.stringify(previous.dashboardAccess) !== JSON.stringify(user.dashboardAccess),
        passwordChanged: Boolean(input.passwordHash),
      };
    }

    const existingResult = await client.query<AccessUserRow>(
      `select
         'manager'::text as source,
         wm.id::text,
         wm.name,
         wm.login,
         wm.email,
         coalesce(nullif(wm.role, ''), 'manager') as role,
         wm.is_active,
         wm.can_manage_top_dashboard,
         count(pl.id)::text as price_list_count,
         wm.support_manager_id::text as support_manager_id,
         coalesce(support.name, '') as support_manager_name,
         wm.created_at::text,
         wm.updated_at::text
       from wholesale_managers wm
       left join wholesale_price_lists pl on pl.manager_id = wm.id
       left join wholesale_managers support on support.id = wm.support_manager_id
       where wm.id = $1
       group by wm.id, support.name
       limit 1`,
      [parsed.numericId],
    );
    const existingRow = existingResult.rows[0];
    if (!existingRow) throw new Error('Пользователь не найден');
    const previous = mapAccessUser(existingRow, currentAdminUserId);
    previous.dashboardAccess=await getDashboardGrants(client,'manager',previous.numericId);
    if(input.dashboardAccessVersion!==undefined && input.dashboardAccessVersion!==dashboardAccessVersion(previous.dashboardAccess)) throw new Error('Доступы уже изменены в другом окне. Обновите список сотрудников.');

    if (!isManagerAccessRole(input.role)) {
      if (previous.priceListCount > 0) {
        throw new Error('Сначала передайте прайсы другому менеджеру, затем меняйте роль');
      }
      const nextCanManageTopDashboard = normalizeTopManagementAccess(
        input.role,
        input.canManageTopDashboard,
      );
      const insertResult = await client.query<AccessUserRow>(
        `insert into admin_users (
           name, login, email, role, can_manage_top_dashboard, password_hash, is_active, password_changed_at
         )
         select $1, $2, $3, $4, $5, coalesce($6::text, password_hash), $7,
                case when $6::text is null then password_changed_at else now() end
         from wholesale_managers
         where id = $8
         returning
           'admin'::text as source,
           id::text,
           name,
           login,
           email,
           role,
           is_active,
           can_manage_top_dashboard,
           '0'::text as price_list_count,
           null::text as support_manager_id,
           ''::text as support_manager_name,
           created_at::text,
           updated_at::text`,
        [
          input.name,
          normalizeLogin(input.login),
          input.email,
          input.role,
          nextCanManageTopDashboard,
          input.passwordHash ?? null,
          input.isActive,
          parsed.numericId,
        ],
      );
      await client.query(`delete from wholesale_managers where id = $1`, [parsed.numericId]);
      const user = mapAccessUser(insertResult.rows[0], currentAdminUserId);
      user.dashboardAccess = await saveDashboardAccess(client, user.numericId, user.role, input.dashboardAccess,previous);
      user.dashboardAccessVersion=dashboardAccessVersion(user.dashboardAccess);
      return {
        previous,
        user,
        roleChanged: true,
        permissionsChanged: nextCanManageTopDashboard || user.dashboardAccess.length > 0,
        passwordChanged: Boolean(input.passwordHash),
      };
    }

    const supportManagerId = await normalizeSupportManagerId(input.role, input.supportManagerId, parsed, client);
    if (previous.role === 'support_manager' && input.role !== 'support_manager') {
      await client.query(`update wholesale_managers set support_manager_id = null where support_manager_id = $1`, [parsed.numericId]);
    }
    const updateResult = await client.query<AccessUserRow>(
      `update wholesale_managers
       set name = $2,
           login = $3,
           email = $4,
           password_hash = case when $5::text is null then password_hash else $5 end,
           password_changed_at = case when $5::text is null then password_changed_at else now() end,
           is_active = $6,
           role = $7,
           support_manager_id = $8,
           updated_at = now()
       where id = $1
       returning
         'manager'::text as source,
         id::text,
         name,
         login,
         email,
         role,
         is_active,
         can_manage_top_dashboard,
         (select count(*)::text from wholesale_price_lists where manager_id = wholesale_managers.id) as price_list_count,
         support_manager_id::text as support_manager_id,
         coalesce((select name from wholesale_managers support where support.id = wholesale_managers.support_manager_id), '') as support_manager_name,
         created_at::text,
         updated_at::text`,
      [
        parsed.numericId,
        input.name,
        normalizeLogin(input.login),
        input.email,
        input.passwordHash ?? null,
        input.isActive,
        input.role,
        supportManagerId,
      ],
    );

    const user=mapAccessUser(updateResult.rows[0],currentAdminUserId);
    user.dashboardAccess=await saveDashboardAccess(client,user.numericId,user.role,input.dashboardAccess,previous);
    user.dashboardAccessVersion=dashboardAccessVersion(user.dashboardAccess);
    return {
      previous,
      user,
      roleChanged:
        previous.role !== input.role || previous.isActive !== input.isActive || previous.supportManagerId !== supportManagerId,
      permissionsChanged: dashboardAccessVersion(previous.dashboardAccess)!==user.dashboardAccessVersion,
      passwordChanged: Boolean(input.passwordHash),
    };
  });
}

export async function deleteAccessUser(id: string, currentAdminUserId?: number | null): Promise<AccessUser> {
  await ensureSiteSchema();
  const parsed = parseAccessUserId(id);
  if (!parsed) throw new Error('Некорректный пользователь');

  return withTransaction(async (client) => {
    if (parsed.source === 'admin') {
      const existingResult = await client.query<AccessUserRow>(
        `select
           'admin'::text as source,
           id::text,
           name,
           login,
           email,
           role,
           is_active,
           can_manage_top_dashboard,
           '0'::text as price_list_count,
           null::text as support_manager_id,
           ''::text as support_manager_name,
           created_at::text,
           updated_at::text
         from admin_users
         where id = $1
         limit 1`,
        [parsed.numericId],
      );
      const row = existingResult.rows[0];
      if (!row) throw new Error('Пользователь не найден');
      const user = mapAccessUser(row, currentAdminUserId);
      if (user.isCurrent) throw new Error('Нельзя удалить самого себя');
      if (user.role === 'admin' && user.isActive && (await countActiveSiteAdmins(client)) <= 1) {
        throw new Error('Нельзя удалить последнего администратора');
      }
      await client.query(`delete from admin_users where id = $1`, [parsed.numericId]);
      return user;
    }

    const existingResult = await client.query<AccessUserRow>(
      `select
         'manager'::text as source,
         wm.id::text,
         wm.name,
         wm.login,
         wm.email,
         coalesce(nullif(wm.role, ''), 'manager') as role,
         wm.is_active,
         false as can_manage_top_dashboard,
         count(pl.id)::text as price_list_count,
         wm.support_manager_id::text as support_manager_id,
         coalesce(support.name, '') as support_manager_name,
         wm.created_at::text,
         wm.updated_at::text
       from wholesale_managers wm
       left join wholesale_price_lists pl on pl.manager_id = wm.id
       left join wholesale_managers support on support.id = wm.support_manager_id
       where wm.id = $1
       group by wm.id, support.name
       limit 1`,
      [parsed.numericId],
    );
    const row = existingResult.rows[0];
    if (!row) throw new Error('Пользователь не найден');
    const user = mapAccessUser(row, currentAdminUserId);
    await client.query(`delete from wholesale_managers where id = $1`, [parsed.numericId]);
    return user;
  });
}
