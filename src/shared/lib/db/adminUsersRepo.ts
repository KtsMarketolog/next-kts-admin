import type { PoolClient } from 'pg';

import { parseDashboardAccess } from '../dashboardAccess';
import { AccessUserProfileForbiddenError, assertAccessUserManagementAllowed, assertDelegatedAccessOnly, DashboardOptionsConflictError } from '../accessUserManagement';
import type { AdminSessionRole } from '../adminAuth';
import { resolveEmployeePasswordCiphertext } from '../employeePasswordVault';
import { rethrowEmployeeIdentifierConflict } from '../employeeIdentifierConflict';
import { assertRecordRevision, RecordVersionConflictError } from '../recordVersion';
import { revokeAdminUserSessions, revokeManagerSessions } from './adminSessionsRepo';
import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';
import { dashboardAccessVersion, dashboardGrantOptionsVersion, getDashboardGrantOptions, getDashboardGrants, saveDashboardGrants, DASHBOARD_ACCESS_LOCK } from './dashboardAccessRepo';

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
  revision: string;
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
  expectedRevision?: string;
  name: string;
  login: string;
  email: string;
  role: AccessUserRole;
  isActive: boolean;
  canManageTopDashboard: boolean;
  dashboardAccess?: string[];
  dashboardAccessVersion?: string;
  passwordHash?: string;
  password?: string;
  dashboardOptionsVersion?: string;
  supportManagerId?: number | null;
};

