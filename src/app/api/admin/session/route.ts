import {
  getAdminSession,
  isManagerSessionRole,
  isTopDashboardManagementSession,
  isTopDashboardSession,
} from '@/shared/lib/adminAuth';
import { getWholesaleManagerById } from '@/shared/lib/db';

export async function GET() {
  const session = await getAdminSession();
  if (isManagerSessionRole(session?.role) && session?.managerId) {
    const manager = await getWholesaleManagerById(session.managerId);
    return Response.json({
      authenticated: true,
      role: session.role,
      adminUserId: session.adminUserId,
      managerId: session.managerId,
      sessionId: session.sessionId,
      dashboardAccess: [],
      canAccessTopDashboard: isTopDashboardSession(session),
      canManageTopDashboard: isTopDashboardManagementSession(session),
      manager: manager
        ? {
            id: manager.id,
            name: manager.name,
            login: manager.login,
            email: manager.email,
          }
        : null,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  }

  return Response.json({
    authenticated: Boolean(session),
    role: session?.role ?? null,
    adminUserId: session?.adminUserId,
    managerId: session?.managerId,
    sessionId: session?.sessionId,
    canAccessTopDashboard: isTopDashboardSession(session),
    canManageTopDashboard: isTopDashboardManagementSession(session),
    dashboardAccess: session?.role === 'purchaser' ? session.dashboardAccess ?? [] : [],
    manager: null,
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
