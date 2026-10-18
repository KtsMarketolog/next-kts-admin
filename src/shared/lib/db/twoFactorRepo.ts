import { randomInt, randomUUID, timingSafeEqual } from 'crypto';

import { hashSensitiveValue, safeHeaderValue } from '../securityHash';
import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';
import { lockVerifiedLoginCredential } from './loginCredentialsRepo';

export type TwoFactorActorType = 'admin' | 'manager' | 'client';

export type TwoFactorChallengeActor = { credentialProof: string } & (
  | {
      challengeId: string;
      createdAt: string;
      actorType: 'admin';
      role: 'admin' | 'wholesale_admin' | 'top' | 'admintop' | 'purchaser';
      login: string;
      adminUserId?: number;
    }
  | {
      challengeId: string;
      createdAt: string;
      actorType: 'manager';
      role: 'manager' | 'support_manager';
      login: string;
      managerId?: number;
    }
  | {
      challengeId: string;
      createdAt: string;
      actorType: 'client';
      role: 'client';
      login: string;
      clientUserId?: number;
    });

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
  role: 'admin' | 'wholesale_admin' | 'manager' | 'support_manager' | 'top' | 'admintop' | 'purchaser' | 'client';
  adminUserId?: number | null;
  managerId?: number | null;
  clientUserId?: number | null;
  loginSessionId: string;
  code: string;
  credentialProof: string;
}) {
  await ensureSiteSchema();
  const challengeId = randomUUID();
  const expiresAt = new Date(Date.now() + TWO_FACTOR_TTL_MS);

  await withTransaction(async (client) => {
    await lockVerifiedLoginCredential(client, input);
    await client.query(
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
         expires_at,
         credential_proof
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
        input.credentialProof,
      ],
    );
  });

  return challengeId;
}

export async function invalidateTwoFactorChallenge(challengeId: string, loginSessionId: string) {
  await ensureSiteSchema();
  await query(
    `update admin_2fa_challenges
     set consumed_at = coalesce(consumed_at, now())
     where id = $1 and login_session_id = $2`,
    [challengeId, safeHeaderValue(loginSessionId, 160)],
  );
}

export async function consumeTwoFactorChallenge(input: {
  challengeId: string;
  loginSessionId: string;
  code: string;
}): Promise<TwoFactorChallengeActor | null> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.challengeId)) return null;
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      login: string;
      actor_type: string;
      role: string;
      admin_user_id: string | null;
      manager_id: string | null;
      client_user_id: string | null;
      created_at: string;
      code_hash: string;
      attempts: number;
      credential_proof: string | null;
    }>(
      `select
         id::text,
         login,
         actor_type,
         role,
         admin_user_id::text,
         manager_id::text,
         client_user_id::text,
         created_at::text,
         code_hash,
         attempts,
         credential_proof
       from admin_2fa_challenges
       where id = $1
         and login_session_id = $2
         and consumed_at is null
         and expires_at > clock_timestamp()
       limit 1 for update`,
      [input.challengeId, safeHeaderValue(input.loginSessionId, 160)],
    );

    const row = result.rows[0];
    if (!row || row.attempts >= MAX_ATTEMPTS || !/^[a-f0-9]{64}$/.test(row.credential_proof ?? '')) return null;
    const credentialProof = row.credential_proof!;

    const expected = Buffer.from(row.code_hash);
    const actual = Buffer.from(hashTwoFactorCode(row.id, input.loginSessionId, input.code));
    const valid = expected.length === actual.length && timingSafeEqual(expected, actual);

    if (!valid) {
      await client.query(`update admin_2fa_challenges set attempts = attempts + 1 where id = $1 and attempts < $2
        and consumed_at is null and expires_at > clock_timestamp()`, [row.id, MAX_ATTEMPTS]);
      return null;
    }

    // Re-check wall time AFTER acquiring the lock; a queued request may have expired.
    const consumed = await client.query(`update admin_2fa_challenges set consumed_at = clock_timestamp()
      where id = $1 and consumed_at is null and attempts < $2 and expires_at > clock_timestamp() returning id`, [row.id, MAX_ATTEMPTS]);
    if (!consumed.rowCount) return null;

    if (row.actor_type === 'client') {
      if (row.role !== 'client') return null;
      return {
        challengeId: row.id,
        credentialProof,
        createdAt: row.created_at,
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
        credentialProof,
        createdAt: row.created_at,
        actorType: 'manager',
        role: row.role,
        login: row.login,
        managerId: row.manager_id ? Number(row.manager_id) : undefined,
      };
    }

    if (row.actor_type !== 'admin') return null;
    if (
      row.role !== 'admin'
      && row.role !== 'wholesale_admin'
      && row.role !== 'top'
      && row.role !== 'admintop'
      && row.role !== 'purchaser'
    ) return null;

    return {
      challengeId: row.id,
      credentialProof,
      createdAt: row.created_at,
      actorType: 'admin',
      role: row.role,
      login: row.login,
      adminUserId: row.admin_user_id ? Number(row.admin_user_id) : undefined,
    };
  });
}
