import { getPersonalDashboardHtml } from '@/shared/lib/db/managerDashboardRepo';
import { injectPersonalDashboardAdapter, personalHtmlCsp } from '@/shared/lib/managerDashboardHtml';
import { PERSONAL_PRIVATE_HEADERS, parsePersonalDashboardId } from '@/shared/lib/managerDashboardSecurity';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { personalApiError, personalJson, requirePersonalAccess } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requirePersonalAccess();
    if (access.denied) return access.denied;
    const query = new URL(request.url).searchParams;
    const versionId = parsePersonalDashboardId(query.get('version'));
    const preview = query.get('preview') === '1';
    if (!versionId) return personalJson({error: 'Некорректная версия HTML'}, 400);
    if ((preview && access.mode !== 'manage') || (!preview && access.mode !== 'view')) return personalJson({error: 'Нет доступа'}, 403);
    const referer = new URL(request.headers.get('referer') || 'https://invalid.example/');
    if (enforceSameOriginRequest(request) || referer.pathname !== '/api/admin/manager-dashboard/frame' || referer.searchParams.get('version') !== String(versionId)) {
      return personalJson({error: 'HTML доступен только в защищённом просмотре'}, 403);
    }
    const version = await getPersonalDashboardHtml(versionId, preview);
    if (!version) return personalJson({error: 'Версия HTML недоступна'}, 404);
    const html = injectPersonalDashboardAdapter(version.htmlContent);
    return new Response(html, {headers: {...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': personalHtmlCsp(html), 'X-DNS-Prefetch-Control': 'off', 'Referrer-Policy': 'no-referrer'}});
  } catch (error) { return personalApiError(error); }
}
