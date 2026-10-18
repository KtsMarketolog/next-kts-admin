import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canRoleAccessTopDashboard,
  canRoleManageTopDashboard,
  isTopAreaOnlyRole,
  isTopDashboardPath,
} from '../src/app/admin/adminPanelAccess';
import type { AdminSession } from '../src/shared/lib/adminAuth';

test('extracted admin panel access rules preserve separate viewing and management capabilities', () => {
  const cases: Array<{ role: AdminSession['role']; view: boolean; manage: boolean; manageWithGrant: boolean; topOnly: boolean }> = [
    { role: 'admin', view: true, manage: true, manageWithGrant: true, topOnly: false },
    { role: 'admintop', view: true, manage: true, manageWithGrant: true, topOnly: true },
    { role: 'top', view: true, manage: false, manageWithGrant: true, topOnly: true },
    { role: 'purchaser', view: true, manage: false, manageWithGrant: false, topOnly: true },
    { role: 'manager', view: false, manage: false, manageWithGrant: true, topOnly: false },
    { role: 'support_manager', view: false, manage: false, manageWithGrant: true, topOnly: false },
    { role: 'wholesale_admin', view: false, manage: false, manageWithGrant: false, topOnly: false },
  ];
  for (const { role, view, manage, manageWithGrant, topOnly } of cases) {
    for (const grant of [undefined, false]) {
      assert.equal(canRoleAccessTopDashboard(role, grant), view, `${role}: view`);
      assert.equal(canRoleManageTopDashboard(role, grant), manage, `${role}: manage`);
    }
    assert.equal(canRoleAccessTopDashboard(role, true), true, `${role}: explicit view`);
    assert.equal(canRoleManageTopDashboard(role, true), manageWithGrant, `${role}: explicit management`);
    assert.equal(isTopAreaOnlyRole(role), topOnly, `${role}: available areas`);
  }
  for (const role of [undefined, null]) {
    assert.equal(canRoleAccessTopDashboard(role, false), false);
    assert.equal(canRoleManageTopDashboard(role, true), false);
    assert.equal(isTopAreaOnlyRole(role), false);
  }
});

test('admin panel report route matching remains exact after extraction', () => {
  for (const pathname of ['/admin/top', '/admin/top/', '/admin/top/1', '/admin/top/123/']) {
    assert.equal(isTopDashboardPath(pathname), true, pathname);
  }
  for (const pathname of ['/admin/top/0', '/admin/top/01', '/admin/top/-1', '/admin/top/1/edit', '/admin/top-secret', '/admin/site']) {
    assert.equal(isTopDashboardPath(pathname), false, pathname);
  }
});
