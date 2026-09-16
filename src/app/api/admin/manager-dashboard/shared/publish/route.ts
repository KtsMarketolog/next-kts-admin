import { activateSupportSharedDashboardHtml } from '@/shared/lib/db/supportSharedDashboardRepo';
import { readPersonalRequestBytes } from '@/shared/lib/managerDashboardSecurity';
import { personalApiError, personalJson } from '../../_shared';
import { requireSharedAccess, sharedQuery } from '../_shared';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const access = await requireSharedAccess(request, true);
    if (access.denied) return access.denied;
    if (!sharedQuery(request, [])) return personalJson({error: 'Некорректные параметры'}, 400);
    const bytes = await readPersonalRequestBytes(request, 2048);
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
    catch { return personalJson({error: 'Некорректный JSON запроса'}, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['versionId', 'expectedActiveVersionId'].includes(key))
      || !Number.isSafeInteger(body.versionId) || body.versionId <= 0
      || !(body.expectedActiveVersionId === null || (Number.isSafeInteger(body.expectedActiveVersionId) && body.expectedActiveVersionId > 0))) {
      return personalJson({error: 'Некорректные версии HTML'}, 400);
    }
    const result = await activateSupportSharedDashboardHtml({versionId: body.versionId, expectedActiveVersionId: body.expectedActiveVersionId, actorId: access.actorId});
    return personalJson({result});
  } catch (error) { return personalApiError(error); }
}
