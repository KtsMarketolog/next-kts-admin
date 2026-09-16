import { createSupportSharedDashboardHtml, deleteSupportSharedDashboardHtml } from '@/shared/lib/db/supportSharedDashboardRepo';
import { isPersonalDashboardHtml } from '@/shared/lib/managerDashboardHtml';
import { parsePersonalDashboardId, readPersonalRequestBytes } from '@/shared/lib/managerDashboardSecurity';
import { readTopDashboardHtmlUpload } from '../../../top-dashboard/blocks/routeUtils';
import { personalApiError, personalJson } from '../../_shared';
import { requireSharedAccess, sharedQuery } from '../_shared';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const access = await requireSharedAccess(request, true);
    if (access.denied) return access.denied;
    if (!sharedQuery(request, [])) return personalJson({error: 'Некорректные параметры'}, 400);
    const bytes = await readPersonalRequestBytes(request, 5 * 1024 * 1024 + 256 * 1024);
    const result = await readTopDashboardHtmlUpload(new Request(request.url, {method: 'POST', headers: request.headers, body: bytes as Uint8Array<ArrayBuffer>}));
    if (result.error) return result.error;
    if (!isPersonalDashboardHtml(result.upload.htmlContent)) {
      return personalJson({error: 'Нужен совместимый HTML с контрактом kts-personal v1, как для личных дашбордов'}, 400);
    }
    const version = await createSupportSharedDashboardHtml({...result.upload, actorId: access.actorId});
    return personalJson({version}, 201);
  } catch (error) { return personalApiError(error); }
}

export async function DELETE(request: Request) {
  try {
    const access = await requireSharedAccess(request, true);
    if (access.denied) return access.denied;
    const query = sharedQuery(request, ['id']);
    const versionId = parsePersonalDashboardId(query?.get('id') ?? null);
    if (!query || !versionId) return personalJson({error: 'Укажите HTML-версию для удаления'}, 400);
    return personalJson(await deleteSupportSharedDashboardHtml({versionId, actorId: access.actorId}));
  } catch (error) { return personalApiError(error); }
}
