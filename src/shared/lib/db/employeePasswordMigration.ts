import type { PoolClient } from 'pg';

import { resolveEmployeePasswordCiphertext } from '../employeePasswordVault';

export async function applyEmployeePasswordMigration(client: PoolClient) {
  await client.query(`
    alter table admin_users add column if not exists password_ciphertext text;
    alter table wholesale_managers add column if not exists password_ciphertext text;
  `);
  // Only display copies are migrated. Login hashes, account IDs, roles, prices and data stay untouched.
  // Check each legacy copy against the real login hash before making it displayable again.
  const result = await client.query<{
    id: number; password_hash: string; password_ciphertext: string | null; display_password: string;
  }>(`select id, password_hash, password_ciphertext, display_password
      from wholesale_managers where display_password <> '' for update`);
  for (const row of result.rows) {
    const ciphertext = await resolveEmployeePasswordCiphertext({
      passwordHash: row.password_hash,
      previousCiphertext: row.password_ciphertext,
      legacyPassword: row.display_password,
    });
    await client.query(`update wholesale_managers set password_ciphertext = $2, display_password = '' where id = $1`, [row.id, ciphertext]);
  }
}
