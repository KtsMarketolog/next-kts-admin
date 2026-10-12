import { getPersonalDashboardReviewOverview } from '@/shared/lib/db/managerDashboardRepo';
import { buildPersonalDashboardReviewFrame } from '@/shared/lib/managerDashboardHtml';
import { PERSONAL_PRIVATE_HEADERS, parsePersonalDashboardId, personalDashboardFrameSelection } from '@/shared/lib/managerDashboardSecurity';
import { personalJson, personalReviewError, personalReviewQuery, requirePersonalReviewAccess } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requirePersonalReviewAccess();
    if (access.denied) return access.denied;
    const query = personalReviewQuery(request, ['manager', 'version', 'snapshot', 'revision']);
    const managerId = parsePersonalDashboardId(query?.get('manager') ?? null);
    const versionId = parsePersonalDashboardId(query?.get('version') ?? null);
    const snapshotId = parsePersonalDashboardId(query?.get('snapshot') ?? null);
    if (!query || !managerId || !versionId || (query.has('snapshot') && !snapshotId)) return personalJson({ error: 'Некорректный отчёт' }, 400);
    const overview = await getPersonalDashboardReviewOverview(access.viewer, managerId);
    if (!overview.selected || overview.htmlVersion?.id !== versionId) return personalJson({ error: 'Отчёт недоступен' }, 404);
    const selection = personalDashboardFrameSelection(overview.selected, snapshotId ?? undefined);
    if (selection.denied) return personalJson({ error: 'Снимок недоступен' }, 404);
    const frame = buildPersonalDashboardReviewFrame({ managerId, versionId, ...selection });
    return new Response(frame.html, { headers: { ...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': frame.csp } });
  } catch (error) { return personalReviewError(error); }
}
