import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as management from '../src/shared/lib/accessUserManagement';
import * as dashboardAccess from '../src/shared/lib/dashboardAccess';
import { hashEmployeePassword } from '../src/shared/lib/employeePasswordHash';
import * as vault from '../src/shared/lib/employeePasswordVault';
import * as identifierConflicts from '../src/shared/lib/employeeIdentifierConflict';
import * as versions from '../src/shared/lib/recordVersion';

type CentralRepo = typeof import('../src/shared/lib/db/adminUsersRepo');
type ManagerRepo = typeof import('../src/shared/lib/db/wholesaleAdminRepo/managerRepo');
type SessionRepo = typeof import('../src/shared/lib/db/adminSessionsRepo');
type Source = 'admin' | 'manager';
type Row = {
  revision: string;
  source: Source; id: string; name: string; login: string; email: string; phone: string; role: string;
  is_active: boolean; can_manage_top_dashboard: boolean; can_access_top_dashboard: boolean;
  price_list_count: string; support_manager_id: null; support_manager_name: string;
  created_at: string; updated_at: string; password_changed_at: string;
  password_hash: string; password_ciphertext: string | null; display_password: string;
  grants: string[];
};

// Synthetic key and credentials only. Each Node test file runs in its own process.
process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString('base64');
const oldPassword = 'SyntheticOld123!';
const newPassword = 'SyntheticNew456!';
function syntheticHash(password: string, saltByte: number) {
  const salt = Buffer.alloc(16, saltByte).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
const oldHash = syntheticHash(oldPassword, 1);
const newHash = syntheticHash(newPassword, 2);

function load<T>(path: string, dependencies: Record<string, unknown>): T {
  const code = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} as T };
  new Function('require', 'module', 'exports', code)((key: string) => {
    assert.ok(key in dependencies, `Unexpected dependency ${key}`);
    return dependencies[key];
  }, loaded, loaded.exports);
  return loaded.exports;
}

