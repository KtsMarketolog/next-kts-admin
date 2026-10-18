import { query, withTransaction } from '../client';
import { ensureSiteSchema } from '../schema';
import { revokeManagerSessions } from '../adminSessionsRepo';
import { resolveEmployeePasswordCiphertext } from '../../employeePasswordVault';
import { assertRecordRevision } from '../../recordVersion';
import {
  normalizeLogin,
  normalizeManagerRole,
  normalizeWholesaleSupportManagerId,
} from './managerHelpers';
import type {
  WholesaleManager,
  WholesaleManagerAuth,
  WholesaleManagerProfile,
  WholesaleManagerRole,
} from './types';

type ManagerRow = {
  id: string;
  revision: string;
  name: string;
  login: string;
  email: string;
  phone: string;
  role: string | null;
  can_access_top_dashboard: boolean;
  can_manage_top_dashboard: boolean;
  support_manager_id: string | null;
  support_manager_name: string | null;
  is_active: boolean;
  price_list_count: string;
  last_changed_at: string | null;
  last_changed_price_title: string | null;
};

function mapManager(row: ManagerRow): WholesaleManager {
  return {
    id: Number(row.id),
    revision: row.revision,
    name: row.name,
    login: row.login,
    email: row.email,
    phone: row.phone,
    displayPassword: '',
    role: normalizeManagerRole(row.role),
    canAccessTopDashboard: row.can_access_top_dashboard || row.can_manage_top_dashboard,
    canManageTopDashboard: row.can_manage_top_dashboard,
    supportManagerId: row.support_manager_id ? Number(row.support_manager_id) : null,
    supportManagerName: row.support_manager_name ?? '',
    isActive: row.is_active,
    priceListCount: Number(row.price_list_count),
    lastChangedAt: row.last_changed_at,
    lastChangedPriceTitle: row.last_changed_price_title,
  };
}

export async function getWholesaleManagers() {
  await ensureSiteSchema();
  const result = await query<ManagerRow>(`
    select
      m.id::text,
      m.revision::text,
      m.name,
      m.login,
      m.email,
      m.phone,
      coalesce(nullif(m.role, ''), 'manager') as role,
      m.can_access_top_dashboard,
      m.can_manage_top_dashboard,
      m.support_manager_id::text as support_manager_id,
      coalesce(support.name, '') as support_manager_name,
      m.is_active,
      count(pl.id)::text as price_list_count,
      last_event.created_at::text as last_changed_at,
      last_event.title_snapshot as last_changed_price_title
    from wholesale_managers m
    left join wholesale_price_lists pl on (
      (coalesce(nullif(m.role, ''), 'manager') = 'support_manager'
        and (pl.support_manager_id = m.id or pl.manager_id = m.id))
      or (coalesce(nullif(m.role, ''), 'manager') <> 'support_manager' and pl.manager_id = m.id)
    )
    left join wholesale_managers support on support.id = m.support_manager_id
    left join lateral (
      select e.created_at, e.title_snapshot
      from wholesale_price_list_events e
      left join wholesale_price_lists event_price on event_price.id = e.price_list_id
      where coalesce(e.owner_manager_id, event_price.manager_id, e.manager_id) = m.id
      order by e.created_at desc, e.id desc
      limit 1
    ) last_event on true
    group by m.id, support.name, last_event.created_at, last_event.title_snapshot
    order by m.is_active desc, m.name asc, m.id asc
  `);
  return result.rows.map(mapManager);
}

