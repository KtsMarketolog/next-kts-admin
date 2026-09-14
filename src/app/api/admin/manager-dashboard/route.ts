import { getPersonalDashboardHtml, getPersonalDashboardStatus, listPersonalDashboardAdmin } from '@/shared/lib/db/managerDashboardRepo';
import { getManagerDashboardMailStatus } from '@/shared/lib/managerDashboardMail';
import { personalDashboardFreshness } from '@/shared/lib/managerDashboardSecurity';
import { personalApiError, personalJson, requirePersonalAccess } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const access = await requirePersonalAccess();
    if (access.denied) return access.denied;
    if (access.mode === 'manage') {
      const overview = await listPersonalDashboardAdmin();
      return personalJson({mode: 'manage', ...overview, expectedBy: '10:00 МСК',
        managers: overview.managers.map((manager) => ({...manager, ...personalDashboardFreshness(manager.snapshot)})),
        mail: getManagerDashboardMailStatus()});
    }
    const status = await getPersonalDashboardStatus(access.manager!.id);
    const html = await getPersonalDashboardHtml();
    return personalJson({mode: 'view', ...status, ...personalDashboardFreshness(status.snapshot),
      email: access.manager!.email.trim().toLowerCase(), htmlVersion: html ? {id: html.id, originalName: html.originalName} : null});
  } catch (error) { return personalApiError(error); }
}
