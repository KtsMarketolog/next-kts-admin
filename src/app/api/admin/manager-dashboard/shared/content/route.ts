import { getSupportSharedDashboardHtml } from '@/shared/lib/db/supportSharedDashboardRepo';
import { injectPersonalDashboardAdapter, personalHtmlCsp } from '@/shared/lib/managerDashboardHtml';
import { PERSONAL_PRIVATE_HEADERS, parsePersonalDashboardId } from '@/shared/lib/managerDashboardSecurity';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { personalApiError, personalJson } from '../../_shared';
import { requireSharedAccess, sharedQuery } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requireSharedAccess();
    if (access.denied) return access.denied;
    const query = sharedQuery(request, ['version', 'preview']);
    const versionId = parsePersonalDashboardId(query?.get('version') ?? null);
    if (!query || !versionId) return personalJson({error: 'Некорректная версия HTML'}, 400);
    const preview = query.get('preview') === '1';
    if ((preview && access.mode !== 'manage') || (!preview && access.mode !== 'view')) return personalJson({error: 'Нет доступа'}, 403);
    let referer: URL;
    try { referer = new URL(request.headers.get('referer') || ''); }
    catch { return personalJson({error: 'HTML доступен только в защищённом просмотре'}, 403); }
    const refererRequest = new Request(request.url, {headers: request.headers});
    refererRequest.headers.delete('origin');
    if (enforceSameOriginRequest(request) || enforceSameOriginRequest(refererRequest)
      || referer.pathname !== '/api/admin/manager-dashboard/shared/frame'
      || referer.searchParams.getAll('version').length !== 1 || referer.searchParams.get('version') !== String(versionId)
      || (referer.searchParams.get('preview') === '1') !== preview) {
      return personalJson({error: 'HTML доступен только в защищённом просмотре'}, 403);
    }
    const version = await getSupportSharedDashboardHtml(versionId, preview, access.manager?.id);
    if (!version) return personalJson({error: 'Версия HTML недоступна'}, 404);
    const html = injectPersonalDashboardAdapter(version.htmlContent, 'support_shared');
    return new Response(html, {headers: {...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': personalHtmlCsp(html), 'X-DNS-Prefetch-Control': 'off', 'Referrer-Policy': 'no-referrer'}});
  } catch (error) { return personalApiError(error); }
}
