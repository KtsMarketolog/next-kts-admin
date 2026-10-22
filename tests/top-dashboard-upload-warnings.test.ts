import assert from 'node:assert/strict';
import test from 'node:test';

import { uploadWarningMessages } from '../src/features/admin/top-dashboard/topDashboardManagementModel';

test('TOP upload warnings accept server objects and preview-relay strings in their original order', () => {
  const first = 'Данные сохранены. Повторная загрузка не нужна.';
  const second = 'Очистка требует проверки.';
  assert.deepEqual(uploadWarningMessages([
    { code: 'TOP_DASHBOARD_UPLOAD_SLOT_RELEASE_FAILED', message: first },
    second,
    { message: 'Журнал ожидает обработки.', extra: 'ignored' },
  ]), [first, second, 'Журнал ожидает обработки.']);
  assert.deepEqual(uploadWarningMessages(uploadWarningMessages([
    { code: 'SAVED_WITH_WARNING', message: first },
    { message: second },
  ])), [first, second], 'same-origin preview relay preserves normalized messages');
});

test('TOP upload warnings ignore invalid collections and invalid or blank messages', () => {
  for (const value of [undefined, null, true, 1, 'text', { message: 'text' }, '[]']) {
    assert.deepEqual(uploadWarningMessages(value), []);
  }
  const invalid = [null, undefined, false, 4, {}, { code: 'NO_MESSAGE' }, { message: 7 },
    { message: {} }, { message: null }, { message: ['text'] }, '', ' \n\t ', { message: '  ' }];
  for (const value of invalid) {
    assert.deepEqual(uploadWarningMessages([value, 'valid']), ['valid']);
  }
});

test('TOP upload warning normalization examines no more than the first ten entries', () => {
  const messages = Array.from({ length: 14 }, (_, index) => `warning ${index}`);
  assert.deepEqual(uploadWarningMessages(messages), messages.slice(0, 10));
  assert.deepEqual(uploadWarningMessages([
    ...Array.from({ length: 10 }, () => null),
    'must not be inspected beyond the candidate limit',
  ]), []);
});

test('TOP upload warning messages are limited to one thousand characters without mutating the source', () => {
  const original = 'А'.repeat(1_200);
  const source = Object.freeze([
    Object.freeze({ code: 'TEST', message: original }),
    original,
  ] as const);
  const result = uploadWarningMessages(source);
  assert.deepEqual(result, ['А'.repeat(1_000), 'А'.repeat(1_000)]);
  assert.equal(source[0].message.length, 1_200);
  assert.equal(source[1].length, 1_200);
});

test('TOP upload warnings remain plain strings without interpreting markup, JSON, URLs or escape syntax', () => {
  const messages = [
    '<img src=x onerror="alert(1)">',
    '<script>throw new Error("not executed")</script>',
    '&lt;strong&gt;Сохранено&lt;/strong&gt;',
    '{"message":"not parsed"}',
    'javascript:alert(1)',
    '\\u003cscript\\u003e',
    '  Сохранено\nбез повторной загрузки.  ',
  ];
  assert.deepEqual(uploadWarningMessages(messages), messages);
  assert.deepEqual(uploadWarningMessages(messages.map((message) => ({ message }))), messages);
});
