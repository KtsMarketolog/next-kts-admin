import { importManagerDashboardFromEmail } from '@/shared/lib/managerDashboardMail';
import { personalApiError, personalJson, requirePersonalAccess } from '../_shared';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const access = await requirePersonalAccess(request, true);
    if (access.denied) return access.denied;
    return personalJson(await importManagerDashboardFromEmail());
  } catch (error) { return personalApiError(error); }
}
