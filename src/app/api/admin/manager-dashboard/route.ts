import { getPersonalDashboardHtml, getPersonalDashboardStatus, listPersonalDashboardAdmin } from '@/shared/lib/db/managerDashboardRepo';
import { personalDashboardFreshness } from '@/shared/lib/managerDashboardSecurity';
import { personalApiError, personalJson, requirePersonalAccess } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function freshness(snapshot: Parameters<typeof personalDashboardFreshness>[0]) {
  const {snapshotStatus, todayMoscow} = personalDashboardFreshness(snapshot);
  return {snapshotStatus, todayMoscow};
}

export async function GET() {
  try {
    const access = await requirePersonalAccess();
    if (access.denied) return access.denied;
    if (access.mode === 'manage') {
      const overview = await listPersonalDashboardAdmin();
      return personalJson({mode: 'manage', ...overview,
        groups: overview.groups.map((group) => ({...group,
          managers: group.managers.map((manager) => ({...manager, ...freshness(manager.snapshot)}))})),
        });
    }
    const status = await getPersonalDashboardStatus(access.manager!.id);
    const html = await getPersonalDashboardHtml(undefined, false, status.audience);
    return personalJson({mode: 'view', ...status, ...freshness(status.snapshot),
      email: access.manager!.email.trim().toLowerCase(), htmlVersion: html ? {id: html.id, originalName: html.originalName, audience: html.audience} : null});
  } catch (error) { return personalApiError(error); }
}
