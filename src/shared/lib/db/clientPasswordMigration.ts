import type { PoolClient } from 'pg';

import { resolveClientPasswordCiphertext } from '../clientPasswordVault';

const BATCH_SIZE = 50;

/** Run within the migration transaction: no login hash or account timestamps change. */
export async function applyClientPasswordMigration(client: PoolClient) {
  await client.query('alter table client_users add column if not exists password_ciphertext text');
  let lastId = '0';
  for (;;) {
    const result = await client.query<{
      id: string; password_hash: string; password_ciphertext: string | null; display_password: string | null;
    }>(`select id::text, password_hash, password_ciphertext,
          case when char_length(display_password) <= 200 then display_password else null end as display_password
        from client_users where id > $1::bigint and display_password <> ''
        order by id limit $2 for update`, [lastId, BATCH_SIZE]);
    if (!result.rows.length) break;
    for (const row of result.rows) {
      const ciphertext = await resolveClientPasswordCiphertext({
        passwordHash: row.password_hash,
        previousCiphertext: row.password_ciphertext,
        legacyPassword: row.display_password,
      });
      await client.query("update client_users set password_ciphertext = $2, display_password = '' where id = $1", [row.id, ciphertext]);
    }
    lastId = result.rows[result.rows.length - 1].id;
  }
  // A canary migrates while the previous release is still serving. Keep old
  // password writers (including a rolled-back release) from putting plaintext
  // back. Those old password mutations fail atomically; existing logins and
  // profile-only edits remain valid. Forward-fix rather than remove this guard.
  await client.query(`do $$ begin
    if not exists (select 1 from pg_constraint
      where conrelid = 'client_users'::regclass and conname = 'client_users_display_password_empty') then
      alter table client_users add constraint client_users_display_password_empty check (display_password = '');
    end if;
  end $$;
  alter table client_users validate constraint client_users_display_password_empty`);
}
