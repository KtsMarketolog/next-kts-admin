import { query } from '../client';
import { ensureSiteSchema } from '../schema';
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
  name: string;
  login: string;
  email: string;
  phone: string;
  display_password: string | null;
  role: string | null;
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
    name: row.name,
    login: row.login,
    email: row.email,
    phone: row.phone,
    displayPassword: row.display_password ?? '',
    role: normalizeManagerRole(row.role),
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
      m.name,
      m.login,
      m.email,
      m.phone,
      m.display_password,
      coalesce(nullif(m.role, ''), 'manager') as role,
      m.support_manager_id::text as support_manager_id,
      coalesce(support.name, '') as support_manager_name,
      m.is_active,
      count(pl.id)::text as price_list_count,
      last_event.created_at::text as last_changed_at,
      last_event.title_snapshot as last_changed_price_title
    from wholesale_managers m
    left join wholesale_price_lists pl on (
      (coalesce(nullif(m.role, ''), 'manager') = 'support_manager' and pl.support_manager_id = m.id)
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
    password_hash: string;
    is_active: boolean;
    password_changed_at: string | null;
  }>(
    `select id::text, login, email, coalesce(nullif(role, ''), 'manager') as role, password_hash, is_active, password_changed_at::text
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
    passwordHash: row.password_hash,
    isActive: row.is_active,
    passwordChangedAt: row.password_changed_at,
  };
}

export async function getWholesaleManagerById(id: number): Promise<WholesaleManagerProfile | null> {
  await ensureSiteSchema();
  const result = await query<{
    id: string;
    name: string;
    login: string;
    email: string;
    phone: string;
    role: string | null;
    is_active: boolean;
  }>(
    `select id::text, name, login, email, phone, coalesce(nullif(role, ''), 'manager') as role, is_active
     from wholesale_managers
     where id = $1
     limit 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    login: row.login,
    email: row.email,
    phone: row.phone,
    role: normalizeManagerRole(row.role),
    isActive: row.is_active,
  };
}

export async function createWholesaleManager(input: {
  name: string;
  login: string;
  email: string;
  phone: string;
  role?: WholesaleManagerRole;
  supportManagerId?: number | null;
  passwordHash: string;
  displayPassword?: string;
  isActive: boolean;
}) {
  await ensureSiteSchema();
  const role = normalizeManagerRole(input.role);
  const supportManagerId = role === 'manager' ? await normalizeWholesaleSupportManagerId(input.supportManagerId) : null;
  const result = await query<{ id: string }>(
    `insert into wholesale_managers (name, login, email, phone, role, support_manager_id, password_hash, display_password, is_active, password_changed_at)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::text, ''), $9, now())
     returning id`,
    [input.name, normalizeLogin(input.login), input.email, input.phone, role, supportManagerId, input.passwordHash, input.displayPassword ?? '', input.isActive],
  );
  return Number(result.rows[0].id);
}

export async function updateWholesaleManager(
  id: number,
  input: {
    name: string;
    login: string;
    email: string;
    phone: string;
    supportManagerId?: number | null;
    passwordHash?: string;
    displayPassword?: string;
    isActive: boolean;
  },
) {
  await ensureSiteSchema();
  const supportManagerId = await normalizeWholesaleSupportManagerId(input.supportManagerId, id);
  await query(
    `update wholesale_managers
     set name = $2,
         login = $3,
         email = $4,
         phone = $5,
         password_hash = case when $6::text is null then password_hash else $6 end,
         display_password = case when $6::text is null then display_password else coalesce($9::text, '') end,
         password_changed_at = case when $6::text is null then password_changed_at else now() end,
         is_active = $7,
         support_manager_id = $8,
         updated_at = now()
     where id = $1`,
    [
      id,
      input.name,
      normalizeLogin(input.login),
      input.email,
      input.phone,
      input.passwordHash ?? null,
      input.isActive,
      supportManagerId,
      input.displayPassword ?? '',
    ],
  );
}

export async function deleteWholesaleManager(id: number) {
  await ensureSiteSchema();
  await query(`delete from wholesale_managers where id = $1`, [id]);
}
