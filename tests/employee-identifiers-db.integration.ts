import assert from 'node:assert/strict';
import test from 'node:test';
import type { PoolClient } from 'pg';

import { EmployeeIdentifierConflictError } from '../src/shared/lib/employeeIdentifierConflict';
import { hashEmployeePassword } from '../src/shared/lib/employeePasswordHash';
import { createAccessUser, getAccessUsers, getAdminUserByLogin, updateAccessUser } from '../src/shared/lib/db/adminUsersRepo';
import { createStoredAdminSession, getStoredAdminSession } from '../src/shared/lib/db/adminSessionsRepo';
import { query, withTransaction } from '../src/shared/lib/db/client';
import { createClientCompany } from '../src/shared/lib/db/clientCompaniesRepo';
import { applyEmployeeIdentifierMigration } from '../src/shared/lib/db/employeeIdentifierMigration';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { createWholesaleManager, getWholesaleManagerByLogin, updateWholesaleManager } from '../src/shared/lib/db/wholesaleAdminRepo/managerRepo';

function guard() {
  assert.equal(process.env.KTS_EMPLOYEE_IDENTIFIERS_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_employee_identifiers_integration');
  assert.equal(url.username, 'identifier_app');
  assert.equal(url.password, '');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['host', 'port']);
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-employee-identifiers-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55485');
}

let sequence = 0;
const credentials = { password: 'SyntheticUniqueEmployee123!', passwordHash: '' };
function user(role: 'top' | 'manager' = 'top') {
  return { name: 'Synthetic identity', login: `synthetic-identity-${++sequence}`, email: '', role, isActive: true,
    canManageTopDashboard: false, dashboardAccess: [] as string[], ...credentials };
}
function barrier(size: number) {
  let count = 0;
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return async () => { if (++count === size) release(); await promise; };
}
function conflict(error: unknown) {
  return (error as { code?: string }).code === '23505';
}
async function assertRegistryIntegrity() {
  assert.equal((await query(`select count(*)::int as n from (
    select identifier from employee_login_identifiers group by identifier having count(*) > 1
  ) duplicate_aliases`)).rows[0].n, 0);
  assert.equal((await query(`with expected as (
    select distinct kts_employee_identifier(value) as identifier, au.id as admin_user_id, null::bigint as manager_id
      from admin_users au cross join lateral (values(au.login),(au.email)) aliases(value) where kts_employee_identifier(value) <> ''
    union all
    select distinct kts_employee_identifier(value), null::bigint, wm.id
      from wholesale_managers wm cross join lateral (values(wm.login),(wm.email)) aliases(value) where kts_employee_identifier(value) <> ''
  ), differences as (
    (select * from expected except select * from employee_login_identifiers)
    union all
    (select * from employee_login_identifiers except select * from expected)
  ) select count(*)::int as n from differences`)).rows[0].n, 0);
}