function harness(source: Source = 'manager', overrides: Partial<Row> = {}) {
  const original: Row = {
    revision: '1',
    source, id: '42', name: 'Synthetic', login: 'synthetic', email: '', phone: '',
    role: source === 'admin' ? 'top' : 'manager', is_active: true,
    can_manage_top_dashboard: false, can_access_top_dashboard: false,
    price_list_count: '0', support_manager_id: null, support_manager_name: '',
    created_at: '2026-01-01', updated_at: '2026-01-01', password_changed_at: '2026-01-01',
    password_hash: oldHash, password_ciphertext: vault.encryptEmployeePassword(oldPassword, oldHash),
    display_password: source === 'manager' ? oldPassword : '', grants: [], ...overrides,
  };
  const state = { rows: [structuredClone(original)], revoked: [] as string[] };
  const control = { failRevoke: false, failGrants: false, commits: 0, rollbacks: 0 };
  const events: string[] = [];
  let inTransaction = false;
  const current = (kind: Source, id: unknown) => state.rows.find((row) => row.source === kind && row.id === String(id));
  const result = (row?: Row) => ({ rows: row ? [structuredClone(row)] : [] });
  const client = { query: async (rawSql: string, args: unknown[] = []) => {
    const sql = rawSql.replace(/\s+/g, ' ').trim();
    if (/^(update|insert|delete|with created)/.test(sql)) assert.equal(inTransaction, true, 'every write must use the transaction client');
    if (sql.includes('pg_advisory_xact_lock') || sql.includes('where login = $1')) return { rows: [] };
    if (sql.includes('count(*)::text as count')) return { rows: [{ count: '2' }] };
    if (sql.startsWith('select id from wholesale_managers')) return result(current('manager', args[0]));
    if (sql.startsWith('select') && sql.includes('from admin_users') && sql.includes('for update')) return result(current('admin', args[0]));
    if (sql.startsWith('select') && sql.includes('from wholesale_managers wm')) return result(current('manager', args[0]));
    if (sql.startsWith('select password_hash')) return result(current('manager', args[0]));
    if (sql.startsWith('select') && sql.includes('from wholesale_managers m ')) {
      assert.doesNotMatch(sql, /password_hash|password_ciphertext|display_password/);
      return { rows: state.rows.filter((row) => row.source === 'manager').map((row) => structuredClone(row)) };
    }
    if (sql.startsWith('update admin_sessions')) {
      events.push('revoke');
      if (control.failRevoke) throw new Error('synthetic revocation failure');
      state.revoked.push(`${sql.includes('where admin_user_id') ? 'admin' : 'manager'}:${args[0]}`);
      return { rows: [] };
    }
    if (sql.startsWith('insert into') || sql.startsWith('with created')) {
      const legacy = sql.startsWith('with created');
      const destination: Source = sql.includes('insert into wholesale_managers') ? 'manager' : 'admin';
      const move = sql.includes('coalesce($6::text, password_hash)');
      const old = move ? current(destination === 'admin' ? 'manager' : 'admin', args[7]) : undefined;
      const row = structuredClone(old ?? original);
      row.revision = '1';
      row.source = destination; row.id = '43'; row.name = String(args[0]); row.login = String(args[1]); row.email = String(args[2]);
      row.role = String(args[legacy ? 4 : 3]);
      row.password_hash = String(args[legacy ? 8 : 5] ?? old?.password_hash);
      row.password_ciphertext = args[legacy ? 9 : move ? 8 : 7] as string | null;
      row.display_password = ''; row.grants = [];
      row.is_active = Boolean(args[legacy ? 10 : 6]);
      if (args[legacy ? 8 : 5] !== null) row.password_changed_at = '2026-10-12';
      state.rows.push(row); events.push('insert');
      return result(row);
    }
    if (sql.startsWith('update admin_users') || sql.startsWith('update wholesale_managers')) {
      const destination: Source = sql.startsWith('update admin_users') ? 'admin' : 'manager';
      const row = current(destination, args[0]); assert.ok(row);
      row.revision = String(BigInt(row.revision) + BigInt(1));
      if (sql.includes('set updated_at = clock_timestamp()')) { events.push('touch'); return result(row); }
      const legacy = sql.includes('phone = $5');
      const hashIndex = destination === 'admin' ? 6 : legacy ? 5 : 4;
      assert.match(sql, /password_hash = case when \$\d+::text is null then password_hash else \$\d+ end/);
      assert.match(sql, /password_ciphertext = \$9/);
      row.name = String(args[1]); row.login = String(args[2]); row.email = String(args[3]);
      if (args[hashIndex] !== null) { row.password_hash = String(args[hashIndex]); row.password_changed_at = '2026-10-12'; }
      row.password_ciphertext = args[8] as string | null;
      row.is_active = Boolean(args[destination === 'admin' ? 7 : legacy ? 6 : 5]);
      if (destination === 'manager') {
        assert.match(sql, /display_password = ''/); row.display_password = '';
        if (!legacy) row.role = String(args[6]);
      } else row.role = String(args[4]);
      if (legacy) { row.can_access_top_dashboard = Boolean(args[9]); row.can_manage_top_dashboard = Boolean(args[10]); }
      events.push('update'); return result(row);
    }
    if (sql.startsWith('delete from')) {
      const destination: Source = sql.includes('admin_users') ? 'admin' : 'manager';
      assert.ok(state.revoked.includes(`${destination}:${args[0]}`), 'revoke before DELETE loses the foreign key');
      state.rows = state.rows.filter((row) => row.source !== destination || row.id !== String(args[0]));
      events.push('delete'); return { rows: [] };
    }
    throw new Error(`Unhandled synthetic SQL: ${sql}`);
  } };
  const transport = {
    query: client.query,
    withTransaction: async <T>(work: (db: typeof client) => Promise<T>) => {
      assert.equal(inTransaction, false);
      const before = structuredClone(state); inTransaction = true;
      try { const value = await work(client); control.commits++; return value; }
      catch (error) { Object.assign(state, before); control.rollbacks++; throw error; }
      finally { inTransaction = false; }
    },
  };
  const schema = { ensureSiteSchema: async () => { assert.equal(inTransaction, false, 'transaction revocation must not initialize schema via another connection'); } };
  const sessions = load<SessionRepo>('src/shared/lib/db/adminSessionsRepo.ts', {
    crypto, '../securityHash': {}, '../dashboardAccess': dashboardAccess, './client': transport, './schema': schema,
    './loginCredentialsRepo': { lockVerifiedLoginCredential: async () => { throw new Error('Login verification is not used for credential writes'); } },
  });
  const central = load<CentralRepo>('src/shared/lib/db/adminUsersRepo.ts', {
    '../dashboardAccess': dashboardAccess, '../accessUserManagement': management, '../employeePasswordVault': vault,
    '../recordVersion': versions,
    '../employeeIdentifierConflict': identifierConflicts,
    './adminSessionsRepo': sessions, './client': transport, './schema': schema,
    './dashboardAccessRepo': {
      DASHBOARD_ACCESS_LOCK: 'synthetic-lock', dashboardAccessVersion: (keys: string[]) => JSON.stringify(keys),
      getDashboardGrants: async (_client: unknown, kind: Source, id: number) => [...current(kind, id)!.grants],
      saveDashboardGrants: async (_client: unknown, user: { source: Source; numericId: number }, keys: string[] = []) => {
        if (control.failGrants) throw new Error('synthetic grant failure');
        const row = current(user.source, user.numericId)!; row.grants = [...keys]; return [...keys];
      },
    },
  });
  const managers = load<ManagerRepo>('src/shared/lib/db/wholesaleAdminRepo/managerRepo.ts', {
    '../client': transport, '../schema': schema, '../adminSessionsRepo': sessions, '../../employeePasswordVault': vault,
    '../../recordVersion': versions,
    '../../employeeIdentifierConflict': identifierConflicts,
    './managerHelpers': { normalizeLogin: (login: string) => login.trim().toLowerCase(), normalizeManagerRole: (role?: string) => role || 'manager', normalizeWholesaleSupportManagerId: async () => null },
  });
  const input = { name: original.name, login: original.login, email: original.email, role: original.role as 'top' | 'manager',
    expectedRevision: original.revision,
    isActive: original.is_active, canManageTopDashboard: original.can_manage_top_dashboard, supportManagerId: null };
  const legacyInput = { ...input, phone: '', canAccessTopDashboard: false, revokeSessions: false };
  return { central, managers, state, control, events, input, legacyInput, original };
}

