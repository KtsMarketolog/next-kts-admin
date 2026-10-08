import { requireDashboardAccessManagementSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { validDashboardKey } from '@/shared/lib/dashboardPermissions';
import { DashboardAudienceForbiddenError, getDashboardAudience, setDashboardAudience } from '@/shared/lib/db/dashboardAccessRepo';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { readPersonalRequestBytes } from '@/shared/lib/managerDashboardSecurity';

const headers = { 'Cache-Control': 'private, no-store' };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { denied, session } = await requireDashboardAccessManagementSession();
  if (denied) return denied;
  const key = new URL(request.url).searchParams.get('key');
  if (!validDashboardKey(key)) return Response.json({ error: 'Некорректный дашборд' }, { status: 400, headers });
  try {
    return Response.json(await getDashboardAudience(key, session.role === 'admintop' ? 'admintop' : 'admin'), { headers });
  } catch {
    return Response.json({ error: 'Не удалось загрузить доступы сотрудников' }, { status: 400, headers });
  }
}

export async function PUT(request: Request) {
  const { denied, session } = await requireDashboardAccessManagementSession();
  if (denied) return denied;
  const origin = enforceSameOriginRequest(request);
  if (origin) return origin;
  const limited = await enforceAdminActionRateLimit(session, 'dashboard_access_update', 60);
  if (limited) return limited;
  if (Number(request.headers.get('content-length')) > 128 * 1024) return Response.json({ error: 'Слишком большой список' }, { status: 413, headers });
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(await readPersonalRequestBytes(request, 128 * 1024)));
  } catch {
    return Response.json({ error: 'Некорректный или слишком большой запрос' }, { status: 400, headers });
  }
  if (!body || !validDashboardKey(body.key) || typeof body.version !== 'string' || !/^[a-f0-9]{64}$/.test(body.version)
    || (body.mode !== undefined && body.mode !== 'individual' && body.mode !== 'all')
    || !Array.isArray(body.userIds) || body.userIds.length > 5000 || body.userIds.some((id: unknown) => typeof id !== 'string' || !/^(admin|manager):[1-9]\d{0,15}$/.test(id))) {
    return Response.json({ error: 'Некорректные доступы сотрудников' }, { status: 400, headers });
  }
  try {
    const data = await setDashboardAudience(body.key, body.userIds, body.version, body.mode ?? 'individual', session.role === 'admintop' ? 'admintop' : 'admin');
    await recordSecurityEvent({
      eventType: 'dashboard_access_updated',
      actorType: session.role,
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'dashboard',
      entityId: body.key,
      metadata: { selectedUserIds: body.userIds, audienceMode: data.mode },
    });
    return Response.json(data, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Не удалось сохранить доступы' }, { status: error instanceof DashboardAudienceForbiddenError ? 403 : 409, headers });
  }
}
