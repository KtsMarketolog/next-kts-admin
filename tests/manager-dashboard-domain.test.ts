import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  getManagerEmailHash,
  inspectPersonalSnapshot,
  PERSONAL_DASHBOARD_SNAPSHOT_MAX_BYTES,
  PERSONAL_DASHBOARD_MANAGER_MAX_BYTES,
  PERSONAL_DASHBOARD_MANAGER_MAX_VERSIONS,
  personalDashboardToday,
  PersonalDashboardError,
} from '../src/shared/lib/managerDashboardDomain';
import { resolvePersonalDashboardManager } from '../src/shared/lib/db/managerDashboardRepo';

function fixture(overrides: Record<string, unknown> = {}) {
  return {
    fmt: 'kts-personal', v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 200000, salt: Buffer.alloc(16, 2).toString('base64') },
    iv: Buffer.alloc(12, 3).toString('base64'), gz: true,
    emailHash: getManagerEmailHash('manager@example.test'),
    name: 'Тестовый Менеджер', role: 'МР — по МР партнёра',
    issued: '2026-09-08', expires: '2026-10-23', ct: Buffer.alloc(32, 4).toString('base64'),
    ...overrides,
  };
}
const inspect = (overrides: Record<string, unknown> = {}) => inspectPersonalSnapshot(Buffer.from(JSON.stringify(fixture(overrides))), 'личный_снимок.ktsp');

