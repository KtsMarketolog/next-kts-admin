import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as vault from '../src/shared/lib/clientPasswordVault';
import { encryptEmployeePassword, decryptEmployeePassword } from '../src/shared/lib/employeePasswordVault';
import { applyClientPasswordMigration } from '../src/shared/lib/db/clientPasswordMigration';

process.env.ADMIN_SESSION_SECRET = 'synthetic-client-vault-test-secret-not-production';
delete process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY;
const password = 'SyntheticClientOriginal123!';
const salt = 'e'.repeat(32);
const hash = `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const changedHash = `scrypt:${'f'.repeat(32)}:${scryptSync('SyntheticReplacement321!', 'f'.repeat(32), 64).toString('hex')}`;

test('client packets are random, authenticated and separate from employee packets', () => {
  for (const dedicated of [false, true]) {
    if (dedicated) process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = Buffer.alloc(32, 61).toString('base64');
    else delete process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY;
    const first = vault.encryptClientPassword(password, hash);
    assert.notEqual(first, vault.encryptClientPassword(password, hash));
    assert.equal(vault.decryptClientPassword(first, hash), password);
    assert.equal(vault.decryptClientPassword(first, changedHash), null);
    assert.equal(vault.decryptClientPassword(encryptEmployeePassword(password, hash), hash), null);
    assert.equal(decryptEmployeePassword(first, hash), null);
    const parts = first.split('.');
    parts[4] = `${parts[4][0] === 'A' ? 'B' : 'A'}${parts[4].slice(1)}`;
    assert.equal(vault.decryptClientPassword(parts.join('.'), hash), null);
    for (const invalid of ['', 'v2.session.bad.packet', 'x'.repeat(2049)]) assert.equal(vault.decryptClientPassword(invalid, hash), null);
  }
  delete process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY;
});

test('legacy values require the actual login hash and old display copies never override a current copy', async () => {
  const packet = vault.encryptClientPassword(password, hash);
  assert.equal(await vault.resolveClientPasswordCiphertext({ passwordHash: hash, previousCiphertext: packet, legacyPassword: 'stale' }), packet);
  const migrated = await vault.resolveClientPasswordCiphertext({ passwordHash: hash, legacyPassword: password });
  assert.equal(vault.decryptClientPassword(migrated, hash), password);
  assert.equal(await vault.resolveClientPasswordCiphertext({ passwordHash: hash, legacyPassword: 'stale' }), null);
  assert.equal(await vault.resolveClientPasswordCiphertext({ passwordHash: 'invalid', legacyPassword: password }), null);
  assert.equal(await vault.resolveClientPasswordCiphertext({ passwordHash: hash, legacyPassword: 'z'.repeat(201) }), null);
});

test('missing dedicated key fails reveal/migration but permits opaque profile preservation', async () => {
  process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = Buffer.alloc(32, 62).toString('base64');
  const packet = vault.encryptClientPassword(password, hash);
  process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = 'invalid';
  assert.throws(() => vault.encryptClientPassword(password, hash), /32-byte/);
  assert.throws(() => vault.decryptClientPassword(packet, hash), /32-byte/);
  await assert.rejects(vault.resolveClientPasswordCiphertext({ passwordHash: hash, previousCiphertext: packet }), /32-byte/);
  assert.equal(await vault.resolveClientPasswordCiphertext({ passwordHash: hash, previousCiphertext: packet, preserveOpaqueOnKeyFailure: true }), packet);
  await assert.rejects(vault.resolveClientPasswordCiphertext({ passwordHash: hash, previousCiphertext: packet, legacyPassword: password, preserveOpaqueOnKeyFailure: true }), /32-byte/);
  delete process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY;
});

test('migration bounds each batch and clears copies without rewriting authentication or account dates', async () => {
  const rows = Array.from({ length: 53 }, (_, index) => ({ id: String(BigInt('9007199254740993') + BigInt(index)),
    password_hash: hash, password_ciphertext: null as string | null, display_password: index % 2 === 0 ? password : 'stale' }));
  const cursors: string[] = [];
  const client = { query: async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith('alter table')) return { rows: [] };
    if (sql.startsWith('do $$')) {
      assert.match(sql, /check \(display_password = ''\)/);
      assert.match(sql, /validate constraint client_users_display_password_empty/);
      return { rows: [] };
    }
    if (sql.startsWith('select')) {
      assert.match(sql, /order by id limit \$2 for update/);
      assert.equal(args[1], 50);
      cursors.push(String(args[0]));
      return { rows: rows.filter((row) => BigInt(row.id) > BigInt(String(args[0])) && row.display_password).slice(0, Number(args[1])).map((row) => ({ ...row })) };
    }
    assert.equal(sql, "update client_users set password_ciphertext = $2, display_password = '' where id = $1");
    const row = rows.find((item) => item.id === args[0])!;
    row.password_ciphertext = args[1] as string | null;
    row.display_password = '';
    return { rows: [] };
  } };
  await applyClientPasswordMigration(client as never);
  assert.equal(cursors.length, 3);
  rows.forEach((row, index) => {
    assert.equal(row.display_password, '');
    assert.equal(row.password_hash, hash);
    assert.equal(vault.decryptClientPassword(row.password_ciphertext, hash), index % 2 === 0 ? password : null);
  });
  await applyClientPasswordMigration(client as never);
  assert.equal(cursors.at(-1), '0');
});

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const source = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} as T };
  new Function('require', 'module', 'exports', source)((key: string) => {
    assert.ok(key in dependencies, `Unexpected dependency ${key}`);
    return dependencies[key];
  }, loaded, loaded.exports);
  return loaded.exports;
}

test('reveal SQL checks archived state and current operational role scope in the credential query', async () => {
  type Repo = typeof import('../src/shared/lib/db/clientPasswordRepo');
  let calls = 0;
  let result: { id: string; password_hash: string; password_ciphertext: string | null } | null = null;
  const repo = load<Repo>('src/shared/lib/db/clientPasswordRepo.ts', {
    '../clientPasswordVault': vault, './schema': { ensureSiteSchema: async () => {} },
    './client': { query: async (sql: string, args: unknown[]) => {
      calls++;
      assert.match(sql, /cc\.archived_at is null/);
      assert.match(sql, /\$2::text in \('manager', 'support_manager'\) and \(cc\.manager_id = \$3 or cc\.support_manager_id = \$3\)/);
      assert.match(sql, /order by created_at asc, id asc limit 1/);
      assert.deepEqual(args, [18, 'manager', 7]);
      return { rows: result ? [result] : [] };
    } },
  });
  assert.equal(await repo.readClientCompanyPassword(18, { role: 'top', managerId: 7 }), null);
  assert.equal(await repo.readClientCompanyPassword(18, { role: 'manager' }), null);
  assert.equal(await repo.readClientCompanyPassword(-1, { role: 'admin' }), null);
  assert.equal(calls, 0);
  assert.equal(await repo.readClientCompanyPassword(18, { role: 'manager', managerId: 7 }), null);
  result = { id: '26', password_hash: hash, password_ciphertext: vault.encryptClientPassword(password, hash) };
  assert.deepEqual(await repo.readClientCompanyPassword(18, { role: 'manager', managerId: 7 }), { password, clientUserId: 26 });
  result.password_hash = changedHash;
  assert.deepEqual(await repo.readClientCompanyPassword(18, { role: 'manager', managerId: 7 }), { password: null, clientUserId: 26 });
});

test('company list and mutation DTOs never select or map credential copies', () => {
  const repo = readFileSync('src/shared/lib/db/clientCompaniesRepo.ts', 'utf8');
  const beforePasswordMutation = repo.slice(0, repo.indexOf('export async function updateClientUserPassword'));
  assert.doesNotMatch(beforePasswordMutation, /display_password|password_ciphertext|displayPassword/);
  const helpers = readFileSync('src/shared/lib/db/clientCompaniesRepo.helpers.ts', 'utf8');
  const mapper = helpers.slice(helpers.indexOf('export function mapClientCompany('), helpers.indexOf('export function mapClientCompanyPriceList'));
  assert.doesNotMatch(mapper, /password_hash|password_ciphertext|display_password|displayPassword/);
});
