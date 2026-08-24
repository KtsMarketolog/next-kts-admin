import { cookies } from 'next/headers';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

import { getAdminSessionSecret } from './authSecret';
import { createStoredAdminSession, getStoredAdminSession, revokeStoredAdminSession } from './db/adminSessionsRepo';

const COOKIE_NAME = 'kts_admin_session';
const PASSWORD_KEYLEN = 64;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 100;

export type AdminSessionRole = 'admin' | 'wholesale_admin' | 'manager' | 'support_manager' | 'top' | 'admintop';
export type AdminManagerSessionRole = 'manager' | 'support_manager';
export type AdminUserSessionRole = 'admin' | 'wholesale_admin' | 'top' | 'admintop';

export type AdminSession = {
  role: AdminSessionRole;
  adminUserId?: number;
  managerId?: number;
  canAccessTopDashboard?: boolean;
  canManageTopDashboard?: boolean;
  sessionId?: string;
};

type CreateSessionOptions = {
  adminUserId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
};

export function isManagerSessionRole(role: AdminSessionRole | null | undefined): role is AdminManagerSessionRole {
  return role === 'manager' || role === 'support_manager';
}

export function isOperationalEmployeeSessionRole(role: AdminSessionRole | null | undefined) {
  return role === 'admin' || role === 'wholesale_admin' || isManagerSessionRole(role);
}

export function isAdminManagementSession(
  session: AdminSession | null | undefined,
): session is AdminSession & { role: 'admin' } {
  return session?.role === 'admin';
}

export type TopDashboardManagementSession =
  | (AdminSession & { role: 'admin' })
  | (AdminSession & { role: 'admintop'; adminUserId: number })
  | (AdminSession & {
      role: 'top';
      adminUserId: number;
      canManageTopDashboard: true;
    });

function hasPersistedAdminUserId(session: AdminSession | null | undefined) {
  return Number.isInteger(session?.adminUserId) && Number(session?.adminUserId) > 0;
}

export function isTopDashboardManagementSession(
  session: AdminSession | null | undefined,
): session is TopDashboardManagementSession {
  if (session?.role === 'admin') return true;
  if (session?.role === 'admintop') return hasPersistedAdminUserId(session);
  return session?.role === 'top'
    && session.canManageTopDashboard === true
    && hasPersistedAdminUserId(session);
}

export function isTopDashboardSession(
  session: AdminSession | null | undefined,
): session is
  | (AdminSession & { role: 'admin' })
  | (AdminSession & { role: 'admintop'; adminUserId: number })
  | (AdminSession & { role: 'top'; adminUserId: number })
  | (AdminSession & {
      role: AdminManagerSessionRole;
      managerId: number;
      canAccessTopDashboard: true;
    }) {
  if (session?.role === 'admin') return true;
  if (session?.role === 'top' || session?.role === 'admintop') {
    return hasPersistedAdminUserId(session);
  }
  return isManagerSessionRole(session?.role)
    && session.canAccessTopDashboard === true
    && Number.isInteger(session.managerId)
    && Number(session.managerId) > 0;
}

export function getTopDashboardActor(session: TopDashboardManagementSession) {
  return {
    actorType: session.role === 'admin'
      ? 'admin' as const
      : session.role === 'admintop'
        ? 'admintop' as const
        : 'top' as const,
    adminUserId: session.adminUserId ?? null,
    managerId: null,
  };
}

function sign(value: string) {
  return createHmac('sha256', getAdminSessionSecret()).update(value).digest('hex');
}

export async function createAdminSession(
  role: AdminUserSessionRole = 'admin',
  options: CreateSessionOptions = {},
) {
  if ((role === 'top' || role === 'admintop') && !options.adminUserId) {
    throw new Error('TOP session requires an admin user id');
  }
  return createEmployeeSession({ role, adminUserId: options.adminUserId ?? undefined }, options);
}