test('personal snapshot email hash exactly follows browser trim/lowercase/SHA256/base64', () => {
  assert.equal(getManagerEmailHash('  MANAGER@Example.test\n'), getManagerEmailHash('manager@example.test'));
  assert.equal(getManagerEmailHash('тест@example.test'), createHash('sha256').update('тест@example.test').digest('base64'));
  assert.notEqual(getManagerEmailHash('manager+1@example.test'), getManagerEmailHash('manager@example.test'));
});
test('personal business dates use Moscow midnight rather than UTC midnight', () => {
  assert.equal(personalDashboardToday(new Date('2026-09-14T20:59:59Z')), '2026-09-14');
  assert.equal(personalDashboardToday(new Date('2026-09-14T21:00:00Z')), '2026-09-15');
});
test('personal storage quota fits the current and previous maximum-size snapshots without an age cutoff', () => {
  assert.equal(PERSONAL_DASHBOARD_MANAGER_MAX_VERSIONS, 2);
  assert.ok(PERSONAL_DASHBOARD_MANAGER_MAX_BYTES >= PERSONAL_DASHBOARD_MANAGER_MAX_VERSIONS * PERSONAL_DASHBOARD_SNAPSHOT_MAX_BYTES);
  assert.equal(PERSONAL_DASHBOARD_MANAGER_MAX_BYTES, 128 * 1024 * 1024);
});
test('personal recipient matching requires one active manager of either group and exact current email', () => {
  const one = { id: 1, email: '\u00a0MANAGER@Example.test\u00a0', isActive: true, role: 'manager' };
  const hash = getManagerEmailHash('manager@example.test');
  assert.deepEqual(resolvePersonalDashboardManager([one], hash), { status: 'matched', managerId: 1 });
  assert.equal(resolvePersonalDashboardManager([{ ...one, email: 'new@example.test' }], hash).status, 'unknown');
  assert.equal(resolvePersonalDashboardManager([{ ...one, isActive: false }], hash).status, 'unknown');
  assert.equal(resolvePersonalDashboardManager([{ ...one, role: 'support_manager' }], hash).status, 'matched');
  assert.equal(resolvePersonalDashboardManager([{ ...one, role: 'unexpected' }], hash).status, 'unknown');
  assert.equal(resolvePersonalDashboardManager([one, { ...one, id: 2 }], hash).status, 'ambiguous');
  assert.equal(resolvePersonalDashboardManager([one, { ...one, id: 2, role: 'support_manager' }], hash).status, 'ambiguous');
  assert.equal(resolvePersonalDashboardManager([one, { ...one, id: 2, isActive: false }], hash).managerId, 1);
  assert.equal(resolvePersonalDashboardManager([{ ...one, email: '' }], getManagerEmailHash('')).status, 'unknown');
});
test('mixed snapshot batch assigns by email rather than filename or the audience currently shown to an admin', () => {
  const managers = [
    { id: 1, email: 'development@example.test', isActive: true, role: 'manager' },
    { id: 2, email: 'support@example.test', isActive: true, role: 'support_manager' },
  ];
  for (const manager of managers) {
    const metadata = inspect({ emailHash: getManagerEmailHash(manager.email), role: 'arbitrary source label' });
    assert.deepEqual(resolvePersonalDashboardManager(managers, metadata.emailHash), { status: 'matched', managerId: manager.id });
  }
});
test('personal snapshot inspects encrypted metadata without exposing ciphertext', () => {
  const result = inspect();
  assert.equal(result.name, 'Тестовый Менеджер');
  assert.equal(result.issued, '2026-09-08');
  assert.equal(result.emailHash, getManagerEmailHash('manager@example.test'));
  assert.equal(result.sha256.length, 64);
  assert.equal('ct' in result, false);
});
test('personal snapshot assignment does not use the name of a file or a person', () => {
  const bytes = Buffer.from(JSON.stringify(fixture()));
  const a = inspectPersonalSnapshot(bytes, 'one.ktsp');
  const b = inspectPersonalSnapshot(bytes, '../../other.ktsp');
  assert.equal(a.emailHash, b.emailHash);
  assert.equal(a.sha256, b.sha256);
  assert.equal(b.originalName, 'other.ktsp');
});
test('personal snapshot rejects empty, oversized, non-json and invalid UTF8 input', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(PERSONAL_DASHBOARD_SNAPSHOT_MAX_BYTES + 1), Buffer.from('<html>'), Buffer.from([0xff, 0xfe])]) {
    assert.throws(() => inspectPersonalSnapshot(bytes, 'file.ktsp'), PersonalDashboardError);
  }
});
test('personal snapshot rejects wrong extension, envelope, version and gzip flag', () => {
  assert.throws(() => inspectPersonalSnapshot(Buffer.from(JSON.stringify(fixture())), 'file.json'), PersonalDashboardError);
  for (const change of [{ fmt: 'kts-bundle' }, { v: 2 }, { gz: 1 }, { kdf: [] }]) assert.throws(() => inspect(change), PersonalDashboardError);
});
test('personal snapshot validates canonical base64, digest, salt, IV and authentication tag lengths', () => {
  for (const change of [
    { emailHash: '0'.repeat(64) }, { emailHash: fixture().emailHash.slice(0, -1) },
    { iv: Buffer.alloc(16).toString('base64') }, { ct: Buffer.alloc(15).toString('base64') },
    { ct: 'AA===' }, { ct: ` ${fixture().ct}` },
    { kdf: { ...fixture().kdf, salt: Buffer.alloc(8).toString('base64') } },
  ]) assert.throws(() => inspect(change), PersonalDashboardError);
});
test('personal snapshot rejects invalid or excessive KDF parameters', () => {
  for (const change of [{ iter: 199999 }, { iter: 600001 }, { iter: 200000.1 }, { iter: '200000' }, { hash: 'SHA-1' }, { name: 'scrypt' }]) {
    assert.throws(() => inspect({ kdf: { ...fixture().kdf, ...change } }), PersonalDashboardError);
  }
  assert.equal(inspect({ kdf: { ...fixture().kdf, iter: 600000 } }).issued, '2026-09-08');
});
test('personal snapshot validates real calendar dates and bounded metadata', () => {
  for (const change of [{ issued: '2026-02-30' }, { expires: '2026-09-07' }, { issued: '2026-09-08T00:00:00Z' }, { name: '' }, { name: 'x'.repeat(241) }, { role: 'a\nb' }]) {
    assert.throws(() => inspect(change), PersonalDashboardError);
  }
  assert.equal(inspect({ issued: '2024-02-29' }).issued, '2024-02-29');
});
