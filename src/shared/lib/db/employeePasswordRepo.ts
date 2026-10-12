import { decryptEmployeePassword, encryptEmployeePassword, verifyEmployeePasswordCopy } from '../employeePasswordVault';
import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';

export type EmployeePasswordIdentity = { source: 'admin' | 'manager'; id: number };

export function parseEmployeePasswordIdentity(value: string): EmployeePasswordIdentity | null {
  const match = /^(admin|manager):([1-9]\d*)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return { source: match[1] as 'admin' | 'manager', id: Number(match[2]) };
}

// Called only after endpoint authorization. Never include these fields in list DTOs.
export async function readEmployeePassword(identity: EmployeePasswordIdentity, legacyPassword?: string) {
  await ensureSiteSchema();
  if (legacyPassword) {
    // Recover a browser-only copy only after checking the current login hash. Never
    // trust the browser's value, replace a password, or overwrite a newer server copy.
    return withTransaction(async (client) => {
      const result = await client.query<{password_hash: string; password_ciphertext: string | null}>(
        identity.source === 'admin'
          ? 'select password_hash, password_ciphertext from admin_users where id = $1 for update'
          : 'select password_hash, password_ciphertext from wholesale_managers where id = $1 for update',
        [identity.id],
      );
      const row = result.rows[0];
      if (!row) return null;
      const current = decryptEmployeePassword(row.password_ciphertext, row.password_hash);
      if (current !== null) return { password: current };
      if (!await verifyEmployeePasswordCopy(legacyPassword, row.password_hash)) return { password: null };
      const ciphertext = encryptEmployeePassword(legacyPassword, row.password_hash);
      await client.query(identity.source === 'admin'
        ? 'update admin_users set password_ciphertext = $2 where id = $1'
        : "update wholesale_managers set password_ciphertext = $2, display_password = '' where id = $1",
      [identity.id, ciphertext]);
      return { password: legacyPassword };
    });
  }
  const result = await query<{password_hash: string; password_ciphertext: string | null}>(
    identity.source === 'admin'
      ? 'select password_hash, password_ciphertext from admin_users where id = $1'
      : 'select password_hash, password_ciphertext from wholesale_managers where id = $1',
    [identity.id],
  );
  if (!result.rows[0]) return null;
  return { password: decryptEmployeePassword(result.rows[0].password_ciphertext, result.rows[0].password_hash) };
}
