import { getAdminSession, isManagerSessionRole, isTopDashboardSession } from '@/shared/lib/adminAuth';
import { getWholesaleManagerById } from '@/shared/lib/db';

export async function GET() {
  const session = await getAdminSession();
  if (isManagerSessionRole(session?.role) && session?.managerId) {
    const manager = await getWholesaleManagerById(session.managerId);
    return Response.json({
      authenticated: true,
      role: session.role,
      canAccessTopDashboard: isTopDashboardSession(session),
      manager: manager
        ? {
            id: manager.id,
            name: manager.name,
            login: manager.login,
            email: manager.email,
          }
        : null,
    });
  }

  return Response.json({
    authenticated: Boolean(session),
    role: session?.role ?? null,
    canAccessTopDashboard: isTopDashboardSession(session),
    manager: null,
  });
}
