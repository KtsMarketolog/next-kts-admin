import { randomBytes, randomUUID } from 'crypto';

import { hashSensitiveValue, safeHeaderValue } from '../securityHash';
import { query } from './client';
import { ensureSiteSchema } from './schema';

export type StoredClientSession = {
  sessionId: string;
  clientUserId: number;
  companyId: number;
  createdAt: string;
  expiresAt: string;
};

type CreateClientSessionInput = {
  clientUserId: number;
  ip?: string | null;
  userAgent?: string | null;
  maxAgeSeconds?: number;
};

const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 100;

function hashSessionToken(token: string) {
  return hashSensitiveValue(`client-session:${token}`);
}

export async function createStoredClientSession(input: CreateClientSessionInput) {
  await ensureSiteSchema();
  const token = randomBytes(32).toString('base64url');
  const sessionId = randomUUID();
  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const expiresAt = new Date(Date.now() + maxAgeSeconds * 1000);

  await query(
    `insert into client_sessions (
       id, session_hash, client_user_id, ip_hash, user_agent, expires_at
     )
     values ($1, $2, $3, $4, $5, $6)`,
    [
      sessionId,
      hashSessionToken(token),
      input.clientUserId,
      hashSensitiveValue(input.ip || ''),
      safeHeaderValue(input.userAgent, 500),
      expiresAt,
    ],
  );

  return { token, sessionId, expiresAt };
}

export async function getStoredClientSession(token: string): Promise<StoredClientSession | null> {
  if (!token || token.length < 32 || token.length > 256) return null;

  await ensureSiteSchema();
  const result = await query<{
    id: string;
    client_user_id: string;
    company_id: string;
    created_at: string;
    expires_at: string;
    user_is_active: boolean;
    company_is_active: boolean;
    password_changed_at: string | null;
  }>(
    `select
       s.id::text,
       s.client_user_id::text,
       cu.company_id::text,
       s.created_at::text,
       s.expires_at::text,
       cu.is_active as user_is_active,
       cc.is_active as company_is_active,
       cu.password_changed_at::text
     from client_sessions s
     join client_users cu on cu.id = s.client_user_id
     join client_companies cc on cc.id = cu.company_id
     where s.session_hash = $1
       and s.revoked_at is null
       and s.expires_at > now()
     limit 1`,
    [hashSessionToken(token)],
  );

  const row = result.rows[0];
  if (!row) return null;

  const createdAtMs = new Date(row.created_at).getTime();
  if (row.password_changed_at && createdAtMs < new Date(row.password_changed_at).getTime()) {
    await revokeStoredClientSession(token);
    return null;
  }

  if (!row.user_is_active || !row.company_is_active) {
    await revokeStoredClientSession(token);
    return null;
  }

  await query(`update client_sessions set last_seen_at = now() where id = $1`, [row.id]).catch((error) => {
    console.error('Failed to update client session last_seen_at', error);
  });

  return {
    sessionId: row.id,
    clientUserId: Number(row.client_user_id),
    companyId: Number(row.company_id),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function revokeStoredClientSession(token: string) {
  if (!token) return;
  await ensureSiteSchema();
  await query(
    `update client_sessions
     set revoked_at = coalesce(revoked_at, now())
     where session_hash = $1`,
    [hashSessionToken(token)],
  );
}

export async function revokeClientUserSessions(clientUserId: number) {
  await ensureSiteSchema();
  await query(
    `update client_sessions
     set revoked_at = coalesce(revoked_at, now())
     where client_user_id = $1 and revoked_at is null`,
    [clientUserId],
  );
}
