import { randomBytes, randomUUID } from 'crypto';

import { hashSensitiveValue, safeHeaderValue } from '../securityHash';
import { query } from './client';
import { ensureSiteSchema } from './schema';

export type StoredAdminSessionRole = 'admin' | 'wholesale_admin' | 'manager' | 'support_manager' | 'top' | 'admintop';

export type StoredAdminSession = {
  sessionId: string;
  role: StoredAdminSessionRole;
  adminUserId?: number;
  managerId?: number;
  canAccessTopDashboard?: boolean;
  canManageTopDashboard?: boolean;
  createdAt: string;
  expiresAt: string;
};

type CreateAdminSessionInput = {
  role: StoredAdminSessionRole;
  adminUserId?: number | null;
  managerId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
  maxAgeSeconds?: number;
};

const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 100;

function hashSessionToken(token: string) {
  return hashSensitiveValue(`admin-session:${token}`);
}

function normalizeRole(role: string): StoredAdminSessionRole | null {
  if (
    role === 'admin'
    || role === 'wholesale_admin'
    || role === 'manager'
    || role === 'support_manager'
    || role === 'top'
    || role === 'admintop'
  ) {
    return role;
  }
  return null;
}

function isStoredManagerRole(role: StoredAdminSessionRole) {
  return role === 'manager' || role === 'support_manager';
}

export async function createStoredAdminSession(input: CreateAdminSessionInput) {
  await ensureSiteSchema();
  const token = randomBytes(32).toString('base64url');
  const sessionId = randomUUID();
  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const expiresAt = new Date(Date.now() + maxAgeSeconds * 1000);

  await query(
    `insert into admin_sessions (
       id, session_hash, role, admin_user_id, manager_id, ip_hash, user_agent, expires_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      sessionId,
      hashSessionToken(token),
      input.role,
      input.adminUserId ?? null,
      input.managerId ?? null,
      hashSensitiveValue(input.ip || ''),
      safeHeaderValue(input.userAgent, 500),
      expiresAt,
    ],
  );

  return { token, sessionId, expiresAt };
}

export async function getStoredAdminSession(token: string): Promise<StoredAdminSession | null> {
  if (!token || token.length < 32 || token.length > 256) return null;

  await ensureSiteSchema();
  const result = await query<{
    id: string;
    role: string;
    admin_user_id: string | null;
    manager_id: string | null;
    created_at: string;
    expires_at: string;
    admin_is_active: boolean | null;
    admin_role: string | null;
    admin_can_manage_top_dashboard: boolean | null;
    manager_is_active: boolean | null;
    manager_role: string | null;
    manager_can_access_top_dashboard: boolean | null;
    manager_can_manage_top_dashboard: boolean | null;
    admin_password_changed_at: string | null;
    manager_password_changed_at: string | null;
  }>(
    `select
       s.id::text,
       s.role,
       s.admin_user_id::text,
       s.manager_id::text,
       s.created_at::text,
       s.expires_at::text,
       au.is_active as admin_is_active,
       au.role as admin_role,
       au.can_manage_top_dashboard as admin_can_manage_top_dashboard,
       wm.is_active as manager_is_active,
       coalesce(nullif(wm.role, ''), 'manager') as manager_role,
       wm.can_access_top_dashboard as manager_can_access_top_dashboard,
       wm.can_manage_top_dashboard as manager_can_manage_top_dashboard,
       au.password_changed_at::text as admin_password_changed_at,
       wm.password_changed_at::text as manager_password_changed_at
     from admin_sessions s
     left join admin_users au on au.id = s.admin_user_id
     left join wholesale_managers wm on wm.id = s.manager_id
     where s.session_hash = $1
       and s.revoked_at is null
       and s.expires_at > now()
     limit 1`,
    [hashSessionToken(token)],
  );

  const row = result.rows[0];
  const role = normalizeRole(row?.role ?? '');
  if (!row || !role) return null;

  const createdAtMs = new Date(row.created_at).getTime();
  const passwordChangedAt = isStoredManagerRole(role) ? row.manager_password_changed_at : row.admin_password_changed_at;
  if (passwordChangedAt && createdAtMs < new Date(passwordChangedAt).getTime()) {
    await revokeStoredAdminSession(token);
    return null;
  }

  if (
    row.admin_user_id
    && (row.admin_is_active !== true || row.admin_role !== role)
  ) {
    await revokeStoredAdminSession(token);
    return null;
  }

  if ((role === 'top' || role === 'admintop') && !row.admin_user_id) {
    await revokeStoredAdminSession(token);
    return null;
  }

  if (isStoredManagerRole(role)) {
    if (
      !row.manager_id
      || row.manager_is_active !== true
      || row.manager_role !== role
    ) {
      await revokeStoredAdminSession(token);
      return null;
    }
  }

  await query(`update admin_sessions set last_seen_at = now() where id = $1`, [row.id]).catch((error) => {
    console.error('Failed to update admin session last_seen_at', error);
  });

  return {
    sessionId: row.id,
    role,
    adminUserId: row.admin_user_id ? Number(row.admin_user_id) : undefined,
    managerId: row.manager_id ? Number(row.manager_id) : undefined,
    canAccessTopDashboard: isStoredManagerRole(role)
      ? row.manager_can_access_top_dashboard === true || row.manager_can_manage_top_dashboard === true
      : undefined,
    canManageTopDashboard: isStoredManagerRole(role)
      ? row.manager_can_manage_top_dashboard === true
      : role === 'top'
        ? row.admin_can_manage_top_dashboard === true
        : undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function revokeStoredAdminSession(token: string) {
  if (!token) return;
  await ensureSiteSchema();
  await query(
    `update admin_sessions
     set revoked_at = coalesce(revoked_at, now())
     where session_hash = $1`,
    [hashSessionToken(token)],
  );
}

export async function revokeAdminUserSessions(adminUserId: number) {
  await ensureSiteSchema();
  await query(
    `update admin_sessions
     set revoked_at = coalesce(revoked_at, now())
     where admin_user_id = $1 and revoked_at is null`,
    [adminUserId],
  );
}

export async function revokeManagerSessions(managerId: number) {
  await ensureSiteSchema();
  await query(
    `update admin_sessions
     set revoked_at = coalesce(revoked_at, now())
     where manager_id = $1 and revoked_at is null`,
    [managerId],
  );
}
