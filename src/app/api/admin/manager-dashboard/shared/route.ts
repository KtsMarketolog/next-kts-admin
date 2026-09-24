import { getSupportSharedDashboardOverview } from '@/shared/lib/db/supportSharedDashboardRepo';
import { personalApiError, personalJson } from '../_shared';
import { requireSharedAccess } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const access = await requireSharedAccess();
    if (access.denied) return access.denied;
    const supportShared = await getSupportSharedDashboardOverview(access.viewer);
    return personalJson({mode: access.mode, supportShared});
  } catch (error) { return personalApiError(error); }
}
