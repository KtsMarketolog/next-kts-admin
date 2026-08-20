import { randomInt, randomUUID, timingSafeEqual } from 'crypto';

import { hashSensitiveValue, safeHeaderValue } from '../securityHash';
import { query } from './client';
import { ensureSiteSchema } from './schema';

export type TwoFactorActorType = 'admin' | 'manager' | 'client';

export type TwoFactorChallengeActor =
  | {
      challengeId: string;
      actorType: 'admin';
      role: 'admin' | 'wholesale_admin' | 'top';
      login: string;
      adminUserId?: number;
    }
  | {
      challengeId: string;
      actorType: 'manager';
      role: 'manager' | 'support_manager';
      login: string;
      managerId?: number;
    }
  | {
      challengeId: string;
      actorType: 'client';
      role: 'client';
      login: string;
      clientUserId?: number;
    };

const TWO_FACTOR_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export function isTwoFactorEnabled() {
  return process.env.ADMIN_2FA_ENABLED === 'true';
}

export function generateTwoFactorCode() {
  return String(randomInt(100000, 1000000));
}

function hashTwoFactorCode(challengeId: string, loginSessionId: string, code: string) {
  return hashSensitiveValue(`2fa:${challengeId}:${loginSessionId}:${code.trim()}`);
}

export async function createTwoFactorChallenge(input: {
  login: string;
  actorType: TwoFactorActorType;
  role: 'admin' | 'wholesale_admin' | 'manager' | 'support_manager' | 'top' | 'client';
  adminUserId?: number | null;
  managerId?: number | null;
  clientUserId?: number | null;
  loginSessionId: string;
  code: string;
}) {
  await ensureSiteSchema();
  const challengeId = randomUUID();
  const expiresAt = new Date(Date.now() + TWO_FACTOR_TTL_MS);

  await query(
    `insert into admin_2fa_challenges (
       id,
       login,
       actor_type,
       role,
       admin_user_id,
       manager_id,
       client_user_id,
       code_hash,
       login_session_id,
       expires_at
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      challengeId,
      safeHeaderValue(input.login, 160),
      input.actorType,
      input.role,
      input.adminUserId ?? null,
      input.managerId ?? null,
      input.clientUserId ?? null,
      hashTwoFactorCode(challengeId, input.loginSessionId, input.code),
      safeHeaderValue(input.loginSessionId, 160),
      expiresAt,
    ],
  );

  return challengeId;
}

export async function consumeTwoFactorChallenge(input: {
  challengeId: string;
  loginSessionId: string;
  code: string;
}): Promise<TwoFactorChallengeActor | null> {
  await ensureSiteSchema();
  const result = await query<{
    id: string;
    login: string;
    actor_type: string;
    role: string;
    admin_user_id: string | null;
    manager_id: string | null;
    client_user_id: string | null;
    code_hash: string;
    attempts: number;
  }>(
    `select
       id::text,
       login,
       actor_type,
       role,
       admin_user_id::text,
       manager_id::text,
       client_user_id::text,
       code_hash,
       attempts
     from admin_2fa_challenges
     where id = $1
       and login_session_id = $2
       and consumed_at is null
       and expires_at > now()
     limit 1`,
    [input.challengeId, safeHeaderValue(input.loginSessionId, 160)],
  );

  const row = result.rows[0];
  if (!row || row.attempts >= MAX_ATTEMPTS) return null;

  const expected = Buffer.from(row.code_hash);
  const actual = Buffer.from(hashTwoFactorCode(row.id, input.loginSessionId, input.code));
  const valid = expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!valid) {
    await query(`update admin_2fa_challenges set attempts = attempts + 1 where id = $1`, [row.id]);
    return null;
  }

  await query(`update admin_2fa_challenges set consumed_at = now() where id = $1`, [row.id]);

  if (row.actor_type === 'client') {
    if (row.role !== 'client') return null;
    return {
      challengeId: row.id,
      actorType: 'client',
      role: 'client',
      login: row.login,
      clientUserId: row.client_user_id ? Number(row.client_user_id) : undefined,
    };
  }

  if (row.actor_type === 'manager') {
    if (row.role !== 'manager' && row.role !== 'support_manager') return null;
    return {
      challengeId: row.id,
      actorType: 'manager',
      role: row.role,
      login: row.login,
      managerId: row.manager_id ? Number(row.manager_id) : undefined,
    };
  }

  if (row.actor_type !== 'admin') return null;
  if (row.role !== 'admin' && row.role !== 'wholesale_admin' && row.role !== 'top') return null;

  return {
    challengeId: row.id,
    actorType: 'admin',
    role: row.role,
    login: row.login,
    adminUserId: row.admin_user_id ? Number(row.admin_user_id) : undefined,
  };
}
