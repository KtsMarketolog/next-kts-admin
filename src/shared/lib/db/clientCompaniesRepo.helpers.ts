import type { PoolClient } from 'pg';

import type { AdminSession } from '../adminAuth';
import {
  getWholesalePriceWorkflowStatusLabel,
  normalizeWholesalePriceWorkflowStatus,
} from '../wholesalePriceWorkflowStatus';

import type { ClientCompany, ClientCompanyInput, ClientCompanyPriceList } from './clientCompanyTypes';
import { query } from './client';

export type ClientCompanyRow = {
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
  require_2fa: boolean;
  user_count: string;
  client_login: string | null;
  client_user_id: string | null;
  password_changed_at: string | null;
  display_password: string | null;
  chat_unread_count: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type ClientCompanyPriceListRow = {
  id: string;
  title: string;
  token: string;
  valid_until: string | null;
  workflow_status: string;
  is_active: boolean;
  item_count: string;
  created_at: string;
  updated_at: string;
};

export function canSeeAllClients(session: AdminSession) {
  return session.role === 'admin' || session.role === 'wholesale_admin';
}

export function mapClientCompany(row: ClientCompanyRow): ClientCompany {
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
    requireTwoFactor: row.require_2fa,
    userCount: Number(row.user_count),
    clientLogin: row.client_login ?? '',
    clientUserId: row.client_user_id ? Number(row.client_user_id) : null,
    passwordChangedAt: row.password_changed_at ?? '',
    displayPassword: row.display_password ?? '',
    chatUnreadCount: Number(row.chat_unread_count ?? 0),
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapClientCompanyPriceList(row: ClientCompanyPriceListRow): ClientCompanyPriceList {
  const workflowStatus = normalizeWholesalePriceWorkflowStatus(row.workflow_status);
  return {
    id: Number(row.id),
    title: row.title,
    token: row.token,
    validUntil: row.valid_until,
    workflowStatus,
    workflowStatusLabel: getWholesalePriceWorkflowStatusLabel(workflowStatus),
    isActive: row.is_active,
    itemCount: Number(row.item_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeClientLogin(value: string) {
  return value.trim().toLowerCase();
}

export async function upsertPrimaryClientUser(
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
  const displayPassword = input.displayPassword || null;

  if (existingId) {
    await db.query(
      `update client_users
       set name = $2,
           email = $3,
           login = $3,
           phone = $4,
           password_hash = case when $5::text is null then password_hash else $5 end,
           display_password = case when $5::text is null then display_password else coalesce($6::text, '') end,
           password_changed_at = case when $5::text is null then password_changed_at else now() end,
           is_active = $7,
           updated_at = now()
       where id = $1`,
      [existingId, name, login, input.phone, passwordHash, displayPassword, input.isActive],
    );
    return;
  }

  if (!passwordHash) return;
  await db.query(
    `insert into client_users (company_id, name, email, phone, login, password_hash, display_password, is_active, password_changed_at)
     values ($1, $2, $3, $4, $3, $5, coalesce($6::text, ''), $7, now())`,
    [companyId, name, login, input.phone, passwordHash, displayPassword, input.isActive],
  );
}

export function numberOrNull(value: number | null | undefined) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

export async function normalizeManagerAssignments(input: Pick<ClientCompanyInput, 'managerId' | 'supportManagerId'>, session: AdminSession) {
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