export async function getWholesaleManagerByLogin(login: string): Promise<WholesaleManagerAuth | null> {
  await ensureSiteSchema();
  const result = await query<{
    id: string;
    login: string;
    email: string;
    role: string | null;
    can_access_top_dashboard: boolean;
    can_manage_top_dashboard: boolean;
    password_hash: string;
    is_active: boolean;
    password_changed_at: string | null;
  }>(
    `select id::text, login, email, coalesce(nullif(role, ''), 'manager') as role, can_access_top_dashboard, can_manage_top_dashboard, password_hash, is_active, password_changed_at::text
     from wholesale_managers
     where login = $1 or lower(email) = $1
     limit 1`,
    [normalizeLogin(login)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    login: row.login,
    email: row.email,
    role: normalizeManagerRole(row.role),
    canAccessTopDashboard: row.can_access_top_dashboard || row.can_manage_top_dashboard,
    canManageTopDashboard: row.can_manage_top_dashboard,
    passwordHash: row.password_hash,
    isActive: row.is_active,
    passwordChangedAt: row.password_changed_at,
  };
}

export async function getWholesaleManagerById(id: number): Promise<WholesaleManagerProfile | null> {
  await ensureSiteSchema();
  const result = await query<{
    id: string;
    revision: string;
    name: string;
    login: string;
    email: string;
    phone: string;
    role: string | null;
    can_access_top_dashboard: boolean;
    can_manage_top_dashboard: boolean;
    is_active: boolean;
  }>(
    `select id::text, revision::text, name, login, email, phone, coalesce(nullif(role, ''), 'manager') as role, can_access_top_dashboard, can_manage_top_dashboard, is_active
     from wholesale_managers
     where id = $1
     limit 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    revision: row.revision,
    name: row.name,
    login: row.login,
    email: row.email,
    phone: row.phone,
    role: normalizeManagerRole(row.role),
    canAccessTopDashboard: row.can_access_top_dashboard || row.can_manage_top_dashboard,
    canManageTopDashboard: row.can_manage_top_dashboard,
    isActive: row.is_active,
  };
}

export async function createWholesaleManager(input: {
  name: string;
  login: string;
  email: string;
  phone: string;
  role?: WholesaleManagerRole;
  canAccessTopDashboard?: boolean;
  canManageTopDashboard?: boolean;
  supportManagerId?: number | null;
  passwordHash: string;
  password?: string;
  isActive: boolean;
}) {
  await ensureSiteSchema();
  const role = normalizeManagerRole(input.role);
  const supportManagerId = role === 'manager' ? await normalizeWholesaleSupportManagerId(input.supportManagerId) : null;
  const canManageTopDashboard = input.canManageTopDashboard === true;
  const canAccessTopDashboard = input.canAccessTopDashboard === true || canManageTopDashboard;
  return withTransaction(async (client) => {
    const passwordCiphertext = await resolveEmployeePasswordCiphertext({ password: input.password, passwordHash: input.passwordHash });
    const result = await client.query<{ id: string }>(
      `with created as (insert into wholesale_managers (name, login, email, phone, role, can_access_top_dashboard, can_manage_top_dashboard, support_manager_id, password_hash, password_ciphertext, is_active, password_changed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       returning id), grants as (
         insert into dashboard_view_grants(manager_id,key)
         select c.id,k.key from created c cross join (
           select 'currency-rates' key union all
           select case when $5='support_manager' then 'manager:support' else 'manager:development' end union all
           select 'route-planner' where $5='support_manager' union all
           select 'top:' || b.id from top_dashboard_blocks b where $6::boolean
         ) k returning manager_id
       ) select id from created`,
      [
        input.name,
        normalizeLogin(input.login),
        input.email,
        input.phone,
        role,
        canAccessTopDashboard,
        canManageTopDashboard,
        supportManagerId,
        input.passwordHash,
        passwordCiphertext,
        input.isActive,
      ],
    );
    return Number(result.rows[0].id);
  });
}

export async function updateWholesaleManager(
  id: number,
  input: {
    expectedRevision?: string;
    name: string;
    login: string;
    email: string;
    phone: string;
    canAccessTopDashboard: boolean;
    canManageTopDashboard: boolean;
    supportManagerId?: number | null;
    passwordHash?: string;
    password?: string;
    isActive: boolean;
    revokeSessions: boolean;
  },
) {
  await ensureSiteSchema();
  const supportManagerId = await normalizeWholesaleSupportManagerId(input.supportManagerId, id);
  const canManageTopDashboard = input.canManageTopDashboard === true;
  const canAccessTopDashboard = input.canAccessTopDashboard === true || canManageTopDashboard;
  return withTransaction(async (client) => {
    const existing = await client.query<{
      revision: string;
      password_hash: string; password_ciphertext: string | null; display_password: string | null;
      can_access_top_dashboard: boolean; can_manage_top_dashboard: boolean; is_active: boolean;
    }>(`select password_hash, password_ciphertext, display_password, revision::text,
               can_access_top_dashboard, can_manage_top_dashboard, is_active
        from wholesale_managers where id = $1 for update`, [id]);
    const previous = existing.rows[0];
    if (!previous) throw new Error('Менеджер не найден');
    assertRecordRevision(input.expectedRevision, previous.revision);
    const passwordCiphertext = await resolveEmployeePasswordCiphertext({
      password: input.passwordHash ? input.password : undefined,
      passwordHash: input.passwordHash ?? previous.password_hash,
      previousCiphertext: previous.password_ciphertext,
      legacyPassword: input.passwordHash ? undefined : previous.display_password,
    });
    const updated = await client.query<{ revision: string }>(
      `update wholesale_managers
       set name = $2,
           login = $3,
           email = $4,
           phone = $5,
           password_hash = case when $6::text is null then password_hash else $6 end,
           password_ciphertext = $9,
           display_password = '',
           password_changed_at = case when $6::text is null then password_changed_at else now() end,
           is_active = $7,
           support_manager_id = $8,
           can_access_top_dashboard = $10,
           can_manage_top_dashboard = $11,
           updated_at = now()
       where id = $1 returning revision::text`,
      [
        id,
        input.name,
        normalizeLogin(input.login),
        input.email,
        input.phone,
        input.passwordHash ?? null,
        input.isActive,
        supportManagerId,
        passwordCiphertext,
        canAccessTopDashboard,
        canManageTopDashboard,
      ],
    );

    if (input.revokeSessions || Boolean(input.passwordHash) || previous.is_active !== input.isActive
      || previous.can_access_top_dashboard !== canAccessTopDashboard
      || previous.can_manage_top_dashboard !== canManageTopDashboard) {
      await revokeManagerSessions(id, client);
    }
    return { revision: updated.rows[0].revision };
  });
}

export async function deleteWholesaleManager(id: number) {
  await ensureSiteSchema();
  await withTransaction(async (client) => {
    await revokeManagerSessions(id, client);
    await client.query(`delete from wholesale_managers where id = $1`, [id]);
  });
}