test('asynchronous employee hashes retain exact legacy login compatibility', async () => {
  const hash = await hashEmployeePassword(newPassword);
  assert.match(hash, /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/);
  const [, salt, expected] = hash.split(':');
  assert.equal(crypto.scryptSync(newPassword, salt, 64).toString('hex'), expected);
  assert.equal(await vault.verifyEmployeePasswordCopy(newPassword, hash), true);
});

for (const source of ['admin', 'manager'] as const) {
  test(`${source}: password, encrypted copy and session revocation commit together`, async () => {
    const h = harness(source);
    const saved = await h.central.updateAccessUser(`${source}:42`, { ...h.input, passwordHash: newHash, password: newPassword });
    const row = h.state.rows[0];
    assert.equal(row.password_hash, newHash);
    assert.equal(vault.decryptEmployeePassword(row.password_ciphertext, row.password_hash), newPassword);
    assert.equal(row.display_password, '');
    assert.deepEqual(h.state.revoked, [`${source}:42`]);
    assert.equal(h.control.commits, 1);
    assert.doesNotMatch(JSON.stringify(saved), /password_hash|password_ciphertext|display_password|SyntheticNew456/);
  });

  test(`${source}: failed revocation rolls password, copy, profile and grants back`, async () => {
    const h = harness(source); h.control.failRevoke = true;
    await assert.rejects(h.central.updateAccessUser(`${source}:42`, { ...h.input, name: 'Changed', passwordHash: newHash, password: newPassword, dashboardAccess: ['currency-rates'] }), /revocation failure/);
    assert.deepEqual(h.state.rows, [h.original]);
    assert.deepEqual(h.state.revoked, []);
    assert.equal(h.control.commits, 0); assert.equal(h.control.rollbacks, 1);
  });

  test(`${source}: omitted/empty password never resets the current hash or copy`, async () => {
    for (const password of [undefined, '']) {
      const h = harness(source);
      await h.central.updateAccessUser(`${source}:42`, { ...h.input, name: 'Renamed', password });
      assert.equal(h.state.rows[0].password_hash, oldHash);
      assert.equal(h.state.rows[0].password_ciphertext, h.original.password_ciphertext);
      assert.equal(h.state.rows[0].password_changed_at, h.original.password_changed_at);
      assert.deepEqual(h.state.revoked, []);
    }
  });

  test(`${source}: source move preserves or replaces the exact credential and revokes before deletion`, async () => {
    for (const replace of [false, true]) {
      const h = harness(source);
      const saved = await h.central.updateAccessUser(`${source}:42`, { ...h.input, role: source === 'admin' ? 'manager' : 'top',
        ...(replace ? { password: newPassword, passwordHash: newHash } : {}) });
      const row = h.state.rows[0];
      assert.equal(row.password_hash, replace ? newHash : oldHash);
      assert.equal(vault.decryptEmployeePassword(row.password_ciphertext, row.password_hash), replace ? newPassword : oldPassword);
      assert.equal(saved.user.source, source === 'admin' ? 'manager' : 'admin');
      assert.ok(h.events.indexOf('revoke') < h.events.indexOf('delete'));
      assert.equal(h.control.commits, 1);
    }
  });

  test(`${source}: source move rolls inserted account back when revocation fails`, async () => {
    const h = harness(source); h.control.failRevoke = true;
    await assert.rejects(h.central.updateAccessUser(`${source}:42`, { ...h.input, role: source === 'admin' ? 'manager' : 'top' }), /revocation failure/);
    assert.deepEqual(h.state.rows, [h.original]); assert.equal(h.control.commits, 0);
  });

  test(`${source}: create encrypts without exposing the password in the DTO`, async () => {
    const h = harness(source);
    const created = await h.central.createAccessUser({ ...h.input, passwordHash: newHash, password: newPassword });
    const row = h.state.rows.find((item) => item.id === String(created.numericId))!;
    assert.equal(vault.decryptEmployeePassword(row.password_ciphertext, row.password_hash), newPassword);
    assert.equal(row.display_password, '');
    assert.doesNotMatch(JSON.stringify(created), /password|scrypt|SyntheticNew456/i);
  });
}

