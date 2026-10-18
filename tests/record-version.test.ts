import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRecordRevision, parseRecordRevision, RecordVersionConflictError } from '../src/shared/lib/recordVersion';

test('record revisions preserve full PostgreSQL bigint precision', () => {
  for (const value of ['1', '42', '9007199254740993', '9223372036854775807']) {
    assert.equal(parseRecordRevision(value), value);
    assert.doesNotThrow(() => assertRecordRevision(value, value));
  }
});

test('missing, malformed or rounded revisions cannot bypass conflict detection', () => {
  for (const value of [undefined, null, 1, 42, '', '0', '-1', '01', '1.0', '1e0', ' 1', '1 ', '9223372036854775808', '12345678901234567890', {}, ['1']]) {
    assert.equal(parseRecordRevision(value), null);
    assert.throws(() => assertRecordRevision(value, '1'), RecordVersionConflictError);
  }
  assert.throws(() => assertRecordRevision('1', ''), RecordVersionConflictError);
});

test('only the exact loaded revision can be saved and conflict has a stable public code', () => {
  assert.throws(() => assertRecordRevision('6', '7'), (error: unknown) => {
    assert.ok(error instanceof RecordVersionConflictError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'RECORD_VERSION_CONFLICT');
    assert.match(error.message, /изменены другим пользователем/);
    return true;
  });
  assert.throws(() => assertRecordRevision('8', '7'), RecordVersionConflictError);
});
