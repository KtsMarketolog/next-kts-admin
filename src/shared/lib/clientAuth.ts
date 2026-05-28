import { cookies } from 'next/headers';

import {
  createStoredClientSession,
  getStoredClientSession,
  revokeStoredClientSession,
} from './db/clientSessionsRepo';

const COOKIE_NAME = 'kts_client_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 100;

export type ClientSession = {
  clientUserId: number;
  companyId: number;
  sessionId?: string;
};

type CreateClientSessionOptions = {
  ip?: string | null;
  userAgent?: string | null;
};

export async function createClientSession(clientUserId: number, options: CreateClientSessionOptions = {}) {
  const storedSession = await createStoredClientSession({
    clientUserId,
    ip: options.ip,
    userAgent: options.userAgent,
    maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
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

export async function clearClientSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) {
    await revokeStoredClientSession(token).catch((error) => {
      console.error('Failed to revoke client session', error);
    });
  }
  jar.delete(COOKIE_NAME);
}

export async function getClientSession(): Promise<ClientSession | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const storedSession = await getStoredClientSession(token);
    if (!storedSession) return null;
    return {
      clientUserId: storedSession.clientUserId,
      companyId: storedSession.companyId,
      sessionId: storedSession.sessionId,
    };
  } catch (error) {
    console.error('Failed to read client session', error);
    return null;
  }
}

export async function requireClientSession() {
  const session = await getClientSession();
  if (!session) {
    return { denied: Response.json({ error: 'Unauthorized' }, { status: 401 }), session: null };
  }
  return { denied: null, session };
}
