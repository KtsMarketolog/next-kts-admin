import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DASHBOARD_AUDIENCE_ROLES,
  dashboardAudienceRoleEmployeeIds,
  dashboardAudienceRoleLabel,
  filterDashboardAudience,
  selectDashboardAudienceEmployees,
  type DashboardAudienceEmployee,
} from '../src/features/admin/dashboard-access/DashboardAudienceSelection';

const employee = (id: string, role: string, overrides: Partial<DashboardAudienceEmployee> = {}): DashboardAudienceEmployee => ({
  id, role, name: id, login: id, isActive: true, checked: false, locked: false, eligible: true, ...overrides,
});

test('role selection is explicit active eligible unlocked employee IDs, never a future role grant', () => {
  for (const { value: role } of DASHBOARD_AUDIENCE_ROLES) {
    const users = [
      employee('current', role),
      employee('inactive', role, { isActive: false }),
      employee('private', role, { eligible: false }),
      employee('management', role, { locked: true, checked: true }),
      employee('different-role', role === 'top' ? 'manager' : 'top'),
    ];
    const ids = dashboardAudienceRoleEmployeeIds(users, role);
    assert.deepEqual(ids, ['current']);
    const withNewEmployee = [...users, employee('future', role)];
    const selected = selectDashboardAudienceEmployees(withNewEmployee, ids, true);
    assert.equal(selected.find((user) => user.id === 'current')?.checked, true);
    assert.equal(selected.find((user) => user.id === 'future')?.checked, false);
    assert.equal(selected.find((user) => user.id === 'private')?.checked, false);
    assert.equal(selected.find((user) => user.id === 'inactive')?.checked, false);
    const cleared = selectDashboardAudienceEmployees(selected, ids, false);
    assert.equal(cleared.find((user) => user.id === 'current')?.checked, false);
    assert.equal(cleared.find((user) => user.id === 'management')?.checked, true);
    assert.equal(users[0].checked, false, 'selection does not mutate the loaded snapshot');
  }
  assert.deepEqual(dashboardAudienceRoleEmployeeIds([employee('x', 'top')], ''), []);
  assert.deepEqual(dashboardAudienceRoleEmployeeIds([employee('x', 'top')], '*'), []);
});

test('role and search only filter presentation; role bulk selection ignores search', () => {
  const users = [employee('mr-1', 'manager', { name: 'Анна' }), employee('mr-2', 'manager', { name: 'Борис' }), employee('ms', 'support_manager', { name: 'Анна' })];
  assert.deepEqual(filterDashboardAudience(users, 'manager', ' АННА ').map((user) => user.id), ['mr-1']);
  assert.deepEqual(filterDashboardAudience(users, '', 'anna').map((user) => user.id), []);
  assert.deepEqual(dashboardAudienceRoleEmployeeIds(users, 'manager'), ['mr-1', 'mr-2']);
  assert.deepEqual(filterDashboardAudience(users, '', '').map((user) => user.id), ['mr-1', 'mr-2', 'ms']);
  assert.match(dashboardAudienceRoleLabel('manager'), /МР/);
  assert.match(dashboardAudienceRoleLabel('support_manager'), /МС/);
  assert.equal(dashboardAudienceRoleLabel('unknown'), 'Другой профиль');
});

test('even manually supplied checkbox IDs cannot clear management or grant another private audience', () => {
  const users = [employee('locked', 'admin', { locked: true, checked: true }), employee('private', 'manager', { eligible: false })];
  assert.deepEqual(selectDashboardAudienceEmployees(users, ['locked', 'private'], false), users);
  assert.deepEqual(selectDashboardAudienceEmployees(users, ['locked', 'private'], true), users);
});
