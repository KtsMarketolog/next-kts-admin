import { getAdminSession } from '@/shared/lib/adminAuth';
import { canReviewPersonalDevelopmentDashboards } from '@/shared/lib/managerDashboardSecurity';
import { personalApiError, personalJson } from '../_shared';

export async function requirePersonalReviewAccess() {
  const session = await getAdminSession();
  if (!session || !canReviewPersonalDevelopmentDashboards(session)) {
    return { denied: personalJson({ error: 'Нет доступа к просмотру отчётов МР' }, session ? 403 : 401) } as const;
  }
  return { viewer: { adminUserId: session.adminUserId!, sessionId: session.sessionId! }, denied: null } as const;
}

export function personalReviewQuery(request: Request, allowed: readonly string[]) {
  const query = new URL(request.url).searchParams;
  return [...query.keys()].some((key) => !allowed.includes(key) || query.getAll(key).length !== 1) ? null : query;
}

export function personalReviewError(error: unknown) {
  if (error instanceof Error && error.name === 'PersonalDashboardError' && 'code' in error) {
    if (error.code === 'REVIEW_FORBIDDEN') return personalJson({ error: error.message }, 403);
    if (error.code === 'REVIEW_NOT_FOUND') return personalJson({ error: error.message }, 404);
  }
  return personalApiError(error);
}

export { personalJson };
