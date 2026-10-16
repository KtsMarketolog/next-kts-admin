import { getPersonalDashboardHtml, getPersonalDashboardStatus } from '@/shared/lib/db/managerDashboardRepo';
import { injectPersonalDashboardAdapter, personalHtmlCsp } from '@/shared/lib/managerDashboardHtml';
import { PERSONAL_PRIVATE_HEADERS, parsePersonalDashboardId } from '@/shared/lib/managerDashboardSecurity';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { personalApiError, personalJson, personalOwnQuery, requireOwnPersonalAccess } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requireOwnPersonalAccess();
    if (access.denied) return access.denied;
    const query = personalOwnQuery(request, ['version', 'audience']);
    const versionId = parsePersonalDashboardId(query?.get('version') ?? null);
    if (!query || !versionId) return personalJson({ error: 'Некорректный отчёт' }, 400);
    let referer: URL;
    try { referer = new URL(request.headers.get('referer') || 'https://invalid.example/'); }
    catch { return personalJson({ error: 'HTML доступен только в защищённом просмотре' }, 403); }
    if (enforceSameOriginRequest(request) || referer.pathname !== '/api/admin/manager-dashboard/own/frame'
      || referer.searchParams.get('version') !== String(versionId)) {
      return personalJson({ error: 'HTML доступен только в защищённом просмотре' }, 403);
    }
    // Recheck active account/role even when loading HTML without a snapshot.
    await getPersonalDashboardStatus(access.recipient);
    const version = await getPersonalDashboardHtml(versionId, false, 'development');
    if (!version) return personalJson({ error: 'Опубликованный HTML недоступен' }, 404);
    const html = injectPersonalDashboardAdapter(version.htmlContent);
    return new Response(html, { headers: { ...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': personalHtmlCsp(html), 'X-DNS-Prefetch-Control': 'off', 'Referrer-Policy': 'no-referrer' } });
  } catch (error) { return personalApiError(error); }
}
