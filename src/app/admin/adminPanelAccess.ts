import type { AdminSession } from '@/shared/lib/adminAuth';
import { isManagerRole } from './adminPanelConfig';

export function isTopDashboardPath(pathname: string) {
  return /^\/admin\/top(?:\/[1-9]\d*)?\/?$/.test(pathname);
}

export function canRoleAccessTopDashboard(
  role: AdminSession['role'] | null | undefined,
  explicitPermission: boolean | undefined,
) {
  return role === 'admin'
    || role === 'admintop'
    || role === 'top'
    || role === 'purchaser'
    || explicitPermission === true;
}

export function canRoleManageTopDashboard(
  role: AdminSession['role'] | null | undefined,
  explicitPermission: boolean | undefined,
) {
  return role === 'admin'
    || role === 'admintop'
    || ((role === 'top' || isManagerRole(role)) && explicitPermission === true);
}

export function isTopAreaOnlyRole(role: AdminSession['role'] | null | undefined) {
  return role === 'top' || role === 'admintop' || role === 'purchaser';
}
