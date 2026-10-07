import type { AdminSession } from './adminAuth';

export function validDashboardKey(key: unknown): key is string {
  return typeof key === 'string' && (['manager:development', 'manager:support', 'route-planner', 'currency-rates'].includes(key)
    || (/^top:[1-9]\d{0,15}$/.test(key) && Number.isSafeInteger(Number(key.slice(4)))));
}

export function hasDashboardIdentity(session: AdminSession | null | undefined): session is AdminSession {
  if (!session?.sessionId) return false;
  if (!['admin', 'admintop', 'top', 'wholesale_admin', 'manager', 'support_manager', 'purchaser'].includes(session.role)) return false;
  // Environment-backed site admins still have a persisted session, but no admin_users row.
  if (session.role === 'admin') return true;
  const id = session.role === 'manager' || session.role === 'support_manager' ? session.managerId : session.adminUserId;
  return Number.isSafeInteger(id) && Number(id) > 0;
}

export function hasDashboardViewGrant(session: AdminSession | null | undefined, key: string) {
  return hasDashboardIdentity(session) && validDashboardKey(key)
    && Array.isArray(session.dashboardAccess) && session.dashboardAccess.includes(key);
}

/** Existing management rights are independent of the read-only checkboxes. */
export function hasDashboardManagementRight(session: AdminSession | null | undefined, key: string) {
  if (!hasDashboardIdentity(session) || !validDashboardKey(key)) return false;
  if (session.role === 'admin' || session.role === 'admintop') return true;
  return (key.startsWith('top:') || key === 'currency-rates')
    && ['top', 'manager', 'support_manager'].includes(session.role) && session.canManageTopDashboard === true;
}

export function canViewDashboardKey(session: AdminSession | null | undefined, key: string): boolean {
  if (hasDashboardManagementRight(session, key)) return true;
  if (!hasDashboardViewGrant(session, key)) return false;
  if (key === 'manager:development') return session!.role === 'manager' && Number(session!.managerId) > 0;
  if (key === 'manager:support') return session!.role === 'support_manager' && Number(session!.managerId) > 0;
  return true;
}
