import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { hashPassword, requireDashboardAccessManagementSession } from '@/shared/lib/adminAuth';
import { AccessUserManagementError, assertAccessUserManagementAllowed, DashboardOptionsConflictError } from '@/shared/lib/accessUserManagement';
import { createAccessUser, getAccessUsers, type AccessUserRole } from '@/shared/lib/db';
import { parseDashboardAccess } from '@/shared/lib/dashboardAccess';
import { dashboardGrantOptionsVersion, getDashboardGrantOptions } from '@/shared/lib/db/dashboardAccessRepo';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { getClientIp } from '@/shared/lib/rateLimit';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';

const ACCESS_ROLES = new Set<AccessUserRole>(['admin', 'wholesale_admin', 'manager', 'support_manager', 'top', 'admintop', 'purchaser']);

function normalizeRole(value: unknown): AccessUserRole | null {
  return typeof value === 'string' && ACCESS_ROLES.has(value as AccessUserRole) ? (value as AccessUserRole) : null;
}

function badRequest(error: string, status = 400) {
  return Response.json({ error }, { status });
}

function normalizeSupportManagerId(role: AccessUserRole, value: unknown) {
  if (role !== 'manager') return null;
  const numericId = Number(value);
  return Number.isInteger(numericId) && numericId > 0 ? numericId : null;
}

export async function GET() {
  const { denied, session } = await requireDashboardAccessManagementSession();
  if (denied) return denied;

  const [users, dashboardOptions] = await Promise.all([
    getAccessUsers(session.adminUserId ?? null, session.role),
    getDashboardGrantOptions(),
  ]);
  return Response.json({ users, dashboardOptions, dashboardOptionsVersion: dashboardGrantOptionsVersion(dashboardOptions), canManageSiteAdmins: session.role === 'admin' }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function POST(request: Request) {
  const { denied, session } = await requireDashboardAccessManagementSession();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(session, 'access_user_create', 40);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const name = normalizeTextField(body.name, 120);
  const login = normalizeTextField(body.login, 80).toLowerCase();
  const email = normalizeTextField(body.email, 160);
  const password = typeof body.password === 'string' ? body.password : '';
  const role = normalizeRole(body.role);
  if (role === 'admin' && session.role !== 'admin') return badRequest('Создание администратора сайта недоступно', 403);
  const dashboardAccess = body.dashboardAccess === undefined ? undefined : parseDashboardAccess(body.dashboardAccess);
  if (dashboardAccess === null) return badRequest('Некорректный список доступных дашбордов');
  const dashboardOptionsVersion = typeof body.dashboardOptionsVersion === 'string' && /^[a-f0-9]{64}$/.test(body.dashboardOptionsVersion)
    ? body.dashboardOptionsVersion : undefined;
  if (dashboardAccess !== undefined && !dashboardOptionsVersion) return badRequest(new DashboardOptionsConflictError().message, 409);
  const isActive = typeof body.isActive === 'boolean' ? body.isActive : true;
  if (body.canManageTopDashboard !== undefined && typeof body.canManageTopDashboard !== 'boolean') {
    return badRequest('Некорректное значение доступа «Админ TOP»');
  }

  if (!name || !login || !password || !role) {
    if (!role) return badRequest('Некорректная роль пользователя');
    return badRequest('Имя, логин и пароль обязательны');
  }

  const supportManagerId = normalizeSupportManagerId(role, body.supportManagerId);
  const canManageTopDashboard = role === 'top' && body.canManageTopDashboard === true;

  const passwordPolicy = validatePasswordPolicy(password);
  if (!passwordPolicy.ok) {
    return badRequest(passwordPolicy.error || 'Пароль не подходит');
  }

  try {
    assertAccessUserManagementAllowed(session.role, role);
    const user = await createAccessUser({
      name,
      login,
      email,
      role,
      isActive,
      canManageTopDashboard,
      dashboardAccess,
      dashboardOptionsVersion,
      supportManagerId,
      passwordHash: hashPassword(password),
    }, session.role);

    await recordSecurityEvent({
      eventType: 'admin_user_created',
      actorType: session.role,
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'access_user',
      entityId: user.id,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        login: user.login,
        email: user.email,
        role: user.role,
        source: user.source,
        canManageTopDashboard: user.canManageTopDashboard,
        dashboardAccess: user.dashboardAccess,
      },
    });

    return Response.json({ user });
  } catch (error) {
    if (error instanceof AccessUserManagementError) return badRequest(error.message, 403);
    if (error instanceof DashboardOptionsConflictError) return badRequest(error.message, 409);
    return badRequest(error instanceof Error ? error.message : 'Не удалось добавить пользователя');
  }
}
