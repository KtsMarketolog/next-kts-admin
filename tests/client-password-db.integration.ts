/** Synthetic acceptance only: scripts/test-client-password-postgres.sh. */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { AdminSession } from '../src/shared/lib/adminAuth';
import { hashEmployeePassword } from '../src/shared/lib/employeePasswordHash';
import { verifyEmployeePasswordCopy } from '../src/shared/lib/employeePasswordVault';
import { decryptClientPassword, encryptClientPassword } from '../src/shared/lib/clientPasswordVault';
import { query, withTransaction } from '../src/shared/lib/db/client';
import {
  createClientCompany, deleteClientCompany, getClientCompanies, getClientUserByLogin,
  restoreClientCompany, updateClientCompany, updateClientUserPassword,
} from '../src/shared/lib/db/clientCompaniesRepo';
import type { ClientCompanyInput } from '../src/shared/lib/db/clientCompanyTypes';
import { applyClientPasswordMigration } from '../src/shared/lib/db/clientPasswordMigration';
import { readClientCompanyPassword } from '../src/shared/lib/db/clientPasswordRepo';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';

function guard() {
  assert.equal(process.env.KTS_CLIENT_PASSWORD_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_client_password_integration');
  assert.equal(url.username, 'password_app');
  assert.equal(url.password, '');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-client-password-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55484');
}

const admin: AdminSession = { role: 'admin' };
const oldPassword = 'SyntheticClientOriginal123!';
const newPassword = 'SyntheticClientReplacement321!';
function assertNoCredentials(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), /"(?:password|displayPassword|display_password|passwordHash|password_hash|passwordCiphertext|password_ciphertext)"\s*:|scrypt:|SyntheticClient(?:Original|Replacement)/);
}
async function stored(id: number) {
  return (await query<{ id: string; company_id: string; password_hash: string; password_ciphertext: string | null; display_password: string;
    password_changed_at: string; updated_at: string; created_at: string; is_active: boolean }>(
    `select id::text, company_id::text, password_hash, password_ciphertext, display_password,
      password_changed_at::text, updated_at::text, created_at::text, is_active from client_users where id=$1`, [id],
  )).rows[0];
}

