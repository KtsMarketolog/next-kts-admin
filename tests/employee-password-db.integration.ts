/** Synthetic identities only. Run against the disposable purchaser PostgreSQL cluster. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { createAccessUser, getAccessUsers, updateAccessUser, type AccessUser } from '../src/shared/lib/db/adminUsersRepo';
import { createStoredAdminSession } from '../src/shared/lib/db/adminSessionsRepo';
import { query, withTransaction } from '../src/shared/lib/db/client';
import { applyEmployeePasswordMigration } from '../src/shared/lib/db/employeePasswordMigration';
import { readEmployeePassword } from '../src/shared/lib/db/employeePasswordRepo';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { createWholesaleManager, getWholesaleManagers, updateWholesaleManager } from '../src/shared/lib/db/wholesaleAdminRepo/managerRepo';
import { hashEmployeePassword } from '../src/shared/lib/employeePasswordHash';
import { decryptEmployeePassword, verifyEmployeePasswordCopy } from '../src/shared/lib/employeePasswordVault';

function guard() {
  assert.equal(process.env.KTS_PURCHASER_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_purchaser_integration');
  assert.equal(url.username, 'purchaser_app');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-purchaser-postgres\.[A-Za-z0-9]+\/socket$/);
}

const originalPassword = 'SyntheticOriginal8162!';
const replacementPassword = 'SyntheticReplacement2841!';
const values = (role: 'top' | 'manager' = 'manager') => ({
  name: 'Synthetic employee password test', login: `password-${randomUUID()}`, email: '', role,
  isActive: true, canManageTopDashboard: false, supportManagerId: null, dashboardAccess: [] as string[],
});
const identity = (user: Pick<AccessUser, 'source' | 'numericId'>) => user.source === 'admin'
  ? { role: 'top' as const, adminUserId: user.numericId }
  : { role: 'manager' as const, managerId: user.numericId };

async function readCredential(user: Pick<AccessUser, 'source' | 'numericId'>) {
  const result = await query<{
    name: string; login: string; role: string; password_hash: string; password_ciphertext: string | null;
    password_changed_at: string; is_active: boolean; display_password: string;
  }>(user.source === 'admin'
    ? `select name, login, role, password_hash, password_ciphertext, password_changed_at::text, is_active, '' as display_password from admin_users where id=$1`
    : `select name, login, role, password_hash, password_ciphertext, password_changed_at::text, is_active, display_password from wholesale_managers where id=$1`, [user.numericId]);
  assert.ok(result.rows[0]); return result.rows[0];
}

async function assertRevoked(sessionId: string, expected: boolean) {
  const result = await query<{ revoked: boolean }>('select revoked_at is not null as revoked from admin_sessions where id=$1', [sessionId]);
  assert.equal(result.rows[0]?.revoked, expected);
}

async function withRevocationFailure(sessionId: string, work: () => Promise<void>) {
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  // Deliberate DB failure, narrowly attached to a synthetic session in the guarded disposable DB.
  await query(`create function employee_password_test_revoke_failure() returns trigger language plpgsql as $$
    begin raise exception 'synthetic session revocation failure'; end; $$`);
  try {
    await query(`create trigger employee_password_test_revoke_failure before update on admin_sessions
      for each row when (old.id = '${sessionId}'::uuid) execute function employee_password_test_revoke_failure()`);
    await work();
  } finally {
    await query('drop trigger if exists employee_password_test_revoke_failure on admin_sessions');
    await query('drop function employee_password_test_revoke_failure()');
  }
}

test('employee password correctness in isolated PostgreSQL', async (t) => {
  guard();
  try {
    await ensureSiteSchema();
    const originalHash = await hashEmployeePassword(originalPassword);
    const replacementHash = await hashEmployeePassword(replacementPassword);

    for (const role of ['top', 'manager'] as const) {
      await t.test(`${role}: central create/update, empty save, DTO and rollback`, async () => {
        const input = values(role);
        const user = await createAccessUser({ ...input, passwordHash: originalHash, password: originalPassword });
        assert.doesNotMatch(JSON.stringify(user), /"(?:password|passwordHash|passwordCiphertext|password_hash|password_ciphertext|displayPassword|display_password)"\s*:|scrypt:|SyntheticOriginal8162!/);
        const created = await readCredential(user);
        assert.equal(created.password_hash, originalHash);
        assert.equal(decryptEmployeePassword(created.password_ciphertext, originalHash), originalPassword);
        const session = await createStoredAdminSession(identity(user));

        await updateAccessUser(user.id, { ...input, name: 'Renamed synthetic', password: '' });
        const renamed = await readCredential(user);
        assert.equal(renamed.password_hash, created.password_hash);
        assert.equal(renamed.password_ciphertext, created.password_ciphertext);
        assert.equal(renamed.password_changed_at, created.password_changed_at);
        await assertRevoked(session.sessionId, false);

        const before = await readCredential(user);
        await withRevocationFailure(session.sessionId, async () => {
          await assert.rejects(updateAccessUser(user.id, {
            ...input, name: 'Must roll back', passwordHash: replacementHash, password: replacementPassword,
            dashboardAccess: ['currency-rates'],
          }), /synthetic session revocation failure/);
        });
        assert.deepEqual(await readCredential(user), before);
        assert.deepEqual((await getAccessUsers()).find((item) => item.id === user.id)?.dashboardAccess, []);
        await assertRevoked(session.sessionId, false);

        const updated = await updateAccessUser(user.id, { ...input, passwordHash: replacementHash, password: replacementPassword });
        const row = await readCredential(user);
        assert.equal(row.password_hash, replacementHash);
        assert.equal(decryptEmployeePassword(row.password_ciphertext, row.password_hash), replacementPassword);
        assert.equal(await verifyEmployeePasswordCopy(originalPassword, row.password_hash), false);
        assert.equal(row.display_password, '');
        await assertRevoked(session.sessionId, true);
        assert.doesNotMatch(JSON.stringify(updated), /password_ciphertext|password_hash|SyntheticReplacement/);
      });

      await t.test(`${role}: cross-table move preserves or replaces ciphertext and rolls back on revocation failure`, async () => {
        for (const replace of [false, true]) {
          const input = values(role);
          const user = await createAccessUser({ ...input, passwordHash: originalHash, password: originalPassword });
          const session = await createStoredAdminSession(identity(user));
          const next = { ...input, role: role === 'top' ? 'manager' as const : 'top' as const,
            ...(replace ? { passwordHash: replacementHash, password: replacementPassword } : {}) };
          const before = await readCredential(user);
          await withRevocationFailure(session.sessionId, async () => {
            await assert.rejects(updateAccessUser(user.id, next), /synthetic session revocation failure/);
          });
          assert.deepEqual(await readCredential(user), before);
          assert.equal((await getAccessUsers()).filter((item) => item.login === input.login).length, 1);
          await assertRevoked(session.sessionId, false);

          const moved = await updateAccessUser(user.id, next);
          const row = await readCredential(moved.user);
          assert.notEqual(moved.user.source, user.source);
          assert.equal(row.password_hash, replace ? replacementHash : originalHash);
          assert.equal(decryptEmployeePassword(row.password_ciphertext, row.password_hash), replace ? replacementPassword : originalPassword);
          assert.equal(row.display_password, '');
          // FK cascade removes sessions on a source move; a revoked surviving row is also safe.
          const oldSessions = await query('select id from admin_sessions where id=$1 and revoked_at is null', [session.sessionId]);
          assert.equal(oldSessions.rowCount, 0);
        }
      });
    }

    await t.test('legacy manager writes preserve prices/items, redact lists, and roll back encrypted changes', async () => {
      const input = { ...values('manager'), role: 'manager' as const, phone: '', canAccessTopDashboard: false, revokeSessions: false };
      const id = await createWholesaleManager({ ...input, passwordHash: originalHash, password: originalPassword });
      const user = { source: 'manager' as const, numericId: id };
      const created = await readCredential(user);
      assert.equal(created.display_password, '');
      assert.equal(decryptEmployeePassword(created.password_ciphertext, originalHash), originalPassword);
      const product = await query<{ id: number }>('insert into wholesale_products(title,sku) values($1,$2) returning id', ['Synthetic preserved product', randomUUID()]);
      const price = await query<{ id: number }>('insert into wholesale_price_lists(title,token,manager_id) values($1,$2,$3) returning id', ['Synthetic preserved price', randomUUID(), id]);
      await query('insert into wholesale_price_list_items(price_list_id,wholesale_product_id,custom_wholesale_price) values($1,$2,$3)', [price.rows[0].id, product.rows[0].id, 123.45]);
      const businessState = async () => ({
        price: (await query('select * from wholesale_price_lists where id=$1', [price.rows[0].id])).rows,
        items: (await query('select * from wholesale_price_list_items where price_list_id=$1 order by id', [price.rows[0].id])).rows,
      });
      const businessBefore = await businessState();
      const session = await createStoredAdminSession({ role: 'manager', managerId: id });
      await withRevocationFailure(session.sessionId, async () => {
        await assert.rejects(updateWholesaleManager(id, { ...input, passwordHash: replacementHash, password: replacementPassword }), /synthetic session revocation failure/);
      });
      assert.deepEqual(await readCredential(user), created);
      await assertRevoked(session.sessionId, false);
      await updateWholesaleManager(id, { ...input, passwordHash: replacementHash, password: replacementPassword });
      const changed = await readCredential(user);
      assert.equal(changed.password_hash, replacementHash);
      assert.equal(decryptEmployeePassword(changed.password_ciphertext, changed.password_hash), replacementPassword);
      await assertRevoked(session.sessionId, true);

      await updateWholesaleManager(id, { ...input, name: 'Legacy renamed', password: '' });
      assert.equal((await readCredential(user)).password_ciphertext, changed.password_ciphertext);
      await updateAccessUser(`manager:${id}`, { ...input, password: '', name: 'Central renamed' });
      assert.equal((await readCredential(user)).password_hash, replacementHash);
      assert.deepEqual(await businessState(), businessBefore);
      await assert.rejects(updateAccessUser(`manager:${id}`, { ...input, role: 'top' }), /прайсы/);
      assert.deepEqual(await businessState(), businessBefore);
      assert.ok((await getWholesaleManagers()).every((manager) => manager.displayPassword === ''));
      assert.doesNotMatch(JSON.stringify(await getWholesaleManagers()), /password_ciphertext|password_hash|SyntheticOriginal|SyntheticReplacement/);
    });

    await t.test('missing/stale copies never reset hashes or re-expose an obsolete password', async () => {
      for (const legacyPassword of ['', 'SyntheticStale123!', originalPassword]) {
        const input = values('manager');
        const user = await createAccessUser({ ...input, passwordHash: originalHash });
        await query('update wholesale_managers set display_password=$2 where id=$1', [user.numericId, legacyPassword]);
        await updateAccessUser(user.id, input);
        const row = await readCredential(user);
        assert.equal(row.password_hash, originalHash);
        assert.equal(row.display_password, '');
        assert.equal(decryptEmployeePassword(row.password_ciphertext, row.password_hash), legacyPassword === originalPassword ? originalPassword : null);
      }
      const input = values('top');
      const user = await createAccessUser({ ...input, passwordHash: originalHash });
      await updateAccessUser(user.id, input);
      assert.equal((await readCredential(user)).password_ciphertext, null);
      assert.equal((await readCredential(user)).password_hash, originalHash);
    });

    await t.test('legacy-copy migration preserves exact login hashes, rejects stale copies and is idempotent', async () => {
      const fixtures: Array<{ user: AccessUser; expected: string | null }> = [];
      for (const legacyPassword of [originalPassword, 'SyntheticStaleMigration123!', '']) {
        const user = await createAccessUser({ ...values('manager'), passwordHash: originalHash });
        await query('update wholesale_managers set display_password=$2 where id=$1', [user.numericId, legacyPassword]);
        fixtures.push({ user, expected: legacyPassword === originalPassword ? originalPassword : null });
      }
      const currentCopyUser = await createAccessUser({ ...values('manager'), passwordHash: replacementHash, password: replacementPassword });
      await query('update wholesale_managers set display_password=$2 where id=$1', [currentCopyUser.numericId, originalPassword]);
      fixtures.push({ user: currentCopyUser, expected: replacementPassword });
      const missingAdminCopy = await createAccessUser({ ...values('top'), passwordHash: originalHash });
      fixtures.push({ user: missingAdminCopy, expected: null });
      const before = await Promise.all(fixtures.map(({ user }) => readCredential(user)));
      const allLoginHashes = async () => (await query(`
        select 'admin' as source, id::text, password_hash from admin_users
        union all select 'manager' as source, id::text, password_hash from wholesale_managers
        order by source, id`)).rows;
      const hashesBefore = await allLoginHashes();

      await withTransaction(applyEmployeePasswordMigration);
      assert.deepEqual(await allLoginHashes(), hashesBefore, 'migration must preserve every exact salted login hash');
      const migrated = await Promise.all(fixtures.map(({ user }) => readCredential(user)));
      for (let index = 0; index < fixtures.length; index++) {
        const row = migrated[index];
        assert.equal(row.password_hash, before[index].password_hash);
        assert.equal(row.password_changed_at, before[index].password_changed_at);
        assert.equal(row.display_password, '');
        assert.equal(decryptEmployeePassword(row.password_ciphertext, row.password_hash), fixtures[index].expected);
        if (fixtures[index].expected === null) assert.equal(row.password_ciphertext, null);
      }
      assert.equal(migrated[3].password_ciphertext, before[3].password_ciphertext, 'a current server copy must survive stale legacy plaintext');
      await withTransaction(applyEmployeePasswordMigration);
      assert.deepEqual(await allLoginHashes(), hashesBefore);
      assert.deepEqual(await Promise.all(fixtures.map(({ user }) => readCredential(user))), migrated, 'repeat migration must not reseal or mutate existing copies');
    });

    await t.test('browser candidate recovery verifies the current hash and never replaces a newer server copy', async () => {
      for (const role of ['top', 'manager'] as const) {
        const input = values(role);
        const user = await createAccessUser({ ...input, passwordHash: originalHash });
        const target = { source: user.source, id: user.numericId };
        const before = await readCredential(user);
        const session = await createStoredAdminSession(identity(user));
        assert.deepEqual(await readEmployeePassword(target), { password: null });
        assert.deepEqual(await readEmployeePassword(target, 'SyntheticStaleBrowser123!'), { password: null });
        assert.deepEqual(await readCredential(user), before, 'rejected candidate must not write any account field');

        assert.deepEqual(await readEmployeePassword(target, originalPassword), { password: originalPassword });
        const recovered = await readCredential(user);
        assert.equal(recovered.password_hash, before.password_hash);
        assert.equal(recovered.password_changed_at, before.password_changed_at);
        assert.equal(recovered.display_password, '');
        assert.equal(decryptEmployeePassword(recovered.password_ciphertext, recovered.password_hash), originalPassword);
        await assertRevoked(session.sessionId, false);
        assert.deepEqual(await readEmployeePassword(target, originalPassword), { password: originalPassword });
        assert.deepEqual(await readCredential(user), recovered, 'matching candidate must not reseal a usable server copy');

        await updateAccessUser(user.id, { ...input, passwordHash: replacementHash, password: replacementPassword });
        const newer = await readCredential(user);
        assert.deepEqual(await readEmployeePassword(target, originalPassword), { password: replacementPassword });
        assert.deepEqual(await readCredential(user), newer, 'old browser cache must never overwrite the newer server copy');
        assert.equal(await verifyEmployeePasswordCopy(originalPassword, newer.password_hash), false);
      }
    });

    await t.test('encryption failure rolls back migration and candidate recovery without losing login hashes or copies', async () => {
      const legacy = await createAccessUser({ ...values('manager'), passwordHash: originalHash });
      await query('update wholesale_managers set display_password=$2 where id=$1', [legacy.numericId, originalPassword]);
      const current = await createAccessUser({ ...values('top'), passwordHash: replacementHash, password: replacementPassword });
      const candidates = await Promise.all((['top', 'manager'] as const).map((role) => createAccessUser({ ...values(role), passwordHash: originalHash })));
      const beforeLegacy = await readCredential(legacy);
      const beforeCurrent = await readCredential(current);
      const beforeCandidates = await Promise.all(candidates.map(readCredential));
      const previousKey = process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY;
      try {
        process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = 'synthetic-invalid-key';
        await assert.rejects(withTransaction(async (client) => {
          // A preceding write proves the enclosing migration transaction actually rolls back.
          await client.query('update admin_users set password_ciphertext=$2 where id=$1', [current.numericId, 'synthetic-transient-copy']);
          await applyEmployeePasswordMigration(client);
        }), /32-byte key/);
        assert.deepEqual(await readCredential(legacy), beforeLegacy);
        assert.deepEqual(await readCredential(current), beforeCurrent);
        for (let index = 0; index < candidates.length; index++) {
          const user = candidates[index];
          await assert.rejects(readEmployeePassword({ source: user.source, id: user.numericId }, originalPassword), /32-byte key/);
          assert.deepEqual(await readCredential(user), beforeCandidates[index]);
        }
      } finally {
        if (previousKey === undefined) delete process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY;
        else process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = previousKey;
      }
      assert.equal(decryptEmployeePassword(beforeCurrent.password_ciphertext, beforeCurrent.password_hash), replacementPassword);
      // Leave no intentionally unencrypted fixture behind after the rollback assertions.
      await withTransaction(applyEmployeePasswordMigration);
      assert.equal((await readCredential(legacy)).password_hash, originalHash);
      assert.equal((await readCredential(legacy)).display_password, '');
    });
  } finally {
    await (globalThis as typeof globalThis & { __ktsPgPool?: { end(): Promise<void> } }).__ktsPgPool?.end();
  }
});
