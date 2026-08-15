import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePasswordPolicy } from '../src/shared/lib/passwordPolicy';

test('password policy accepts a sufficiently strong password', () => {
  assert.deepEqual(validatePasswordPolicy('Надёжный2026!'), { ok: true });
});

test('password policy rejects short, incomplete, and common passwords', () => {
  assert.equal(validatePasswordPolicy('Abc123').ok, false);
  assert.equal(validatePasswordPolicy('ТолькоБуквы').ok, false);
  assert.equal(validatePasswordPolicy('admin-2026-secure').ok, false);
});

test('password policy rejects unexpectedly large input', () => {
  const result = validatePasswordPolicy(`Safe123${'x'.repeat(194)}`);

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /200/);
});
