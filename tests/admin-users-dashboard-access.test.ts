import assert from 'node:assert/strict';
import test from 'node:test';

import { addButtonLabel, defaultRoleForTab, emptyDraftForTab, isUserTab, ROLE_LABELS, roleOptionsForTab, tabForRole, USER_TABS } from '../src/features/admin/users/AdminUsersConfig';
import { readDashboardOptions, toggleDashboardAccess } from '../src/features/admin/users/AdminUsersDashboardAccess';

test('purchaser has a distinct read-only users tab with no default grants', () => {
  assert.equal(isUserTab('purchaser'), true);
  assert.equal(tabForRole('purchaser'), 'purchaser');
  assert.equal(defaultRoleForTab('purchaser'), 'purchaser');
  assert.equal(USER_TABS.find((tab) => tab.value === 'purchaser')?.label, 'Закупщик');
  assert.equal(ROLE_LABELS.purchaser, 'Закупщик — просмотр');
  assert.deepEqual(roleOptionsForTab('purchaser'), [{ value: 'purchaser', label: ROLE_LABELS.purchaser }]);
  assert.equal(addButtonLabel('purchaser'), 'Добавить закупщика');
  assert.deepEqual(emptyDraftForTab('purchaser').dashboardAccess, []);
  assert.equal(emptyDraftForTab('purchaser').canManageTopDashboard, false);
  const draft = emptyDraftForTab('purchaser');
  draft.dashboardAccess.push('top:7');
  assert.deepEqual(emptyDraftForTab('purchaser').dashboardAccess, [], 'new forms do not share a mutable grant list');
});

test('missing or malformed options fail closed, but a loaded empty catalog is valid', () => {
  for (const value of [undefined, null, {}, ['top:7'], [{ key: 'top:7' }], [{ key: '', title: 'Report' }], [{ key: 'top:7', title: ' ' }], [{ key: 'top:7', title: 'A' }, { key: 'top:7', title: 'B' }]]) {
    assert.equal(readDashboardOptions(value), null);
  }
  assert.deepEqual(readDashboardOptions([]), []);
  assert.deepEqual(readDashboardOptions([{ key: 'top:7', title: 'Report', description: 'Read only', href: '/admin/top/7', unexpected: true }]), [
    { key: 'top:7', title: 'Report', description: 'Read only', href: '/admin/top/7' },
  ]);
});

test('checkbox changes use stable keys and preserve existing grants absent from options', () => {
  const current = ['top:7', 'top:999'];
  assert.deepEqual(toggleDashboardAccess(current, 'route-planner', true), ['top:7', 'top:999', 'route-planner']);
  assert.deepEqual(toggleDashboardAccess(current, 'top:7', false), ['top:999']);
  assert.deepEqual(toggleDashboardAccess(current, 'top:7', true), current);
  assert.deepEqual(current, ['top:7', 'top:999']);
});

test('individual report options retain their distinct keys even when display titles match', () => {
  const options = readDashboardOptions([
    { key: 'top:7', title: 'Отчёт', href: '/admin/top/7' },
    { key: 'top:8', title: 'Отчёт', href: '/admin/top/8' },
    { key: 'route-planner', title: 'Компоновщик рейсов', href: '/admin/top/route-planner' },
  ]);
  assert.ok(options);
  assert.deepEqual(options.map((option) => option.key), ['top:7', 'top:8', 'route-planner']);
  assert.deepEqual(toggleDashboardAccess(['top:7'], options[1].key, true), ['top:7', 'top:8']);
  assert.deepEqual(toggleDashboardAccess(['top:7', 'top:8'], options[0].key, false), ['top:8']);
});
