import { getAdminSession } from '@/shared/lib/adminAuth';
import { canViewOwnPersonalDevelopmentDashboard } from '@/shared/lib/managerDashboardSecurity';
import { personalApiError, personalJson } from '../_shared';

export async function requireOwnPersonalAccess() {
  const session = await getAdminSession();
  if (!canViewOwnPersonalDevelopmentDashboard(session)) {
    return { denied: personalJson({ error: 'Нет доступа к личному отчёту руководителя' }, session ? 403 : 401) } as const;
  }
  // Never accept manager/admin ids, email or ownership from query parameters.
  return { recipient: { source: 'admin' as const, id: session.adminUserId }, denied: null } as const;
}

export function personalOwnQuery(request: Request, allowed: readonly string[]) {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some((key) => !allowed.includes(key) || query.getAll(key).length !== 1)) return null;
  if (query.has('audience') && query.get('audience') !== 'development') return null;
  return query;
}

export { personalApiError, personalJson };