export async function createEmployeeSession(session: AdminSession, options: CreateSessionOptions = {}) {
  const adminUserId = session.adminUserId ?? options.adminUserId ?? null;
  if (
    (session.role === 'top' || session.role === 'admintop')
    && (!Number.isInteger(adminUserId) || Number(adminUserId) <= 0)
  ) {
    throw new Error('Top session requires an admin user');
  }

  const storedSession = await createStoredAdminSession({
    role: session.role,
    adminUserId,
    managerId: session.managerId ?? null,
    ip: options.ip,
    userAgent: options.userAgent,
  });
  const jar = await cookies();
  jar.set(COOKIE_NAME, storedSession.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.ADMIN_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearAdminSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) {
    await revokeStoredAdminSession(token).catch((error) => {
      console.error('Failed to revoke admin session', error);
    });
  }
  jar.delete(COOKIE_NAME);
}

export async function isAdminAuthenticated() {
  const session = await getAdminSession();
  return Boolean(session);
}

export async function getAdminSession(): Promise<AdminSession | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const storedSession = await getStoredAdminSession(token);
    if (storedSession) {
      return {
        role: storedSession.role,
        adminUserId: storedSession.adminUserId,
        managerId: storedSession.managerId,
        canAccessTopDashboard: storedSession.canAccessTopDashboard,
        canManageTopDashboard: storedSession.canManageTopDashboard,
        sessionId: storedSession.sessionId,
      };
    }
  } catch (error) {
    console.error('Failed to read stored admin session', error);
  }

  // Backward-compatible read for old signed cookies. New logins use admin_sessions.
  const [value, mac] = token.split('.');
  if (!value || !mac) return null;

  const expected = sign(value);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;

  const [timestamp, role, managerId] = value.split(':');
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || age < 0 || age > SESSION_MAX_AGE_SECONDS * 1000) return null;

  if (!timingSafeEqual(a, b)) return null;

  if (isManagerSessionRole(role as AdminSessionRole)) {
    const parsedManagerId = Number(managerId);
    if (!Number.isInteger(parsedManagerId)) return null;
    return { role: role as AdminManagerSessionRole, managerId: parsedManagerId };
  }

  if (role === 'admin' || role === 'wholesale_admin') {
    return { role };
  }

  return null;
}

export async function requireAdmin() {
  const session = await getAdminSession();
  if (session?.role !== 'admin') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function requireWholesaleAdmin() {
  const session = await getAdminSession();
  if (session?.role !== 'admin' && session?.role !== 'wholesale_admin') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export async function requireWholesaleAdminSession() {
  const session = await getAdminSession();
  if (session?.role !== 'admin' && session?.role !== 'wholesale_admin') {
    return { denied: Response.json({ error: 'Unauthorized' }, { status: 401 }), session: null };
  }
  return { denied: null, session };
}

export async function requireAdminSession() {
  const session = await getAdminSession();
  if (!isAdminManagementSession(session)) {
    return { denied: Response.json({ error: 'Unauthorized' }, { status: 401 }), session: null };
  }
  return { denied: null, session };
}

export async function requireEmployee() {
  const session = await getAdminSession();
  if (!session || !isOperationalEmployeeSessionRole(session.role)) {
    return { denied: Response.json({ error: 'Unauthorized' }, { status: 401 }), session: null };
  }
  return { denied: null, session };
}

export async function requireTopDashboardSession() {
  const session = await getAdminSession();
  if (!isTopDashboardSession(session)) {
    return {
      denied: Response.json(
        { error: session ? 'Недостаточно прав для просмотра HTML-страниц' : 'Unauthorized' },
        { status: session ? 403 : 401 },
      ),
      session: null,
    };
  }
  return { denied: null, session };
}

export async function requireTopDashboardManagementSession() {
  const session = await getAdminSession();
  if (!isTopDashboardManagementSession(session)) {
    return {
      denied: Response.json(
        { error: session ? 'Недостаточно прав для управления HTML-страницами' : 'Unauthorized' },
        { status: session ? 403 : 401 },
      ),
      session: null,
    };
  }
  return { denied: null, session };
}

export function validateAdminPassword(password: string) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;

  const passwordBuffer = Buffer.from(password);
  const expectedBuffer = Buffer.from(expected);
  if (passwordBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(passwordBuffer, expectedBuffer);
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, PASSWORD_KEYLEN).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, storedHash: string) {
  const [method, salt, hash] = storedHash.split(':');
  if (method !== 'scrypt' || !salt || !hash) return false;

  const calculated = scryptSync(password, salt, PASSWORD_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  return calculated.length === expected.length && timingSafeEqual(calculated, expected);
}
