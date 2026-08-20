import { isManagerSessionRole, type AdminSession } from './adminAuth';
import { checkDbRateLimit } from './rateLimit';

const ADMIN_ACTION_WINDOW_MS = 10 * 60 * 1000;

function actorKey(session: AdminSession) {
  if (isManagerSessionRole(session.role)) return `manager:${session.managerId ?? 'unknown'}`;
  if (session.adminUserId) return `admin:${session.adminUserId}`;
  return `role:${session.role}`;
}

export async function enforceAdminActionRateLimit(
  session: AdminSession,
  action: string,
  limit = 120,
  windowMs = ADMIN_ACTION_WINDOW_MS,
) {
  const result = await checkDbRateLimit(`admin_action:user:${actorKey(session)}:action:${action}`, limit, windowMs);
  if (result.allowed) return null;

  return Response.json(
    { error: 'Too many admin actions' },
    {
      status: 429,
      headers: { 'Retry-After': String(result.retryAfter) },
    },
  );
}