type AccessUserRow = {
  source: AccessUserSource;
  id: string;
  revision: string;
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

type AccessUserCredentialRow = AccessUserRow & {
  password_hash: string;
  password_ciphertext: string | null;
  display_password?: string | null;
};

type AccessUserUpdateResult = {
  user: AccessUser;
  previous: AccessUser;
  roleChanged: boolean;
  permissionsChanged: boolean;
  passwordChanged: boolean;
};

async function revokeAccessUserSessions(client: Pick<PoolClient, 'query'>, user: AccessUser) {
  if (user.source === 'admin') await revokeAdminUserSessions(user.numericId, client);
  else await revokeManagerSessions(user.numericId, client);
}

async function finishAccessUserUpdate(client: Pick<PoolClient, 'query'>, result: AccessUserUpdateResult) {
  // Source moves revoke before DELETE, while the session foreign key still identifies the account.
  if (result.previous.source === result.user.source && (result.roleChanged || result.permissionsChanged
    || result.passwordChanged || result.previous.isActive !== result.user.isActive)) {
    await revokeAccessUserSessions(client, result.previous);
  }
  return result;
}

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
    revision: row.revision,
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
     where kts_employee_identifier($1) <> '' and
       (kts_employee_identifier(login) = kts_employee_identifier($1) or kts_employee_identifier(email) = kts_employee_identifier($1))
     limit 1`,
    [login],
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

export async function getAccessUsers(currentAdminUserId?: number | null, actorRole: AdminSessionRole = 'admin'): Promise<AccessUser[]> {
  assertAccessUserManagementAllowed(actorRole, 'top');
  await ensureSiteSchema();
  const result = await query<AccessUserRow>(`
    select *
    from (
      select
        'admin'::text as source,
        au.id::text,
        au.revision::text,
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
      where ($1::boolean or au.role <> 'admin')
      union all
      select
        'manager'::text as source,
        wm.id::text,
        wm.revision::text,
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
  `, [actorRole === 'admin']);

  const users = result.rows.map((row) => mapAccessUser(row, currentAdminUserId));
  const grants=await query<{admin_user_id:string|null;manager_id:string|null;key:string}>('select admin_user_id::text,manager_id::text,key from dashboard_effective_view_grants order by key');
  for (const user of users) {
    user.dashboardAccess=grants.rows.filter((grant)=>Number(user.source==='admin'?grant.admin_user_id:grant.manager_id)===user.numericId).map((grant)=>grant.key);
    user.dashboardAccessVersion=dashboardAccessVersion(user.dashboardAccess);
  }
  return users;
}

export async function createAccessUser(input: AccessUserInput & { passwordHash: string }, actorRole: AdminSessionRole = 'admin'): Promise<AccessUser> {
  assertAccessUserManagementAllowed(actorRole, input.role);
  if (input.dashboardAccess !== undefined && parseDashboardAccess(input.dashboardAccess) === null) {
    throw new Error('Некорректный список доступных дашбордов');
  }
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))',[DASHBOARD_ACCESS_LOCK]);
    if (input.dashboardAccess !== undefined && input.dashboardOptionsVersion !== undefined) {
      const currentOptions = await getDashboardGrantOptions(client);
      if (input.dashboardOptionsVersion !== dashboardGrantOptionsVersion(currentOptions)) throw new DashboardOptionsConflictError();
    }
    const passwordCiphertext = await resolveEmployeePasswordCiphertext({ password: input.password, passwordHash: input.passwordHash });

    if (isManagerAccessRole(input.role)) {
      const supportManagerId = await normalizeSupportManagerId(input.role, input.supportManagerId, undefined, client);
      const result = await client.query<AccessUserRow>(
        `insert into wholesale_managers (name, login, email, phone, role, support_manager_id, password_hash, is_active, password_changed_at, password_ciphertext)
         values ($1, $2, $3, '', $4, $5, $6, $7, now(), $8)
         returning
           'manager'::text as source,
           id::text,
           revision::text,
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
        [input.name, normalizeLogin(input.login), input.email, input.role, supportManagerId, input.passwordHash, input.isActive, passwordCiphertext],
      );
      const user=mapAccessUser(result.rows[0]);
      user.dashboardAccess=await saveDashboardAccess(client,user.numericId,user.role,input.dashboardAccess);
      user.dashboardAccessVersion=dashboardAccessVersion(user.dashboardAccess);
      return user;
    }

    const result = await client.query<AccessUserRow>(
      `insert into admin_users (
         name, login, email, role, can_manage_top_dashboard, password_hash, is_active, password_changed_at, password_ciphertext
       )
       values ($1, $2, $3, $4, $5, $6, $7, now(), $8)
       returning
         'admin'::text as source,
         id::text,
         revision::text,
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
        passwordCiphertext,
      ],
    );
    const user = mapAccessUser(result.rows[0]);
    user.dashboardAccess = await saveDashboardAccess(client, user.numericId, user.role, input.dashboardAccess);
    user.dashboardAccessVersion=dashboardAccessVersion(user.dashboardAccess);
    return user;
  }).catch(rethrowEmployeeIdentifierConflict);
}

export async function updateAccessUser(
  id: string,
  input: AccessUserInput,
  currentAdminUserId?: number | null,
  actorRole: AdminSessionRole = 'admin',
): Promise<AccessUserUpdateResult> {
  assertAccessUserManagementAllowed(actorRole, input.role);
  if (input.dashboardAccess !== undefined && parseDashboardAccess(input.dashboardAccess) === null) {
    throw new Error('Некорректный список доступных дашбордов');
  }
  await ensureSiteSchema();
  const parsed = parseAccessUserId(id);
  if (!parsed) throw new Error('Некорректный пользователь');

  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))',[DASHBOARD_ACCESS_LOCK]);

    if (parsed.source === 'admin') {
      const existingResult = await client.query<AccessUserCredentialRow>(
        `select
           'admin'::text as source,
           id::text,
           revision::text,
           name,
           login,
           email,
           password_hash,
           password_ciphertext,
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
      assertAccessUserManagementAllowed(actorRole, existingRow.role, input.role);
      assertRecordRevision(input.expectedRevision, existingRow.revision);
      const previous = mapAccessUser(existingRow, currentAdminUserId);
      previous.dashboardAccess = await getDashboardGrants(client,'admin',previous.numericId);
      if(input.dashboardAccessVersion!==undefined && input.dashboardAccessVersion!==dashboardAccessVersion(previous.dashboardAccess)) throw new RecordVersionConflictError();
      if (actorRole === 'admintop') {
        assertDelegatedAccessOnly(previous, input);
        const dashboardAccess = await saveDashboardAccess(client, previous.numericId, previous.role, input.dashboardAccess, previous);
        const touched = await client.query<{ revision: string; updated_at: string }>('update admin_users set updated_at = clock_timestamp() where id = $1 returning revision::text, updated_at::text', [previous.numericId]);
        const user = { ...previous, revision: touched.rows[0].revision, updatedAt: touched.rows[0].updated_at, dashboardAccess, dashboardAccessVersion: dashboardAccessVersion(dashboardAccess) };
        return finishAccessUserUpdate(client, { previous, user, roleChanged: false, passwordChanged: false, permissionsChanged: dashboardAccessVersion(previous.dashboardAccess) !== user.dashboardAccessVersion });
      }
      const isSelf = previous.isCurrent;
      const nextRole = input.role;
      const nextCanManageTopDashboard = normalizeTopManagementAccess(
        nextRole,
        input.canManageTopDashboard,
      );
      const activeAdminCount = await countActiveSiteAdmins(client);

      if (isSelf && (nextRole !== previous.role || !input.isActive)) {
        throw new Error('Нельзя снять с себя права администратора');
      }
      if (previous.role === 'admin' && (nextRole !== 'admin' || !input.isActive) && activeAdminCount <= 1) {
        throw new Error('Нельзя удалить или отключить последнего администратора');
      }
      const passwordCiphertext = await resolveEmployeePasswordCiphertext({
        password: input.passwordHash ? input.password : undefined,
        passwordHash: input.passwordHash ?? existingRow.password_hash,
        previousCiphertext: existingRow.password_ciphertext,
      });

      if (isManagerAccessRole(nextRole)) {
        const supportManagerId = await normalizeSupportManagerId(nextRole, input.supportManagerId, undefined, client);
        const insertResult = await client.query<AccessUserRow>(
          `insert into wholesale_managers (name, login, email, phone, role, support_manager_id, password_hash, is_active, password_changed_at, password_ciphertext)
           select $1, $2, $3, '', $4, $5, coalesce($6::text, password_hash), $7, case when $6::text is null then password_changed_at else now() end, $9
           from admin_users
           where id = $8
           returning
             'manager'::text as source,
             id::text,
             revision::text,
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
            passwordCiphertext,
          ],
        );
        await revokeAccessUserSessions(client, previous);
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
             password_ciphertext = $9,
             is_active = $8,
             updated_at = now()
         where id = $1
         returning
           'admin'::text as source,
           id::text,
           revision::text,
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
          passwordCiphertext,
        ],
      );
      const user = mapAccessUser(updateResult.rows[0], currentAdminUserId);
      user.dashboardAccess = await saveDashboardAccess(
        client, user.numericId, nextRole, input.dashboardAccess, previous,
      );
      user.dashboardAccessVersion=dashboardAccessVersion(user.dashboardAccess);
      return finishAccessUserUpdate(client, {
        previous,
        user,
        roleChanged: previous.role !== nextRole || previous.isActive !== input.isActive,
        permissionsChanged: previous.canManageTopDashboard !== nextCanManageTopDashboard
          || JSON.stringify(previous.dashboardAccess) !== JSON.stringify(user.dashboardAccess),
        passwordChanged: Boolean(input.passwordHash),
      });
    }

    // Lock the principal separately: PostgreSQL cannot FOR UPDATE an aggregate projection.
    await client.query('select id from wholesale_managers where id=$1 for update', [parsed.numericId]);
    const existingResult = await client.query<AccessUserCredentialRow>(
      `select
         'manager'::text as source,
         wm.id::text,
         wm.revision::text,
         wm.name,
         wm.login,
         wm.email,
         wm.password_hash,
         wm.password_ciphertext,
         wm.display_password,
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
    assertAccessUserManagementAllowed(actorRole, existingRow.role, input.role);
    assertRecordRevision(input.expectedRevision, existingRow.revision);
    const previous = mapAccessUser(existingRow, currentAdminUserId);
    previous.dashboardAccess=await getDashboardGrants(client,'manager',previous.numericId);
    if(input.dashboardAccessVersion!==undefined && input.dashboardAccessVersion!==dashboardAccessVersion(previous.dashboardAccess)) throw new RecordVersionConflictError();
    if (actorRole === 'admintop') {
      assertDelegatedAccessOnly(previous, input);
      const dashboardAccess = await saveDashboardAccess(client, previous.numericId, previous.role, input.dashboardAccess, previous);
      const touched = await client.query<{ revision: string; updated_at: string }>('update wholesale_managers set updated_at = clock_timestamp() where id = $1 returning revision::text, updated_at::text', [previous.numericId]);
      const user = { ...previous, revision: touched.rows[0].revision, updatedAt: touched.rows[0].updated_at, dashboardAccess, dashboardAccessVersion: dashboardAccessVersion(dashboardAccess) };
      return finishAccessUserUpdate(client, { previous, user, roleChanged: false, passwordChanged: false, permissionsChanged: dashboardAccessVersion(previous.dashboardAccess) !== user.dashboardAccessVersion });
    }
    const passwordCiphertext = await resolveEmployeePasswordCiphertext({
      password: input.passwordHash ? input.password : undefined,
      passwordHash: input.passwordHash ?? existingRow.password_hash,
      previousCiphertext: existingRow.password_ciphertext,
      legacyPassword: input.passwordHash ? undefined : existingRow.display_password,
    });

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
           name, login, email, role, can_manage_top_dashboard, password_hash, is_active, password_changed_at, password_ciphertext
         )
         select $1, $2, $3, $4, $5, coalesce($6::text, password_hash), $7,
                case when $6::text is null then password_changed_at else now() end, $9
         from wholesale_managers
         where id = $8
         returning
           'admin'::text as source,
           id::text,
           revision::text,
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
          passwordCiphertext,
        ],
      );
      await revokeAccessUserSessions(client, previous);
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
           password_ciphertext = $9,
           display_password = '',
           is_active = $6,
           role = $7,
           support_manager_id = $8,
           updated_at = now()
       where id = $1
       returning
         'manager'::text as source,
         id::text,
         revision::text,
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
        passwordCiphertext,
      ],
    );

    const user=mapAccessUser(updateResult.rows[0],currentAdminUserId);
    user.dashboardAccess=await saveDashboardAccess(client,user.numericId,user.role,input.dashboardAccess,previous);
    user.dashboardAccessVersion=dashboardAccessVersion(user.dashboardAccess);
    return finishAccessUserUpdate(client, {
      previous,
      user,
      roleChanged:
        previous.role !== input.role || previous.isActive !== input.isActive || previous.supportManagerId !== supportManagerId,
      permissionsChanged: dashboardAccessVersion(previous.dashboardAccess)!==user.dashboardAccessVersion,
      passwordChanged: Boolean(input.passwordHash),
    });
  }).catch(rethrowEmployeeIdentifierConflict);
}

