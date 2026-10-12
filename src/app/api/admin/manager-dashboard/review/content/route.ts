import { getPersonalDashboardReviewHtml } from '@/shared/lib/db/managerDashboardRepo';
import { injectPersonalDashboardAdapter, personalHtmlCsp } from '@/shared/lib/managerDashboardHtml';
import { PERSONAL_PRIVATE_HEADERS, parsePersonalDashboardId } from '@/shared/lib/managerDashboardSecurity';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { personalJson, personalReviewError, personalReviewQuery, requirePersonalReviewAccess } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requirePersonalReviewAccess();
    if (access.denied) return access.denied;
    const query = personalReviewQuery(request, ['manager', 'version']);
    const managerId = parsePersonalDashboardId(query?.get('manager') ?? null);
    const versionId = parsePersonalDashboardId(query?.get('version') ?? null);
    if (!query || !managerId || !versionId) return personalJson({ error: 'Некорректный отчёт' }, 400);
    let referer: URL;
    try { referer = new URL(request.headers.get('referer') || 'https://invalid.example/'); }
    catch { return personalJson({ error: 'HTML доступен только в защищённом просмотре' }, 403); }
    if (enforceSameOriginRequest(request) || referer.pathname !== '/api/admin/manager-dashboard/review/frame'
      || referer.searchParams.get('manager') !== String(managerId) || referer.searchParams.get('version') !== String(versionId)) {
      return personalJson({ error: 'HTML доступен только в защищённом просмотре' }, 403);
    }
    const source = await getPersonalDashboardReviewHtml(access.viewer, managerId, versionId);
    if (!source) return personalJson({ error: 'Опубликованный HTML недоступен' }, 404);
    const html = injectPersonalDashboardAdapter(source);
    return new Response(html, { headers: { ...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': personalHtmlCsp(html), 'X-DNS-Prefetch-Control': 'off', 'Referrer-Policy': 'no-referrer' } });
  } catch (error) { return personalReviewError(error); }
}
