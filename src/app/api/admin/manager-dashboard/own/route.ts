import { getPersonalDashboardHtml, getPersonalDashboardStatus } from '@/shared/lib/db/managerDashboardRepo';
import { personalDashboardFreshness } from '@/shared/lib/managerDashboardSecurity';
import { personalApiError, personalJson, personalOwnQuery, requireOwnPersonalAccess } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requireOwnPersonalAccess();
    if (access.denied) return access.denied;
    if (!personalOwnQuery(request, [])) return personalJson({ error: 'Некорректные параметры' }, 400);
    const status = await getPersonalDashboardStatus(access.recipient);
    const html = await getPersonalDashboardHtml(undefined, false, 'development');
    return personalJson({ mode: 'view', ...status, recipientKey: `admin:${access.recipient.id}`, ...personalDashboardFreshness(status.snapshot),
      htmlVersion: html ? { id: html.id, originalName: html.originalName, audience: html.audience, firstPublishedAt: html.firstPublishedAt } : null });
  } catch (error) { return personalApiError(error); }
}