export async function deleteAccessUser(id: string, currentAdminUserId?: number | null, actorRole: AdminSessionRole = 'admin'): Promise<AccessUser> {
  assertAccessUserManagementAllowed(actorRole, 'top');
  if (actorRole !== 'admin') throw new AccessUserProfileForbiddenError();
  await ensureSiteSchema();
  const parsed = parseAccessUserId(id);
  if (!parsed) throw new Error('Некорректный пользователь');

  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [DASHBOARD_ACCESS_LOCK]);
    if (parsed.source === 'admin') {
      const existingResult = await client.query<AccessUserRow>(
        `select
           'admin'::text as source,
           id::text,
           revision::text,
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
      const row = existingResult.rows[0];
      if (!row) throw new Error('Пользователь не найден');
      assertAccessUserManagementAllowed(actorRole, row.role);
      const user = mapAccessUser(row, currentAdminUserId);
      if (user.isCurrent) throw new Error('Нельзя удалить самого себя');
      if (user.role === 'admin' && user.isActive && (await countActiveSiteAdmins(client)) <= 1) {
        throw new Error('Нельзя удалить последнего администратора');
      }
      await revokeAccessUserSessions(client, user);
      await client.query(`delete from admin_users where id = $1`, [parsed.numericId]);
      return user;
    }

    const existingResult = await client.query<AccessUserRow>(
      `select
         'manager'::text as source,
         wm.id::text,
         wm.revision::text,
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
    await revokeAccessUserSessions(client, user);
    await client.query(`delete from wholesale_managers where id = $1`, [parsed.numericId]);
    return user;
  });
}
