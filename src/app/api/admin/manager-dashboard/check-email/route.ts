import { MANAGER_DASHBOARD_MAIL_DISABLED_MESSAGE } from '@/shared/lib/managerDashboardMail';
import { personalApiError, personalJson, requirePersonalAccess } from '../_shared';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const access = await requirePersonalAccess(request, true);
    if (access.denied) return access.denied;
    return personalJson({error: MANAGER_DASHBOARD_MAIL_DISABLED_MESSAGE, code: 'MANUAL_UPLOAD_ONLY'}, 410);
  } catch (error) { return personalApiError(error); }
}
