import { cookies } from 'next/headers';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

import { getAdminSessionSecret } from './authSecret';
import { createStoredAdminSession, getStoredAdminSession, revokeStoredAdminSession } from './db/adminSessionsRepo';

const COOKIE_NAME = 'kts_admin_session';
const PASSWORD_KEYLEN = 64;

export type AdminSession = {
  role: 'admin' | 'wholesale_admin' | 'manager';
  adminUserId?: number;
  managerId?: number;
  sessionId?: string;
};

type CreateSessionOptions = {
  adminUserId?: number | null;
  ip?: string | null;
  userAgent?: string | null;
};

function sign(value: string) {
  return createHmac('sha256', getAdminSessionSecret()).update(value).digest('hex');
}

export async function createAdminSession(
  role: 'admin' | 'wholesale_admin' = 'admin',
  options: CreateSessionOptions = {},
) {
  return createEmployeeSession({ role, adminUserId: options.adminUserId ?? undefined }, options);
}

export async function createEmployeeSession(session: AdminSession, options: CreateSessionOptions = {}) {
  const storedSession = await createStoredAdminSession({
    role: session.role,
    adminUserId: session.adminUserId ?? options.adminUserId ?? null,
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
    maxAge: 60 * 60 * 8,
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
  if (!Number.isFinite(age) || age < 0 || age > 1000 * 60 * 60 * 8) return null;

  if (!timingSafeEqual(a, b)) return null;

  if (role === 'manager') {
    const parsedManagerId = Number(managerId);
    if (!Number.isInteger(parsedManagerId)) return null;
    return { role: 'manager', managerId: parsedManagerId };
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
  if (session?.role !== 'admin') {
    return { denied: Response.json({ error: 'Unauthorized' }, { status: 401 }), session: null };
  }
  return { denied: null, session };
}

export async function requireEmployee() {
  const session = await getAdminSession();
  if (!session) {
    return { denied: Response.json({ error: 'Unauthorized' }, { status: 401 }), session: null };
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
