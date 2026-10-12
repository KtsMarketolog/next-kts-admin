import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import test from 'node:test';

import { decryptEmployeePassword, encryptEmployeePassword, resolveEmployeePasswordCiphertext, verifyEmployeePasswordCopy } from '../src/shared/lib/employeePasswordVault';
import { applyEmployeePasswordMigration } from '../src/shared/lib/db/employeePasswordMigration';

const password = 'SyntheticOnly19278!';
function hash(value: string, salt = 'd'.repeat(32)) {
  return `scrypt:${salt}:${scryptSync(value, salt, 64).toString('hex')}`;
}
const passwordHash = hash(password);

test('encrypted server copy is randomized and bound to the exact current salted login hash', () => {
  const first = encryptEmployeePassword(password, passwordHash);
  const second = encryptEmployeePassword(password, passwordHash);
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  assert.equal(decryptEmployeePassword(first, passwordHash), password);
  assert.equal(decryptEmployeePassword(first, hash(password, 'a'.repeat(32))), null);
  assert.equal(decryptEmployeePassword(first, hash('OtherPassword81290!')), null);
  const parts = first.split('.');
  parts[4] = (parts[4][0] === 'a' ? 'b' : 'a') + parts[4].slice(1);
  assert.equal(decryptEmployeePassword(parts.join('.'), passwordHash), null);
  for (const invalid of [null, undefined, '', 'plaintext', 'v1.session.x.y.z', 'x'.repeat(3000)]) {
    assert.equal(decryptEmployeePassword(invalid, passwordHash), null);
  }
});

test('only legacy copies matching the real login hash can migrate; unknown copies remain unavailable', async () => {
  assert.equal(await verifyEmployeePasswordCopy(password, passwordHash), true);
  assert.equal(await verifyEmployeePasswordCopy('WrongPassword91828!', passwordHash), false);
  assert.equal(await verifyEmployeePasswordCopy(password, 'not-a-login-hash'), false);
  const cipher = await resolveEmployeePasswordCiphertext({ legacyPassword: password, passwordHash });
  assert.equal(decryptEmployeePassword(cipher, passwordHash), password);
  assert.equal(await resolveEmployeePasswordCiphertext({ previousCiphertext: cipher, passwordHash }), cipher);
  assert.equal(await resolveEmployeePasswordCiphertext({ legacyPassword: 'stale', passwordHash }), null);
  assert.equal(await resolveEmployeePasswordCiphertext({ passwordHash }), null);
});

test('dedicated key is optional, key source survives enabling it, bad key fails before saving', () => {
  const previous = process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY;
  try {
    delete process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY;
    const sessionCopy = encryptEmployeePassword(password, passwordHash);
    process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const dedicatedCopy = encryptEmployeePassword(password, passwordHash);
    assert.equal(decryptEmployeePassword(sessionCopy, passwordHash), password);
    assert.equal(decryptEmployeePassword(dedicatedCopy, passwordHash), password);
    process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = 'invalid';
    assert.throws(() => encryptEmployeePassword(password, passwordHash), /32-byte/);
    assert.throws(() => decryptEmployeePassword(dedicatedCopy, passwordHash), /32-byte/);
  } finally {
    if (previous === undefined) delete process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY;
    else process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = previous;
  }
});

test('a profile-only edit preserves encrypted copies during a key outage, but never reveals stale credentials', async () => {
  const previous = process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY;
  try {
    process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    const copy = encryptEmployeePassword(password, passwordHash);
    process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = 'invalid';
    assert.equal(await resolveEmployeePasswordCiphertext({ previousCiphertext: copy, passwordHash }), copy);
    process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
    assert.equal(decryptEmployeePassword(copy, passwordHash), password);
    const changedHash = hash('OtherPassword81290!');
    const retained = await resolveEmployeePasswordCiphertext({ previousCiphertext: copy, passwordHash: changedHash });
    assert.equal(decryptEmployeePassword(retained, changedHash), null);
  } finally {
    if (previous === undefined) delete process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY;
    else process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY = previous;
  }
});

test('migration preserves every login hash and business table, removes only legacy display copies', async () => {
  const statements: string[] = [];
  const migrated: unknown[][] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      statements.push(sql);
      if (sql.includes('select id')) return { rows: [
        { id: 1, password_hash: passwordHash, password_ciphertext: null, display_password: password },
        { id: 2, password_hash: passwordHash, password_ciphertext: null, display_password: 'outdated' },
      ] };
      if (sql.startsWith('update')) migrated.push(params!);
      return { rows: [] };
    },
  };
  await applyEmployeePasswordMigration(client as never);
  assert.equal(migrated.length, 2);
  assert.equal(decryptEmployeePassword(migrated[0][1] as string, passwordHash), password);
  assert.equal(migrated[1][1], null);
  assert.ok(statements.every((sql) => !/password_hash\s*=|delete\s+from|drop\s|wholesale_price|snapshot/i.test(sql)));
  assert.match(statements[0], /add column if not exists password_ciphertext/);
});
