import type { PoolClient } from 'pg';

/** Old pending codes cannot prove the checked password version; require a new login. */
export async function applyLoginCredentialMigration(client: PoolClient) {
  await client.query('alter table admin_2fa_challenges add column if not exists credential_proof text');
}
