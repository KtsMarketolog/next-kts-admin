import { getSupportSharedDashboardHtml, getSupportSharedDashboardOverview } from '@/shared/lib/db/supportSharedDashboardRepo';
import { buildSupportSharedDashboardFrame } from '@/shared/lib/managerDashboardHtml';
import { PERSONAL_PRIVATE_HEADERS, parsePersonalDashboardId } from '@/shared/lib/managerDashboardSecurity';
import { personalApiError, personalJson } from '../../_shared';
import { requireSharedAccess, sharedQuery } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requireSharedAccess();
    if (access.denied) return access.denied;
    const query = sharedQuery(request, ['version', 'snapshot', 'preview', 'revision']);
    const versionId = parsePersonalDashboardId(query?.get('version') ?? null);
    const snapshotId = parsePersonalDashboardId(query?.get('snapshot') ?? null);
    if (!query || !versionId || (query.has('snapshot') && !snapshotId)) return personalJson({error: 'Некорректная версия'}, 400);
    const preview = query.get('preview') === '1';
    if ((preview && access.mode !== 'manage') || (!preview && access.mode !== 'view') || (preview && snapshotId)) return personalJson({error: 'Нет доступа'}, 403);
    const version = await getSupportSharedDashboardHtml(versionId, preview, access.manager?.id);
    if (!version) return personalJson({error: 'Версия HTML недоступна'}, 404);
    let selectedId: number | undefined;
    let emptyState: 'no_snapshot' | 'expired' | undefined;
    if (!preview) {
      const overview = await getSupportSharedDashboardOverview(access.manager!.id);
      const selected = snapshotId ? overview.history.find((item) => item.id === snapshotId) : overview.snapshot;
      if (snapshotId && !selected) return personalJson({error: 'Снимок недоступен'}, 404);
      if (!selected) emptyState = 'no_snapshot';
      else if (selected.expired) emptyState = 'expired';
      else selectedId = selected.id;
    }
    const frame = buildSupportSharedDashboardFrame({versionId, preview, snapshotId: selectedId, emptyState});
    return new Response(frame.html, {headers: {...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': frame.csp}});
  } catch (error) { return personalApiError(error); }
}
