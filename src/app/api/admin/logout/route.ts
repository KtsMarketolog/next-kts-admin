import { clearAdminSession, getAdminSession, isManagerSessionRole } from '@/shared/lib/adminAuth';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { getClientIp } from '@/shared/lib/rateLimit';

export async function POST(request: Request) {
  const session = await getAdminSession();
  await clearAdminSession();
  await recordSecurityEvent({
    eventType: 'logout',
    actorType: isManagerSessionRole(session?.role)
      ? 'manager'
      : session?.role === 'wholesale_admin'
        ? 'wholesale_admin'
        : session?.role === 'top'
          ? 'top'
          : 'admin',
    adminUserId: session?.adminUserId,
    managerId: session?.managerId,
    sessionId: session?.sessionId,
    ip: getClientIp(request),
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
  });
  return Response.json({ ok: true });
}