test('manager legacy plaintext is promoted only if it matches the current hash', async () => {
  for (const legacy of [oldPassword, 'SyntheticStaleCopy']) {
    const h = harness('manager', { password_ciphertext: null, display_password: legacy });
    await h.central.updateAccessUser('manager:42', h.input);
    assert.equal(h.state.rows[0].password_hash, oldHash);
    assert.equal(h.state.rows[0].display_password, '');
    assert.equal(vault.decryptEmployeePassword(h.state.rows[0].password_ciphertext, oldHash), legacy === oldPassword ? oldPassword : null);
  }
});

test('delegated dashboard edits revoke atomically but cannot mutate protected profile or password', async () => {
  const h = harness('manager');
  await h.central.updateAccessUser('manager:42', { ...h.input, dashboardAccess: ['currency-rates'] }, null, 'admintop');
  assert.deepEqual(h.state.revoked, ['manager:42']);
  assert.equal(h.state.rows[0].password_hash, oldHash);
  assert.equal(h.state.rows[0].password_ciphertext, h.original.password_ciphertext);
  for (const change of [{ passwordHash: newHash, password: newPassword }, { name: 'Forbidden' }, { role: 'admin' as const }]) {
    await assert.rejects(h.central.updateAccessUser('manager:42', { ...h.input, expectedRevision: h.state.rows[0].revision, ...change }, null, 'admintop'), /только|управляет/);
  }
});