test('cross-table employee identifier uniqueness in disposable PostgreSQL', { timeout: 180_000 }, async (t) => {
  guard();
  try {
    assert.equal((await query("select to_regclass('public.admin_users')::text as present")).rows[0].present, null);
    await ensureSiteSchema();
    await withTransaction(applyEmployeeIdentifierMigration);
    credentials.passwordHash = await hashEmployeePassword(credentials.password);

    await t.test('same-account login=email is one alias; existing values are not normalized in place', async () => {
      const created = await createAccessUser({ ...user(), login: 'Self@Example.test', email: ' SELF@example.TEST ' });
      assert.equal((await query('select count(*)::int as n from employee_login_identifiers where admin_user_id=$1', [created.numericId])).rows[0].n, 1);
      assert.equal(created.email, ' SELF@example.TEST ');
      const raw = (await query<{ id: string }>(`insert into wholesale_managers (login,email,name,password_hash)
        values ($1,$2,'Raw preserved',$3) returning id::text`, ['\u00a0MiXeD-Identifier\u3000', '\tALT@example.test\r', credentials.passwordHash])).rows[0];
      const auth = await getWholesaleManagerByLogin(' mixed-IDENTIFIER ');
      assert.equal(auth?.id, Number(raw.id));
      assert.equal(auth?.login, '\u00a0MiXeD-Identifier\u3000');
      assert.equal((await getWholesaleManagerByLogin('\u2002alt@example.TEST\u202f'))?.id, Number(raw.id));
      assert.equal((await getAdminUserByLogin('\tSELF@example.test\n'))?.id, created.numericId);
      assert.equal(await getAdminUserByLogin('\u00a0 \t'), null);
      assert.equal(await getWholesaleManagerByLogin(''), null);
      await assertRegistryIntegrity();
    });

    await t.test('every login/email overlap is blocked within and across sources, including inactive accounts', async () => {
      const owner = await createAccessUser({ ...user(), login: 'reserved-login', email: 'reserved-email@example.test', isActive: false });
      for (const [login, email] of [[' RESERVED-LOGIN ', ''], ['different-login', '\tRESERVED-LOGIN\n'],
        ['\u00a0reserved-EMAIL@example.test\u3000', ''], ['another-login', 'RESERVED-email@example.test']]) {
        for (const role of ['top', 'manager'] as const) {
          await assert.rejects(createAccessUser({ ...user(role), login, email }), EmployeeIdentifierConflictError);
        }
      }
      assert.equal((await query('select is_active from admin_users where id=$1', [owner.numericId])).rows[0].is_active, false);
      const legacyId = await createWholesaleManager({ ...user('manager'), role: 'manager', phone: '' });
      const before = (await query('select row_to_json(w) as row from wholesale_managers w where id=$1', [legacyId])).rows[0].row;
      await assert.rejects(updateWholesaleManager(legacyId, { ...user('manager'), expectedRevision: String(before.revision),
        email: 'reserved-login', phone: '', canAccessTopDashboard: false, revokeSessions: false }), EmployeeIdentifierConflictError);
      assert.deepEqual((await query('select row_to_json(w) as row from wholesale_managers w where id=$1', [legacyId])).rows[0].row, before);
      await assert.rejects(createWholesaleManager({ ...user('manager'), role: 'manager', email: 'reserved-login', phone: '' }), EmployeeIdentifierConflictError);
      await assertRegistryIntegrity();
    });

    await t.test('Unicode case variants use the same database normalization for lookups and uniqueness', async (unicodeTest) => {
      const folded = (await query("select lower('ИВАН') as value")).rows[0].value;
      if (folded !== 'иван') return unicodeTest.skip('This optional locale lacks Unicode case folding; run KTS_TEST_PG_LOCALE=en_US.UTF-8');
      const owner = await createAccessUser({ ...user(), login: 'иван-сотрудник', email: 'ПОЧТА@Пример.РФ' });
      assert.equal((await getAdminUserByLogin('\u00a0ИВАН-СОТРУДНИК\u3000'))?.id, owner.numericId);
      assert.equal((await getAdminUserByLogin('почта@пример.рф'))?.id, owner.numericId);
      await assert.rejects(createAccessUser({ ...user('manager'), login: 'ПОЧТА@ПРИМЕР.РФ' }), EmployeeIdentifierConflictError);
      await assert.rejects(createAccessUser({ ...user('manager'), email: 'ИВАН-СОТРУДНИК' }), EmployeeIdentifierConflictError);
      await assertRegistryIntegrity();
    });

    await t.test('dotted I must not be transformed by JS before the database selects an identity', async (unicodeTest) => {
      const identifier = 'İ-identity@example.test';
      const jsIdentifier = identifier.toLowerCase();
      const dbIdentifier = (await query('select kts_employee_identifier($1) as value', [identifier])).rows[0].value;
      if (dbIdentifier === jsIdentifier) return unicodeTest.skip('Locale does not have the dotted-I JS/SQL difference');
      const first = await createAccessUser({ ...user(), email: identifier });
      const second = await createAccessUser({ ...user('manager'), email: jsIdentifier });
      assert.notEqual(first.numericId + ':' + first.source, second.numericId + ':' + second.source);
      assert.equal((await getAdminUserByLogin(identifier))?.id, first.numericId);
      assert.equal(await getWholesaleManagerByLogin(identifier), null, 'raw input must not select the expanded JS identifier');
      assert.equal((await getWholesaleManagerByLogin(jsIdentifier))?.id, second.numericId);
      assert.equal(await getAdminUserByLogin(jsIdentifier), null);
      await assertRegistryIntegrity();
    });

    await t.test('deletion and updates release old aliases but failed updates keep every original field', async () => {
      const a = await createAccessUser({ ...user(), email: 'release-old@example.test' });
      const b = await createAccessUser({ ...user('manager'), email: 'occupied@example.test' });
      const before = (await query('select row_to_json(a) as row from admin_users a where id=$1', [a.numericId])).rows[0].row;
      await assert.rejects(withTransaction(async (client) => {
        await client.query("update admin_users set name='Must rollback', email='OCCUPIED@example.test' where id=$1", [a.numericId]);
      }), conflict);
      assert.deepEqual((await query('select row_to_json(a) as row from admin_users a where id=$1', [a.numericId])).rows[0].row, before);
      await query("update admin_users set email='release-new@example.test' where id=$1", [a.numericId]);
      await createAccessUser({ ...user('manager'), login: 'release-old@example.test' });
      await query('delete from wholesale_managers where id=$1', [b.numericId]);
      await createAccessUser({ ...user(), login: 'occupied@example.test' });
      await assertRegistryIntegrity();
    });

    await t.test('role transfer preserves login/hash, revokes old sessions and moves registry ownership atomically', async () => {
      const input = user();
      const original = await createAccessUser({ ...input, email: 'role-transfer@example.test' });
      const oldHash = (await query('select password_hash from admin_users where id=$1', [original.numericId])).rows[0].password_hash;
      const session = await createStoredAdminSession({ role: 'top', adminUserId: original.numericId });
      const manager = (await updateAccessUser(original.id, { ...input, email: original.email, expectedRevision: original.revision,
        role: 'manager', password: undefined, passwordHash: undefined })).user;
      assert.equal(manager.login, original.login);
      assert.equal((await query('select password_hash from wholesale_managers where id=$1', [manager.numericId])).rows[0].password_hash, oldHash);
      assert.equal((await query('select count(*)::int as n from employee_login_identifiers where admin_user_id=$1', [original.numericId])).rows[0].n, 0);
      assert.equal((await query('select count(*)::int as n from employee_login_identifiers where manager_id=$1', [manager.numericId])).rows[0].n, 2);
      const oldSession = (await query('select revoked_at,admin_user_id,manager_id from admin_sessions where id=$1', [session.sessionId])).rows[0];
      assert.equal(oldSession, undefined); // Existing FK cascade removes the old principal's session.
      assert.equal(await getStoredAdminSession(session.token), null);
      const back = (await updateAccessUser(manager.id, { ...input, email: original.email, expectedRevision: manager.revision,
        password: undefined, passwordHash: undefined })).user;
      assert.equal((await getAdminUserByLogin(original.email))?.id, back.numericId);
      assert.equal(await getWholesaleManagerByLogin(original.email), null);
      await assertRegistryIntegrity();
    });

    await t.test('simultaneous cross-table inserts cannot both commit one canonical alias', async () => {
      const ready = barrier(2);
      const outcomes = await Promise.allSettled([
        withTransaction(async (client) => { await client.query("insert into admin_users(login,email) values ('concurrent-admin','shared-concurrent@example.test')"); await ready(); }),
        withTransaction(async (client) => { await client.query("insert into wholesale_managers(login,email) values ('concurrent-manager',E'\\tSHARED-concurrent@example.test\\n')"); await ready(); }),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      const failure = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      assert.ok(['23505', '40P01'].includes(failure.reason.code), failure.reason.code);
      assert.equal((await query("select count(*)::int as n from employee_login_identifiers where identifier='shared-concurrent@example.test'")).rows[0].n, 1);
      await assertRegistryIntegrity();
    });

    await t.test('concurrent cross-table alias swaps cannot partially change either account; one-transaction swap works', async () => {
      const a = await createAccessUser({ ...user(), email: 'swap-a@example.test' });
      const b = await createAccessUser({ ...user('manager'), email: 'swap-b@example.test' });
      const ready = barrier(2);
      const outcomes = await Promise.allSettled([
        withTransaction(async (client) => { await client.query("update admin_users set email='swap-b@example.test' where id=$1", [a.numericId]); await ready(); }),
        withTransaction(async (client) => { await client.query("update wholesale_managers set email='swap-a@example.test' where id=$1", [b.numericId]); await ready(); }),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 0);
      assert.equal((await query('select email from admin_users where id=$1', [a.numericId])).rows[0].email, a.email);
      assert.equal((await query('select email from wholesale_managers where id=$1', [b.numericId])).rows[0].email, b.email);
      await withTransaction(async (client) => {
        await client.query("update admin_users set email='swap-b@example.test' where id=$1", [a.numericId]);
        await client.query("update wholesale_managers set email='swap-a@example.test' where id=$1", [b.numericId]);
      });
      await assertRegistryIntegrity();
    });

    await t.test('client portal remains a separate namespace', async () => {
      const email = 'separate-client@example.test';
      await createAccessUser({ ...user(), email });
      const client = await createClientCompany({ title: 'Synthetic separate client', inn: '', kpp: '', contactName: '', email,
        phone: '', address: '', note: '', managerId: null, supportManagerId: null, isActive: true, requireTwoFactor: false,
        passwordHash: credentials.passwordHash, displayPassword: credentials.password }, { role: 'admin' });
      assert.ok(client.clientUserId);
      await assertRegistryIntegrity();
    });

    await t.test('existing conflicting legacy accounts abort migration without identifiers or any data mutation', async () => {
      const rollback = new Error('rollback synthetic legacy schema');
      await assert.rejects(withTransaction(async (client: PoolClient) => {
        await client.query('create schema synthetic_legacy_identifiers');
        await client.query('set local search_path=synthetic_legacy_identifiers,public');
        await client.query(`create table admin_users(id bigint primary key, login text, email text, password_hash text);
          create table wholesale_managers(id bigint primary key, login text, email text, password_hash text);
          insert into admin_users values(1,' LegacySecretIdentifier ','','unchanged-admin-hash');
          insert into wholesale_managers values(2,'Other','legacysecretidentifier','unchanged-manager-hash')`);
        const readState = async () => (await client.query(`select
          (select json_agg(a) from admin_users a) admins,
          (select json_agg(m) from wholesale_managers m) managers`)).rows[0];
        const before = await readState();
        await assert.rejects(applyEmployeeIdentifierMigration(client), (error: unknown) => {
          assert.match((error as Error).message, /Миграция остановлена без изменения/);
          assert.doesNotMatch((error as Error).message, /LegacySecretIdentifier|legacysecretidentifier|unchanged/);
          return true;
        });
        assert.deepEqual(await readState(), before);
        assert.equal((await client.query("select to_regclass('synthetic_legacy_identifiers.employee_login_identifiers') present")).rows[0].present, null);
        throw rollback;
      }), (error) => error === rollback);
    });

    await t.test('replaying migration preserves every account field and rebuilds an identical registry', async () => {
      const beforeUsers = await getAccessUsers();
      const before = (await query(`select (select json_agg(a order by id) from admin_users a) admins,
        (select json_agg(m order by id) from wholesale_managers m) managers`)).rows[0];
      await withTransaction(applyEmployeeIdentifierMigration);
      assert.deepEqual((await query(`select (select json_agg(a order by id) from admin_users a) admins,
        (select json_agg(m order by id) from wholesale_managers m) managers`)).rows[0], before);
      assert.deepEqual(await getAccessUsers(), beforeUsers);
      await assertRegistryIntegrity();
    });
  } finally {
    await (globalThis as typeof globalThis & { __ktsPgPool?: { end(): Promise<void> } }).__ktsPgPool?.end();
  }
});