test('client password vault preserves accounts and enforces current scoped reveal in PostgreSQL', { timeout: 180_000 }, async (t) => {
  guard();
  try {
    assert.equal((await query("select to_regclass('public.client_companies')::text as present")).rows[0].present, null);
    await ensureSiteSchema();
    assert.deepEqual((await query('select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user')).rows[0],
      { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    const hash = await hashEmployeePassword(oldPassword);
    const nextHash = await hashEmployeePassword(newPassword);
    const managers = (await query<{ id: string }>(`insert into wholesale_managers (login,name,email,role)
      values ('vault-mr','Synthetic MR','vault-mr@example.test','manager'),
      ('vault-ms','Synthetic MS','vault-ms@example.test','support_manager'),
      ('vault-other','Synthetic other','vault-other@example.test','manager') returning id::text`)).rows.map((row) => Number(row.id));
    const input: ClientCompanyInput = { title: 'Synthetic vault client', inn: '', kpp: '', contactName: '', email: 'vault-client@example.test',
      phone: '', address: '', note: 'Retain business data', managerId: managers[0], supportManagerId: managers[1], requireTwoFactor: false,
      isActive: true, passwordHash: hash, displayPassword: oldPassword };
    let company = await createClientCompany(input, admin);
    const userId = company.clientUserId!;

    await t.test('create/list responses omit every copy while persisted password is encrypted and login works', async () => {
      assertNoCredentials(company);
      assertNoCredentials(await getClientCompanies(admin));
      const row = await stored(userId);
      assert.equal(row.display_password, '');
      assert.equal(row.password_hash, hash);
      assert.equal(decryptClientPassword(row.password_ciphertext, hash), oldPassword);
      const auth = await getClientUserByLogin(input.email);
      assert.equal(auth?.id, userId);
      assert.equal(await verifyEmployeePasswordCopy(oldPassword, auth!.passwordHash), true);
    });

    await t.test('admin/wholesale_admin and assigned operational employees can reveal without changing existing cross-column permissions', async () => {
      for (const session of [admin, { role: 'wholesale_admin' }, { role: 'manager', managerId: managers[0] },
        { role: 'support_manager', managerId: managers[1] }, { role: 'manager', managerId: managers[1] },
        { role: 'support_manager', managerId: managers[0] }] as AdminSession[]) {
        assert.deepEqual(await readClientCompanyPassword(company.id, session), { password: oldPassword, clientUserId: userId });
      }
      for (const session of [{ role: 'top' }, { role: 'admintop' }, { role: 'purchaser' }, { role: 'manager' },
        { role: 'manager', managerId: managers[2] }] as AdminSession[]) {
        assert.equal(await readClientCompanyPassword(company.id, session), null);
      }
      assert.equal(await readClientCompanyPassword(999999, admin), null);
      const secondary = (await query<{ id: string }>(`insert into client_users
        (company_id,name,email,login,password_hash,password_ciphertext) values ($1,'Secondary','secondary@example.test','secondary@example.test',$2,$3) returning id::text`,
      [company.id, nextHash, encryptClientPassword(newPassword, nextHash)])).rows[0];
      assert.ok(secondary.id);
      assert.deepEqual(await readClientCompanyPassword(company.id, admin), { password: oldPassword, clientUserId: userId });
    });

    await t.test('profile save preserves current credential, replacement atomically updates hash/copy and removes plaintext', async () => {
      const before = await stored(userId);
      company = await updateClientCompany(company.id, { ...input, expectedUpdatedAt: company.updatedAt, note: 'New business note', passwordHash: undefined, displayPassword: undefined }, admin);
      assertNoCredentials(company);
      const profile = await stored(userId);
      for (const key of ['password_hash', 'password_ciphertext', 'password_changed_at'] as const) assert.equal(profile[key], before[key]);
      company = await updateClientCompany(company.id, { ...input, expectedUpdatedAt: company.updatedAt, passwordHash: nextHash, displayPassword: newPassword }, admin);
      assertNoCredentials(company);
      const after = await stored(userId);
      assert.equal(after.display_password, '');
      assert.equal(after.password_hash, nextHash);
      assert.equal(decryptClientPassword(after.password_ciphertext, nextHash), newPassword);
      assert.equal(await verifyEmployeePasswordCopy(oldPassword, after.password_hash), false);
      assert.deepEqual(await readClientCompanyPassword(company.id, admin), { password: newPassword, clientUserId: userId });
    });

    await t.test('portal password change updates the same encrypted copy; stale packet is never returned', async () => {
      await updateClientUserPassword(userId, hash, oldPassword);
      assert.equal((await stored(userId)).display_password, '');
      assert.deepEqual(await readClientCompanyPassword(company.id, admin), { password: oldPassword, clientUserId: userId });
      await query('update client_users set password_hash=$2 where id=$1', [userId, nextHash]);
      assert.deepEqual(await readClientCompanyPassword(company.id, admin), { password: null, clientUserId: userId });
      await updateClientUserPassword(userId, nextHash, newPassword);
    });

    await t.test('unrelated profile edits preserve opaque credentials during a dedicated-key outage', async () => {
      const dedicatedKey = Buffer.alloc(32, 73).toString('base64');
      process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = dedicatedKey;
      try {
        company = await updateClientCompany(company.id, { ...input, expectedUpdatedAt: company.updatedAt, passwordHash: nextHash, displayPassword: newPassword }, admin);
        const before = await stored(userId);
        process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = 'invalid';
        company = await updateClientCompany(company.id, { ...input, expectedUpdatedAt: company.updatedAt,
          passwordHash: undefined, displayPassword: undefined, note: 'Opaque preservation test' }, admin);
        assertNoCredentials(company);
        const after = await stored(userId);
        for (const key of ['password_hash', 'password_ciphertext', 'password_changed_at'] as const) assert.equal(after[key], before[key]);
        await assert.rejects(readClientCompanyPassword(company.id, admin), /32-byte/);
        process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = dedicatedKey;
        assert.deepEqual(await readClientCompanyPassword(company.id, admin), { password: newPassword, clientUserId: userId });
      } finally { delete process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY; }
      // New test fixtures revert to the stable session-derived key.
      company = await updateClientCompany(company.id, { ...input, expectedUpdatedAt: company.updatedAt, passwordHash: nextHash, displayPassword: newPassword }, admin);
    });

    await t.test('archive responses remain safe and credentials unavailable until explicit restore', async () => {
      const before = await stored(userId);
      company = await deleteClientCompany(company.id, admin, company.updatedAt);
      assertNoCredentials(company);
      assertNoCredentials(await getClientCompanies(admin, 'archived'));
      assert.equal(await readClientCompanyPassword(company.id, admin), null);
      assert.deepEqual(await stored(userId), before);
      company = await restoreClientCompany(company.id, admin, company.updatedAt);
      assertNoCredentials(company);
      assert.equal(company.isActive, false);
      assert.deepEqual(await readClientCompanyPassword(company.id, admin), { password: newPassword, clientUserId: userId });
    });

    await t.test('migration validates legacy copies, preserves login/account dates and survives replay', async () => {
      // Reconstruct the pre-migration schema only in this guarded disposable DB.
      await query('alter table client_users drop constraint client_users_display_password_empty');
      const fixtureIds: number[] = [];
      for (const [index, legacy] of [oldPassword, 'SyntheticOutdatedCopy123!', '', 'z'.repeat(201)].entries()) {
        fixtureIds.push(Number((await query<{ id: string }>(`insert into client_users
          (company_id,name,email,login,password_hash,display_password,password_changed_at,updated_at)
          values ($1,'Legacy',$2,$2,$3,$4,'2020-01-01','2020-01-02') returning id::text`,
        [company.id, `legacy-${index}@example.test`, hash, legacy])).rows[0].id));
      }
      const current = Number((await query<{ id: string }>(`insert into client_users
        (company_id,name,email,login,password_hash,password_ciphertext,display_password,password_changed_at,updated_at)
        values ($1,'Current','current@example.test','current@example.test',$2,$3,$4,'2020-01-01','2020-01-02') returning id::text`,
      [company.id, nextHash, encryptClientPassword(newPassword, nextHash), oldPassword])).rows[0].id);
      fixtureIds.push(current);
      const before = await Promise.all(fixtureIds.map(stored));
      await withTransaction(applyClientPasswordMigration);
      const after = await Promise.all(fixtureIds.map(stored));
      after.forEach((row, index) => {
        assert.equal(row.display_password, '');
        assert.equal(decryptClientPassword(row.password_ciphertext, row.password_hash), index === 0 ? oldPassword : index === 4 ? newPassword : null);
        for (const key of ['id', 'company_id', 'password_hash', 'password_changed_at', 'updated_at', 'created_at', 'is_active'] as const) {
          assert.equal(row[key], before[index][key], key);
        }
      });
      await withTransaction(applyClientPasswordMigration);
      assert.deepEqual(await Promise.all(fixtureIds.map(stored)), after);
    });

    await t.test('migration visits all 82 mixed-width numeric IDs across multiple batches', async () => {
      // A temporary pre-upgrade table shadows the application table only on this
      // transaction connection. IDs 1..82 expose ORDER BY id::text alias bugs.
      await withTransaction(async (client) => {
        await client.query(`create temporary table client_users (
          id bigint primary key, password_hash text not null,
          display_password text not null default '', password_ciphertext text
        ) on commit drop`);
        await client.query(`insert into client_users (id, password_hash, display_password)
          select id, $1, $2 from generate_series(1, 82) as id`, [hash, oldPassword]);
        await applyClientPasswordMigration(client);
        const rows = (await client.query<{ id: string; password_hash: string; display_password: string; password_ciphertext: string }>(
          'select id::text, password_hash, display_password, password_ciphertext from client_users order by client_users.id',
        )).rows;
        assert.equal(rows.length, 82);
        for (const [index, row] of rows.entries()) {
          assert.equal(Number(row.id), index + 1);
          assert.equal(row.password_hash, hash);
          assert.equal(row.display_password, '');
          assert.equal(decryptClientPassword(row.password_ciphertext, hash), oldPassword);
        }
        await applyClientPasswordMigration(client);
        assert.deepEqual((await client.query('select id::text, password_hash, display_password, password_ciphertext from client_users order by client_users.id')).rows, rows);
      });
    });

    await t.test('bad encryption configuration rolls back migration and regular writes without losing plaintext or login', async () => {
      await query('alter table client_users drop constraint client_users_display_password_empty');
      await query('update client_users set display_password=$2, password_ciphertext=null where id=$1', [userId, newPassword]);
      const before = await stored(userId);
      process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = 'invalid';
      try {
        await assert.rejects(withTransaction(applyClientPasswordMigration), /32-byte/);
        assert.deepEqual(await stored(userId), before);
        await assert.rejects(updateClientCompany(company.id, { ...input, expectedUpdatedAt: company.updatedAt, passwordHash: hash, displayPassword: oldPassword }, admin), /32-byte/);
        assert.deepEqual(await stored(userId), before);
      } finally { delete process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY; }
      await withTransaction(applyClientPasswordMigration);
      assert.equal((await stored(userId)).display_password, '');
      assert.deepEqual(await readClientCompanyPassword(company.id, admin), { password: newPassword, clientUserId: userId });
    });

    await t.test('mixed-version and rollback writers cannot restore plaintext; their whole save rolls back', async () => {
      const before = await stored(userId);
      const originalNote = (await query('select note from client_companies where id=$1', [company.id])).rows[0].note;
      await assert.rejects(withTransaction(async (client) => {
        await client.query("update client_companies set note='Must roll back' where id=$1", [company.id]);
        await client.query('update client_users set password_hash=$2, display_password=$3, password_changed_at=now() where id=$1', [userId, hash, oldPassword]);
      }), (error: unknown) => (error as { code?: string }).code === '23514');
      assert.deepEqual(await stored(userId), before);
      assert.equal((await query('select note from client_companies where id=$1', [company.id])).rows[0].note, originalNote);
      await assert.rejects(query(`insert into client_users (company_id,name,email,login,password_hash,display_password)
        values ($1,'Blocked legacy','blocked-legacy@example.test','blocked-legacy@example.test',$2,$3)`, [company.id, hash, oldPassword]),
      (error: unknown) => (error as { code?: string }).code === '23514');
      assert.equal((await query("select count(*)::int as n from client_users where display_password <> ''")).rows[0].n, 0);
      assert.equal((await query("select convalidated from pg_constraint where conname='client_users_display_password_empty'")).rows[0].convalidated, true);
      // The older profile-only writer preserves an empty display column and works.
      await query("update client_users set display_password = case when $2::text is null then display_password else $2 end where id=$1", [userId, null]);
      assert.deepEqual(await stored(userId), before);
      await withTransaction(applyClientPasswordMigration);
      assert.deepEqual(await stored(userId), before);
    });
  } finally {
    await (globalThis as typeof globalThis & { __ktsPgPool?: { end(): Promise<void> } }).__ktsPgPool?.end();
  }
});
