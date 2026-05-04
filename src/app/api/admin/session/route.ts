import { getAdminSession } from '@/shared/lib/adminAuth';
import { getWholesaleManagerById } from '@/shared/lib/db';

export async function GET() {
  const session = await getAdminSession();
  if (session?.role === 'manager' && session.managerId) {
    const manager = await getWholesaleManagerById(session.managerId);
    return Response.json({
      authenticated: true,
      role: 'manager',
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

  return Response.json({ authenticated: Boolean(session), role: session?.role ?? null, manager: null });
}
