import type { PoolClient } from 'pg';
import {
  assertLoginCredentialProof, environmentLoginCredentialProof, loginCredentialProof, LoginCredentialsChangedError,
} from '../loginCredentialProof';

export type VerifiedLoginIdentity = {
  actorType: 'admin' | 'manager' | 'client';
  role: string;
  adminUserId?: number | null;
  managerId?: number | null;
  clientUserId?: number | null;
  credentialProof: string;
};

/** Caller must retain this transaction/row lock through its session/challenge INSERT. */
export async function lockVerifiedLoginCredential(client: Pick<PoolClient, 'query'>, input: VerifiedLoginIdentity) {
  if (!input.credentialProof) throw new LoginCredentialsChangedError();
  if (input.actorType === 'admin' && input.adminUserId == null) {
    if (input.role !== 'admin' || input.managerId != null || input.clientUserId != null || !process.env.ADMIN_PASSWORD) {
      throw new LoginCredentialsChangedError();
    }
    assertLoginCredentialProof(input.credentialProof, environmentLoginCredentialProof(process.env.ADMIN_PASSWORD));
    return;
  }
  const id = input.actorType === 'admin' ? input.adminUserId : input.actorType === 'manager' ? input.managerId : input.clientUserId;
  if (!Number.isSafeInteger(id) || Number(id) <= 0) throw new LoginCredentialsChangedError();
  // All client mutations take company before user, including archive/password changes.
  if (input.actorType === 'client') {
    const company = await client.query(`select cc.id from client_companies cc join client_users cu on cu.company_id = cc.id
      where cu.id = $1 and cc.is_active = true and cc.archived_at is null for update of cc`, [id]);
    if (!company.rowCount || input.role !== 'client') throw new LoginCredentialsChangedError();
  }
  const table = input.actorType === 'admin' ? 'admin_users' : input.actorType === 'manager' ? 'wholesale_managers' : 'client_users';
  const role = input.actorType === 'client' ? "'client'" : input.actorType === 'manager' ? "coalesce(nullif(role, ''), 'manager')" : 'role';
  const result = await client.query<{
    id: string; login: string; email: string; role: string; password_hash: string; password_changed_at: string | null;
  }>(`select id::text, login, email, ${role} as role, password_hash, password_changed_at::text
      from ${table} where id = $1 and is_active = true for update`, [id]);
  const row = result.rows[0];
  if (!row || row.role !== input.role) throw new LoginCredentialsChangedError();
  assertLoginCredentialProof(input.credentialProof, loginCredentialProof(input.actorType, row.role, {
    id: Number(row.id), login: row.login, email: row.email,
    passwordHash: row.password_hash, passwordChangedAt: row.password_changed_at,
  }));
}
