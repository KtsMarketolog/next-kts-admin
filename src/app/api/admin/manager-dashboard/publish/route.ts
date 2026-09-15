import { activatePersonalDashboardHtml } from '@/shared/lib/db/managerDashboardRepo';
import { readPersonalRequestBytes } from '@/shared/lib/managerDashboardSecurity';
import { parsePersonalDashboardAudience } from '@/shared/lib/managerDashboardAudience';
import { personalApiError, personalJson, requirePersonalAccess } from '../_shared';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const access = await requirePersonalAccess(request, true);
    if (access.denied) return access.denied;
    const bytes = await readPersonalRequestBytes(request, 2048);
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
    catch { return personalJson({error: 'Некорректный JSON запроса'}, 400); }
    if (!body || !Number.isSafeInteger(body.versionId) || body.versionId <= 0 ||
      !(body.expectedActiveVersionId === null || (Number.isSafeInteger(body.expectedActiveVersionId) && body.expectedActiveVersionId > 0))) {
      return personalJson({error: 'Некорректные версии HTML'}, 400);
    }
    const audience = parsePersonalDashboardAudience(body.audience);
    if (!audience) return personalJson({error: 'Выберите группу менеджеров для публикации'}, 400);
    const result = await activatePersonalDashboardHtml({versionId: body.versionId, expectedActiveVersionId: body.expectedActiveVersionId, actorId: access.actorId, audience});
    return personalJson({result});
  } catch (error) { return personalApiError(error); }
}
