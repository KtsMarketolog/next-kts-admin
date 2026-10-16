import { getPersonalDashboardSnapshot } from '@/shared/lib/db/managerDashboardRepo';
import { PERSONAL_PRIVATE_HEADERS, parsePersonalDashboardId } from '@/shared/lib/managerDashboardSecurity';
import { personalApiError, personalJson, personalOwnQuery, requireOwnPersonalAccess } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requireOwnPersonalAccess();
    if (access.denied) return access.denied;
    const query = personalOwnQuery(request, ['snapshot']);
    const snapshotId = parsePersonalDashboardId(query?.get('snapshot') ?? null);
    if (!query || (query.has('snapshot') && !snapshotId)) return personalJson({ error: 'Некорректный снимок' }, 400);
    const snapshot = await getPersonalDashboardSnapshot(access.recipient, snapshotId ?? undefined);
    if (!snapshot) return personalJson({ error: 'Снимок не найден или недоступен' }, 404);
    return new Response(new Uint8Array(snapshot.bytes), { headers: { ...PERSONAL_PRIVATE_HEADERS,
      'Content-Type': 'application/octet-stream', 'Content-Length': String(snapshot.bytes.length),
      'Content-Disposition': 'attachment; filename="personal-snapshot.ktsp"',
      'X-Personal-Email': encodeURIComponent(snapshot.email), 'X-Personal-Filename': encodeURIComponent(snapshot.originalName) } });
  } catch (error) { return personalApiError(error); }
}
