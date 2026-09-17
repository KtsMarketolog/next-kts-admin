import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeTopDashboardUploadTargets,
  topDashboardUploadTargetKey,
} from '../src/features/admin/top-dashboard/topDashboardUploadSelection';

const sales = {
  target: { id: 'sales', name: null, index: 0 },
  multiple: true,
  directory: false,
  accept: '.json,.json.gz',
  label: 'Продажи',
};

test('TOP management descriptors preserve multi-file, folder and accept semantics', () => {
  const directory = {
    ...sales,
    target: { id: 'folder', name: 'reports', index: 1 },
    multiple: false,
    directory: true,
    accept: '',
    label: 'Папка отчётов',
  };
  assert.deepEqual(normalizeTopDashboardUploadTargets([sales, directory]), [sales, directory]);
  assert.notEqual(topDashboardUploadTargetKey(sales.target), topDashboardUploadTargetKey(directory.target));
});

test('TOP management rejects malformed, overlong or duplicate target messages as a whole', () => {
  for (const invalid of [
    null,
    { targets: [sales] },
    [sales, sales],
    [sales, { ...sales, target: { ...sales.target, id: 'other' } }],
    [{ ...sales, target: { ...sales.target, index: -1 } }],
    [{ ...sales, target: { ...sales.target, id: '\0hidden' } }],
    [{ ...sales, target: { ...sales.target, name: 42 } }],
    [{ ...sales, multiple: 'yes' }],
    [{ ...sales, label: 'x'.repeat(513) }],
    [{ ...sales, accept: 'x'.repeat(2049) }],
    Array.from({ length: 257 }, (_, index) => ({ ...sales, target: { ...sales.target, index } })),
  ]) assert.deepEqual(normalizeTopDashboardUploadTargets(invalid), []);
});

test('TOP discovery does not confuse all available inputs with the selected target limit', () => {
  const inputs = Array.from({ length: 33 }, (_, index) => ({
    ...sales, target: { id: `input-${index}`, name: null, index },
  }));
  assert.equal(normalizeTopDashboardUploadTargets(inputs).length, 33);
});

test('TOP management uses plain-text labels and a fallback for empty labels', () => {
  assert.equal(normalizeTopDashboardUploadTargets([{ ...sales, label: '   ' }])[0]?.label, 'Данные 1');
  assert.equal(normalizeTopDashboardUploadTargets([{ ...sales, label: '<img onerror="alert(1)">' }])[0]?.label, '<img onerror="alert(1)">');
});
