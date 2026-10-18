/** Real concurrent transactions, synthetic records, isolated socket only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { environmentLoginCredentialProof, loginCredentialProof, LoginCredentialsChangedError } from '../src/shared/lib/loginCredentialProof';
import { query, withTransaction } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { applyLoginCredentialMigration } from '../src/shared/lib/db/loginCredentialMigration';
import { createVerifiedStoredAdminSession, getStoredAdminSession } from '../src/shared/lib/db/adminSessionsRepo';
import { createVerifiedStoredClientSession, getStoredClientSession } from '../src/shared/lib/db/clientSessionsRepo';
import { createTwoFactorChallenge, consumeTwoFactorChallenge } from '../src/shared/lib/db/twoFactorRepo';
import { updateClientUserPassword } from '../src/shared/lib/db/clientCompaniesRepo';
import { hashEmployeePassword } from '../src/shared/lib/employeePasswordHash';
import { hashSensitiveValue } from '../src/shared/lib/securityHash';

function guard() {
  assert.equal(process.env.KTS_LOGIN_CREDENTIALS_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_login_credentials_integration');
  assert.equal(url.username, 'login_app');
  assert.equal(url.password, '');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-login-credentials-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55487');
  return url.toString();
}

type Kind = 'admin' | 'manager' | 'client';
type Fixture = { kind: Kind; id: number; companyId?: number; role: 'admin' | 'manager' | 'client'; login: string; email: string; proof: string };
const table = { admin: 'admin_users', manager: 'wholesale_managers', client: 'client_users' } as const;

async function snapshot(f: Omit<Fixture, 'proof'>): Promise<Fixture> {
  const row = (await query<{ password_hash: string; password_changed_at: string | null }>(
    `select password_hash, password_changed_at::text from ${table[f.kind]} where id=$1`, [f.id],
  )).rows[0];
  return { ...f, proof: loginCredentialProof(f.kind, f.role, { id: f.id, login: f.login, email: f.email,
    passwordHash: row.password_hash, passwordChangedAt: row.password_changed_at }) };
}

function issue(f: Fixture, proof = f.proof) {
  return f.kind === 'client' ? createVerifiedStoredClientSession({ clientUserId: f.id, credentialProof: proof })
    : createVerifiedStoredAdminSession({ role: f.role as 'admin' | 'manager', ...(f.kind === 'admin' ? { adminUserId: f.id } : { managerId: f.id }), credentialProof: proof });
}

function challenge(f: Fixture, loginSessionId = randomUUID()) {
  return createTwoFactorChallenge({ login: f.login, actorType: f.kind, role: f.role,
    ...(f.kind === 'admin' ? { adminUserId: f.id } : f.kind === 'manager' ? { managerId: f.id } : { clientUserId: f.id }),
    credentialProof: f.proof, code: '123456', loginSessionId }).then((challengeId) => ({ challengeId, loginSessionId, code: '123456' }));
}

test('verified authentication and one-time codes remain atomic under PostgreSQL concurrency', { timeout: 180_000 }, async (t) => {
  const url = guard();
  const observer = new Pool({ connectionString: url, max: 2 });
  let counter = 0;
  const hash = await hashEmployeePassword('SyntheticLoginOriginal317!');
  const nextHash = await hashEmployeePassword('SyntheticLoginReplacement731!');
  async function fixture(kind: Kind): Promise<Fixture> {
    const login = `race-${kind}-${++counter}`;
    const email = `${login}@example.test`;
    const companyId = kind === 'client'
      ? Number((await query("insert into client_companies(title) values('Synthetic race company') returning id::text")).rows[0].id) : undefined;
    const id = Number((await query(`insert into ${table[kind]}(login,email,password_hash${kind === 'client' ? ',company_id' : ',role'})
      values($1,$2,$3,$4) returning id::text`, [login, email, hash, companyId ?? kind])).rows[0].id);
    return snapshot({ kind, id, companyId, role: kind, login, email });
  }
  async function waitForBlocked(sqlPart: string) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const waiting = await observer.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like $1", [`%${sqlPart}%`]);
      if (waiting.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Expected blocked transaction: ${sqlPart}`);
  }
  try {
    await ensureSiteSchema();
    await withTransaction(applyLoginCredentialMigration);
    for (const kind of ['admin', 'manager', 'client'] as const) {
      await t.test(`${kind}: password changed after verification rejects session and challenge without persistence`, async () => {
        const f = await fixture(kind);
        await query(`update ${table[kind]} set password_hash=$2, password_changed_at=clock_timestamp() where id=$1`, [f.id, nextHash]);
        await assert.rejects(issue(f), LoginCredentialsChangedError);
        await assert.rejects(challenge(f), LoginCredentialsChangedError);
        const fresh = await snapshot(f);
        assert.ok((await issue(fresh)).token);
      });

      await t.test(`${kind}: creation blocked behind password mutation rechecks committed credentials`, async () => {
        const f = await fixture(kind);
        const holder = await observer.connect();
        try {
          await holder.query('begin');
          if (kind === 'client') await holder.query('select id from client_companies where id=$1 for update', [f.companyId]);
          await holder.query(`update ${table[kind]} set password_hash=$2, password_changed_at=clock_timestamp() where id=$1`, [f.id, nextHash]);
          const sessionAttempt = issue(f).then(() => false, (error) => error instanceof LoginCredentialsChangedError);
          const challengeAttempt = challenge(f).then(() => false, (error) => error instanceof LoginCredentialsChangedError);
          await waitForBlocked(kind === 'client' ? 'for update of cc' : `from ${table[kind]}`);
          await holder.query('commit');
          assert.equal(await sessionAttempt, true);
          assert.equal(await challengeAttempt, true);
        } finally { await holder.query('rollback'); holder.release(); }
      });

      await t.test(`${kind}: stale code retains original proof and cannot create a new session`, async () => {
        const f = await fixture(kind);
        const code = await challenge(f);
        await query(`update ${table[kind]} set password_hash=$2, password_changed_at=clock_timestamp() where id=$1`, [f.id, nextHash]);
        const actor = await consumeTwoFactorChallenge(code);
        assert.ok(actor);
        assert.equal(actor.credentialProof, f.proof);
        await assert.rejects(issue(f, actor.credentialProof), LoginCredentialsChangedError);
        assert.equal(await consumeTwoFactorChallenge(code), null);
      });

      await t.test(`${kind}: 24 simultaneous correct codes create at most one session`, async () => {
        const f = await fixture(kind);
        const code = await challenge(f);
        const sessions = await Promise.all(Array.from({ length: 24 }, async () => {
          const actor = await consumeTwoFactorChallenge(code);
          return actor ? issue(f, actor.credentialProof) : null;
        }));
        assert.equal(sessions.filter(Boolean).length, 1);
        assert.ok((await query('select consumed_at from admin_2fa_challenges where id=$1', [code.challengeId])).rows[0].consumed_at);
      });

      await t.test(`${kind}: disabled and reassigned identity cannot issue a verified session or code`, async () => {
        const f = await fixture(kind);
        await query(`update ${table[kind]} set is_active=false where id=$1`, [f.id]);
        await assert.rejects(issue(f), LoginCredentialsChangedError);
        await assert.rejects(challenge(f), LoginCredentialsChangedError);
        await query(`update ${table[kind]} set is_active=true, email='changed@example.test' where id=$1`, [f.id]);
        await assert.rejects(issue(f), LoginCredentialsChangedError);
        if (kind !== 'client') {
          await query(`update ${table[kind]} set email=$2, role=$3 where id=$1`, [f.id, f.email, kind === 'admin' ? 'top' : 'support_manager']);
          await assert.rejects(issue(f), LoginCredentialsChangedError);
        } else {
          await query(`update client_users set email=$2 where id=$1`, [f.id, f.email]);
          await query('update client_companies set archived_at=clock_timestamp(), is_active=false where id=$1', [f.companyId]);
          await assert.rejects(issue(f), LoginCredentialsChangedError);
          await assert.rejects(challenge(f), LoginCredentialsChangedError);
        }
      });

      await t.test(`${kind}: session invalidation respects sub-millisecond password timestamp changes`, async () => {
        const f = await fixture(kind);
        const session = await issue(f);
        const sessionsTable = kind === 'client' ? 'client_sessions' : 'admin_sessions';
        await query(`update ${sessionsTable} set created_at='2026-10-01T00:00:00.000100Z' where id=$1`, [session.sessionId]);
        await query(`update ${table[kind]} set password_changed_at='2026-10-01T00:00:00.000200Z' where id=$1`, [f.id]);
        assert.equal(await (kind === 'client' ? getStoredClientSession(session.token) : getStoredAdminSession(session.token)), null);
      });
    }

    await t.test('simultaneous incorrect codes reserve exactly five attempts; later correct code is denied', async () => {
      const f = await fixture('admin');
      const code = await challenge(f);
      assert.equal(await consumeTwoFactorChallenge({ ...code, loginSessionId: randomUUID() }), null);
      const results = await Promise.all(Array.from({ length: 24 }, () => consumeTwoFactorChallenge({ ...code, code: '000000' })));
      assert.ok(results.every((value) => value === null));
      assert.equal((await query('select attempts from admin_2fa_challenges where id=$1', [code.challengeId])).rows[0].attempts, 5);
      assert.equal(await consumeTwoFactorChallenge(code), null);
    });

    await t.test('expiry is rechecked after row lock wait; legacy unbound challenges are not accepted', async () => {
      const code = await challenge(await fixture('admin'));
      await query("update admin_2fa_challenges set expires_at=clock_timestamp()+interval '150 milliseconds' where id=$1", [code.challengeId]);
      const holder = await observer.connect();
      try {
        await holder.query('begin');
        await holder.query('select id from admin_2fa_challenges where id=$1 for update', [code.challengeId]);
        const attempt = consumeTwoFactorChallenge(code);
        await waitForBlocked('from admin_2fa_challenges');
        await new Promise((resolve) => setTimeout(resolve, 180));
        await holder.query('commit');
        assert.equal(await attempt, null);
      } finally { await holder.query('rollback'); holder.release(); }
      const old = await challenge(await fixture('admin'));
      await query('update admin_2fa_challenges set credential_proof=null where id=$1', [old.challengeId]);
      assert.equal(await consumeTwoFactorChallenge(old), null);
    });

    await t.test('environment credential is bound too; wrong/missing proofs do not grant a session', async () => {
      const proof = environmentLoginCredentialProof(process.env.ADMIN_PASSWORD!);
      assert.ok(await createVerifiedStoredAdminSession({ role: 'admin', credentialProof: proof }));
      await assert.rejects(createVerifiedStoredAdminSession({ role: 'admin', credentialProof: environmentLoginCredentialProof('obsolete') }), LoginCredentialsChangedError);
      await assert.rejects(createVerifiedStoredAdminSession({ role: 'wholesale_admin', credentialProof: proof }), LoginCredentialsChangedError);
      await assert.rejects(createVerifiedStoredClientSession({ clientUserId: 1, credentialProof: undefined as unknown as string }), LoginCredentialsChangedError);
    });

    await t.test('client self-service password compare-and-set rejects an overwritten check and binds replacement session', async () => {
      const f = await fixture('client');
      await query('update client_users set password_hash=$2 where id=$1', [f.id, nextHash]);
      await assert.rejects(updateClientUserPassword(f.id, hash, '', hash), LoginCredentialsChangedError);
      assert.equal((await query('select password_hash from client_users where id=$1', [f.id])).rows[0].password_hash, nextHash);
      const proof = await updateClientUserPassword(f.id, hash, '', nextHash);
      assert.ok(await issue(f, proof));
    });

    await t.test('client password change revokes a session created while waiting for the company lock', async () => {
      const f = await fixture('client');
      const token = `synthetic-concurrent-session-${randomUUID()}`;
      const sessionId = randomUUID();
      const holder = await observer.connect();
      try {
        await holder.query('begin');
        await holder.query('select id from client_companies where id=$1 for update', [f.companyId]);
        const replacement = updateClientUserPassword(f.id, nextHash, '', hash);
        await waitForBlocked('for update of cc');
        // An old-credential session commits while password replacement is
        // pending. Its timestamp is later than the replacement tx's BEGIN.
        await holder.query(`insert into client_sessions(id,session_hash,client_user_id,created_at,expires_at)
          values($1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 day')`, [sessionId, hashSensitiveValue(`client-session:${token}`), f.id]);
        await holder.query('commit');
        const proof = await replacement;
        const stored = (await query(`select s.revoked_at, cu.password_changed_at >= s.created_at as changed_after_session
          from client_sessions s join client_users cu on cu.id=s.client_user_id where s.id=$1`, [sessionId])).rows[0];
        assert.ok(stored.revoked_at, 'revocation is part of the committed password replacement');
        assert.equal(stored.changed_after_session, true, 'password timestamp is actual write time, not transaction start');
        assert.equal(await getStoredClientSession(token), null);
        assert.ok(await issue(f, proof));
      } finally { await holder.query('rollback'); holder.release(); }
    });

    await t.test('client revocation failure rolls back password replacement and retains the previous credential', async () => {
      const f = await fixture('client');
      const oldSession = await issue(f);
      await query(`create function reject_synthetic_client_revocation() returns trigger language plpgsql as $$
        begin raise exception 'Synthetic revocation failure'; end $$`);
      try {
        await query(`create trigger synthetic_client_revocation before update of revoked_at on client_sessions
          for each row when (old.client_user_id = ${f.id}) execute function reject_synthetic_client_revocation()`);
        await assert.rejects(updateClientUserPassword(f.id, nextHash, '', hash), /Synthetic revocation failure/);
        const stored = (await query('select password_hash from client_users where id=$1', [f.id])).rows[0];
        assert.equal(stored.password_hash, hash, 'password mutation and session revocation roll back together');
        assert.ok(await getStoredClientSession(oldSession.token));
      } finally {
        await query('drop trigger if exists synthetic_client_revocation on client_sessions');
        await query('drop function reject_synthetic_client_revocation()');
      }
    });
  } finally {
    await observer.end();
    await (globalThis as typeof globalThis & { __ktsPgPool?: { end(): Promise<void> } }).__ktsPgPool?.end();
  }
});
