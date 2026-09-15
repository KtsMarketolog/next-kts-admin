import { getPersonalDashboardHtml, getPersonalDashboardStatus } from '@/shared/lib/db/managerDashboardRepo';
import { buildPersonalDashboardFrame } from '@/shared/lib/managerDashboardHtml';
import { PERSONAL_PRIVATE_HEADERS, parsePersonalDashboardId, personalDashboardFrameSelection } from '@/shared/lib/managerDashboardSecurity';
import { personalApiError, personalJson, personalRequestAudience, requirePersonalAccess } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requirePersonalAccess();
    if (access.denied) return access.denied;
    const query = new URL(request.url).searchParams;
    const versionId = parsePersonalDashboardId(query.get('version'));
    const snapshotId = parsePersonalDashboardId(query.get('snapshot'));
    const preview = query.get('preview') === '1';
    if (!versionId || (query.has('snapshot') && !snapshotId)) return personalJson({error: 'Некорректная версия'}, 400);
    if ((preview && access.mode !== 'manage') || (!preview && access.mode !== 'view')) return personalJson({error: 'Нет доступа'}, 403);
    const audience = personalRequestAudience(request, access);
    if (!audience) return personalJson({error: 'HTML этой группы недоступен'}, 403);
    const status = access.mode === 'view' && access.manager ? await getPersonalDashboardStatus(access.manager.id) : null;
    if (status && status.audience !== audience) return personalJson({error: 'Группа менеджера изменилась. Обновите кабинет.'}, 403);
    const version = await getPersonalDashboardHtml(versionId, preview, audience);
    if (!version) return personalJson({error: 'Версия HTML недоступна'}, 404);
    const selection = status ? personalDashboardFrameSelection(status, snapshotId ?? undefined) : {};
    if (selection.denied) return personalJson({error: 'Снимок недоступен'}, 404);
    const frame = buildPersonalDashboardFrame({versionId, preview, audience, ...selection});
    return new Response(frame.html, {headers: {...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': frame.csp}});
  } catch (error) { return personalApiError(error); }
}
