import { getPersonalDashboardHtml, getPersonalDashboardStatus } from '@/shared/lib/db/managerDashboardRepo';
import { buildPersonalDashboardOwnFrame } from '@/shared/lib/managerDashboardHtml';
import { PERSONAL_PRIVATE_HEADERS, parsePersonalDashboardId, personalDashboardFrameSelection } from '@/shared/lib/managerDashboardSecurity';
import { personalApiError, personalJson, personalOwnQuery, requireOwnPersonalAccess } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requireOwnPersonalAccess();
    if (access.denied) return access.denied;
    const query = personalOwnQuery(request, ['version', 'snapshot', 'audience', 'revision']);
    const versionId = parsePersonalDashboardId(query?.get('version') ?? null);
    const snapshotId = parsePersonalDashboardId(query?.get('snapshot') ?? null);
    if (!query || !versionId || (query.has('snapshot') && !snapshotId)) return personalJson({ error: 'Некорректный отчёт' }, 400);
    const status = await getPersonalDashboardStatus(access.recipient);
    const version = await getPersonalDashboardHtml(versionId, false, 'development');
    if (!version) return personalJson({ error: 'Опубликованный HTML недоступен' }, 404);
    const selection = personalDashboardFrameSelection(status, snapshotId ?? undefined);
    if (selection.denied) return personalJson({ error: 'Снимок недоступен' }, 404);
    const frame = buildPersonalDashboardOwnFrame({ versionId, ...selection });
    return new Response(frame.html, { headers: { ...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': frame.csp } });
  } catch (error) { return personalApiError(error); }
}
