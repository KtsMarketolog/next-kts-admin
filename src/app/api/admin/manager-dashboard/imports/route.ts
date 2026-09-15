import { listPersonalDashboardImports } from '@/shared/lib/db/managerDashboardRepo';
import { isPersonalDashboardImportCursor } from '@/shared/lib/managerDashboardImportPagination';

import { personalApiError, personalJson, requirePersonalAccess } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requirePersonalAccess(request, true);
    if (access.denied) return access.denied;
    const params = new URL(request.url).searchParams;
    const before = params.get('before');
    if ([...params.keys()].some((key) => key !== 'before') || params.getAll('before').length > 1
      || (before !== null && !isPersonalDashboardImportCursor(before))) {
      return personalJson({ error: 'Некорректные параметры страницы журнала импорта' }, 400);
    }
    return personalJson(await listPersonalDashboardImports(before));
  } catch (error) {
    return personalApiError(error);
  }
}