test('legacy manager writes encrypt and revoke in one transaction; failure restores the credential', async () => {
  const h = harness();
  await h.managers.updateWholesaleManager(42, { ...h.legacyInput, passwordHash: newHash, password: newPassword });
  assert.equal(vault.decryptEmployeePassword(h.state.rows[0].password_ciphertext, newHash), newPassword);
  assert.equal(h.state.rows[0].display_password, '');
  assert.deepEqual(h.state.revoked, ['manager:42'], 'password changes revoke even when stale caller flag is false');
  const failed = harness(); failed.control.failRevoke = true;
  await assert.rejects(failed.managers.updateWholesaleManager(42, { ...failed.legacyInput, passwordHash: newHash, password: newPassword }), /revocation failure/);
  assert.deepEqual(failed.state.rows, [failed.original]); assert.equal(failed.control.commits, 0);
});

test('legacy manager create stores only ciphertext; lists never reveal legacy plaintext', async () => {
  const h = harness();
  const id = await h.managers.createWholesaleManager({ ...h.legacyInput, role: 'manager', passwordHash: newHash, password: newPassword });
  const row = h.state.rows.find((item) => item.id === String(id))!;
  assert.equal(row.display_password, '');
  assert.equal(vault.decryptEmployeePassword(row.password_ciphertext, row.password_hash), newPassword);
  const listed = await h.managers.getWholesaleManagers();
  assert.ok(listed.every((manager) => manager.displayPassword === ''));
  assert.doesNotMatch(JSON.stringify(listed), /SyntheticOld123|SyntheticNew456|password_hash|password_ciphertext/);
});

for (const source of ['admin', 'manager'] as const) {
  test(`${source}: stale profile cannot reactivate an account, change its password or move its role`, async () => {
    const h = harness(source);
    const disabled = await h.central.updateAccessUser(`${source}:42`, { ...h.input, isActive: false });
    assert.equal(disabled.user.revision, '2');
    const snapshot = structuredClone(h.state);
    const previousEvents = [...h.events];
    for (const expectedRevision of [undefined, '', '0', '1', '999']) {
      await assert.rejects(h.central.updateAccessUser(`${source}:42`, {
        ...h.input, expectedRevision, name: 'Stale edit', isActive: true,
        passwordHash: newHash, password: newPassword,
        role: source === 'admin' ? 'manager' : 'top',
      }), versions.RecordVersionConflictError);
      assert.deepEqual(h.state, snapshot, 'no credentials, grants, profile or session side effects');
      assert.deepEqual(h.events, previousEvents, 'conflict detected before any write');
    }
    const fresh = await h.central.updateAccessUser(`${source}:42`, {
      ...h.input, expectedRevision: disabled.user.revision, isActive: false, name: 'Fresh edit',
    });
    assert.equal(fresh.user.revision, '3');
    assert.equal(fresh.user.isActive, false);
  });
}

test('legacy and central manager editors share one revision, including delegated access-only edits', async () => {
  const h = harness();
  const legacy = await h.managers.updateWholesaleManager(42, { ...h.legacyInput, isActive: false });
  assert.equal(legacy.revision, '2');
  await assert.rejects(h.central.updateAccessUser('manager:42', h.input), versions.RecordVersionConflictError);
  const delegated = await h.central.updateAccessUser('manager:42', {
    ...h.input, expectedRevision: legacy.revision, isActive: false, dashboardAccess: ['currency-rates'],
  }, null, 'admintop');
  assert.equal(delegated.user.revision, '3');
  const snapshot = structuredClone(h.state);
  await assert.rejects(h.managers.updateWholesaleManager(42, {
    ...h.legacyInput, expectedRevision: legacy.revision, passwordHash: newHash, password: newPassword,
  }), versions.RecordVersionConflictError);
  assert.deepEqual(h.state, snapshot);
  const fresh = await h.managers.updateWholesaleManager(42, {
    ...h.legacyInput, expectedRevision: delegated.user.revision, isActive: false, name: 'Fresh legacy edit',
  });
  assert.equal(fresh.revision, '4');
});
