import { cookies } from 'next/headers';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const COOKIE_NAME = 'kts_admin_session';
const PASSWORD_KEYLEN = 64;

export type AdminSession = {
  role: 'admin' | 'wholesale_admin' | 'manager';
  managerId?: number;
};

function secret() {
  return process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || 'dev-secret';
}

function sign(value: string) {
  return createHmac('sha256', secret()).update(value).digest('hex');
}

export async function createAdminSession(role: 'admin' | 'wholesale_admin' = 'admin') {
  return createEmployeeSession({ role });
}

export async function createEmployeeSession(session: AdminSession) {
  const value = `${Date.now()}:${session.role}:${session.managerId ?? ''}`;
  const token = `${value}.${sign(value)}`;
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.ADMIN_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 8,
  });
}

export async function clearAdminSession() {
  const jar = await cookies();
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
