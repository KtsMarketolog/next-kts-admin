import type { PoolClient } from 'pg';

import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';

export type AdminUserRole = 'admin' | 'wholesale_admin';
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
  return role === 'wholesale_admin' ? 'wholesale_admin' : 'admin';
}

function normalizeAccessRole(role: string): AccessUserRole | null {
  if (role === 'admin' || role === 'wholesale_admin' || role === 'manager' || role === 'support_manager') return role;
  return null;
}

function isManagerAccessRole(role: AccessUserRole): role is ManagerAccessRole {
  return role === 'manager' || role === 'support_manager';
}

function accessLabels(role: AccessUserRole) {
  if (role === 'admin') return ['Сайт', 'Прайсы', 'Пользователи'];
  if (role === 'wholesale_admin') return ['Индивидуальные прайсы'];
  if (role === 'support_manager') return ['Прайсы менеджера'];
  return ['Свои прайсы'];
}

function mapAccessUser(row: AccessUserRow, currentAdminUserId?: number | null): AccessUser {
  const role = normalizeAccessRole(row.role) ?? (row.source === 'manager' ? 'manager' : 'admin');
  const numericId = Number(row.id);
  return {
    id: `${row.source}:${numericId}`,
    source: row.source,
    numericId,
    name: row.name,
    login: row.login,
    email: row.email,
    role,
    isActive: row.is_active,
    accesses: accessLabels(role),
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
    password_changed_at: string | null;
  }>(
    `select id::text, login, name, email, password_hash, is_active, role, password_changed_at::text
     from admin_users
     where login = $1 or lower(email) = $1
     limit 1`,
    [normalizeLogin(login)],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: Number(row.id),
    login: row.login,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    isActive: row.is_active,
    role: normalizeAdminRole(row.role),
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
      case role when 'admin' then 1 when 'wholesale_admin' then 2 when 'manager' then 3 when 'support_manager' then 4 else 5 end,
      is_active desc,
      name asc,
      login asc
  `);

  return result.rows.map((row) => mapAccessUser(row, currentAdminUserId));
}

export async function createAccessUser(input: AccessUserInput & { passwordHash: string }): Promise<AccessUser> {
  await ensureSiteSchema();
  return withTransaction(async (client) => {
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
           '0'::text as price_list_count,
           support_manager_id::text as support_manager_id,
           coalesce((select name from wholesale_managers support where support.id = wholesale_managers.support_manager_id), '') as support_manager_name,
           created_at::text,
           updated_at::text`,
        [input.name, normalizeLogin(input.login), input.email, input.role, supportManagerId, input.passwordHash, input.isActive],
      );
      return mapAccessUser(result.rows[0]);
    }

    const result = await client.query<AccessUserRow>(
      `insert into admin_users (name, login, email, role, password_hash, is_active, password_changed_at)
       values ($1, $2, $3, $4, $5, $6, now())
       returning
         'admin'::text as source,
         id::text,
         name,
         login,
         email,
         role,
         is_active,
         '0'::text as price_list_count,
         null::text as support_manager_id,
         ''::text as support_manager_name,
         created_at::text,
         updated_at::text`,
      [input.name, normalizeLogin(input.login), input.email, input.role, input.passwordHash, input.isActive],
    );
    return mapAccessUser(result.rows[0]);
  });
}

export async function updateAccessUser(
  id: string,
  input: AccessUserInput,
  currentAdminUserId?: number | null,
): Promise<{ user: AccessUser; previous: AccessUser; roleChanged: boolean; passwordChanged: boolean }> {
  await ensureSiteSchema();
  const parsed = parseAccessUserId(id);
  if (!parsed) throw new Error('Некорректный пользователь');

  return withTransaction(async (client) => {
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
      const existingRow = existingResult.rows[0];
      if (!existingRow) throw new Error('Пользователь не найден');
      const previous = mapAccessUser(existingRow, currentAdminUserId);
      const isSelf = previous.isCurrent;
      const nextRole = input.role;
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
        return {
          previous,
          user: mapAccessUser(insertResult.rows[0], currentAdminUserId),
          roleChanged: true,
          passwordChanged: Boolean(input.passwordHash),
        };
      }

      const updateResult = await client.query<AccessUserRow>(
        `update admin_users
         set name = $2,
             login = $3,
             email = $4,
             role = $5,
             password_hash = case when $6::text is null then password_hash else $6 end,
             password_changed_at = case when $6::text is null then password_changed_at else now() end,
             is_active = $7,
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
          input.passwordHash ?? null,
          input.isActive,
        ],
      );
      return {
        previous,
        user: mapAccessUser(updateResult.rows[0], currentAdminUserId),
        roleChanged: previous.role !== nextRole || previous.isActive !== input.isActive,
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

    if (!isManagerAccessRole(input.role)) {
      if (previous.priceListCount > 0) {
        throw new Error('Сначала передайте прайсы другому менеджеру, затем меняйте роль');
      }
      const insertResult = await client.query<AccessUserRow>(
        `insert into admin_users (name, login, email, role, password_hash, is_active, password_changed_at)
         select $1, $2, $3, $4, coalesce($5::text, password_hash), $6, case when $5::text is null then password_changed_at else now() end
         from wholesale_managers
         where id = $7
         returning
           'admin'::text as source,
           id::text,
           name,
           login,
           email,
           role,
           is_active,
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
          input.passwordHash ?? null,
          input.isActive,
          parsed.numericId,
        ],
      );
      await client.query(`delete from wholesale_managers where id = $1`, [parsed.numericId]);
      return {
        previous,
        user: mapAccessUser(insertResult.rows[0], currentAdminUserId),
        roleChanged: true,
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

    return {
      previous,
      user: mapAccessUser(updateResult.rows[0], currentAdminUserId),
      roleChanged:
        previous.role !== input.role || previous.isActive !== input.isActive || previous.supportManagerId !== supportManagerId,
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
