import { getPersonalDashboardReviewSnapshot } from '@/shared/lib/db/managerDashboardRepo';
import { PERSONAL_PRIVATE_HEADERS, parsePersonalDashboardId } from '@/shared/lib/managerDashboardSecurity';
import { personalJson, personalReviewError, personalReviewQuery, requirePersonalReviewAccess } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requirePersonalReviewAccess();
    if (access.denied) return access.denied;
    const query = personalReviewQuery(request, ['manager', 'snapshot']);
    const managerId = parsePersonalDashboardId(query?.get('manager') ?? null);
    const snapshotId = parsePersonalDashboardId(query?.get('snapshot') ?? null);
    if (!query || !managerId || (query.has('snapshot') && !snapshotId)) return personalJson({ error: 'Некорректный снимок' }, 400);
    const snapshot = await getPersonalDashboardReviewSnapshot(access.viewer, managerId, snapshotId ?? undefined);
    if (!snapshot) return personalJson({ error: 'Снимок не найден или недоступен' }, 404);
    return new Response(new Uint8Array(snapshot.bytes), { headers: { ...PERSONAL_PRIVATE_HEADERS,
      'Content-Type': 'application/octet-stream', 'Content-Length': String(snapshot.bytes.length),
      'Content-Disposition': 'attachment; filename="personal-snapshot.ktsp"',
      'X-Personal-Email': encodeURIComponent(snapshot.email), 'X-Personal-Filename': encodeURIComponent(snapshot.originalName) } });
  } catch (error) { return personalReviewError(error); }
}
