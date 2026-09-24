import { getAdminSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { canAccessRoutePlanner } from '@/shared/lib/dashboardAccess';
import type { SharedDashboardViewer } from '@/shared/lib/db/supportSharedDashboardRepo';
import { getWholesaleManagerById } from '@/shared/lib/db/wholesaleAdminRepo/managerRepo';
import { personalDashboardMode } from '@/shared/lib/managerDashboardSecurity';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { personalJson } from '../_shared';

/** A shared report is an explicitly separate scope, never an alternative manager ID. */
export async function requireSharedAccess(request?: Request, manageOnly = false) {
  const session = await getAdminSession();
  const mode = personalDashboardMode(session) === 'manage' ? 'manage' : 'view';
  if (!session || !canAccessRoutePlanner(session) || (manageOnly && mode !== 'manage')) {
    return {denied: personalJson({error: 'Нет доступа к компоновщику рейсов'}, session ? 403 : 401)} as const;
  }
  if (session.role === 'support_manager') {
    const manager = await getWholesaleManagerById(session.managerId!);
    if (!manager?.isActive || manager.role !== 'support_manager') {
      return {denied: personalJson({error: 'Учётная запись менеджера недоступна'}, 403)} as const;
    }
  }
  if (request && request.method !== 'GET') {
    const originError = enforceSameOriginRequest(request);
    if (originError) return {denied: originError} as const;
    const limited = await enforceAdminActionRateLimit(session, 'personal_dashboard_write', 30, 10 * 60 * 1000);
    if (limited) return {denied: limited} as const;
  }
  const viewer: SharedDashboardViewer | undefined = mode === 'manage' ? undefined
    : session.role === 'purchaser' ? {purchaserId: session.adminUserId!} : session.managerId!;
  return {session, mode, viewer, actorId: `${session.role}:${session.adminUserId ?? session.sessionId}`, denied: null} as const;
}

export function sharedQuery(request: Request, allowed: readonly string[]) {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some((key) => !allowed.includes(key) || query.getAll(key).length !== 1)) return null;
  if (query.has('preview') && query.get('preview') !== '1') return null;
  return query;
}
