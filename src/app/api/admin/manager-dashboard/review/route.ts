import { getPersonalDashboardReviewOverview } from '@/shared/lib/db/managerDashboardRepo';
import { parsePersonalDashboardId } from '@/shared/lib/managerDashboardSecurity';
import { personalJson, personalReviewError, personalReviewQuery, requirePersonalReviewAccess } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requirePersonalReviewAccess();
    if (access.denied) return access.denied;
    const query = personalReviewQuery(request, ['manager']);
    const managerId = parsePersonalDashboardId(query?.get('manager') ?? null);
    if (!query || (query.has('manager') && !managerId)) return personalJson({ error: 'Некорректный менеджер' }, 400);
    return personalJson(await getPersonalDashboardReviewOverview(access.viewer, managerId ?? undefined));
  } catch (error) { return personalReviewError(error); }
}
