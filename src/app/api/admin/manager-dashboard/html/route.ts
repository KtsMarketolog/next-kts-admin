import { readTopDashboardHtmlUpload } from '../../top-dashboard/blocks/routeUtils';
import { createPersonalDashboardHtml, deletePersonalDashboardHtml } from '@/shared/lib/db/managerDashboardRepo';
import { isPersonalDashboardHtml } from '@/shared/lib/managerDashboardHtml';
import { readPersonalRequestBytes } from '@/shared/lib/managerDashboardSecurity';
import { parsePersonalDashboardAudience } from '@/shared/lib/managerDashboardAudience';
import { personalApiError, personalJson, requirePersonalAccess } from '../_shared';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const access = await requirePersonalAccess(request, true);
    if (access.denied) return access.denied;
    const params = new URL(request.url).searchParams;
    const audience = params.getAll('audience').length === 1 ? parsePersonalDashboardAudience(params.get('audience')) : null;
    if (!audience) return personalJson({error: 'Выберите группу менеджеров для HTML'}, 400);
    const bytes = await readPersonalRequestBytes(request, 5 * 1024 * 1024 + 256 * 1024);
    const copy = new Request(request.url, {method: 'POST', headers: request.headers, body: bytes as Uint8Array<ArrayBuffer>});
    const result = await readTopDashboardHtmlUpload(copy);
    if (result.error) return result.error;
    if (!isPersonalDashboardHtml(result.upload.htmlContent)) {
      return personalJson({error: 'Нужен HTML личного дашборда продаж с контрактом kts-personal v1 (совместим с v12). Общий TOP-дашборд сюда не подходит.'}, 400);
    }
    const version = await createPersonalDashboardHtml({...result.upload, actorId: access.actorId, audience});
    return personalJson({version}, 201);
  } catch (error) { return personalApiError(error); }
}

export async function DELETE(request: Request) {
  try {
    const access = await requirePersonalAccess(request, true);
    if (access.denied) return access.denied;
    const params = new URL(request.url).searchParams;
    const audience = params.getAll('audience').length === 1 ? parsePersonalDashboardAudience(params.get('audience')) : null;
    const id = params.get('id') ?? '';
    const versionId = Number(id);
    if (!audience || params.getAll('id').length !== 1 || [...params.keys()].some((key) => key !== 'id' && key !== 'audience')
      || !/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(versionId)) {
      return personalJson({error: 'Укажите группу и HTML-версию для удаления'}, 400);
    }
    return personalJson(await deletePersonalDashboardHtml({ versionId, audience, actorId: access.actorId }));
  } catch (error) { return personalApiError(error); }
}
