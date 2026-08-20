import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { hashPassword, requireAdminSession } from '@/shared/lib/adminAuth';
import { createAccessUser, getAccessUsers, type AccessUserRole } from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { getClientIp } from '@/shared/lib/rateLimit';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';

const ACCESS_ROLES = new Set<AccessUserRole>(['admin', 'wholesale_admin', 'manager', 'support_manager', 'top']);

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
  const { denied, session } = await requireAdminSession();
  if (denied) return denied;
  if (!session.adminUserId) return badRequest('Требуется вход под учетной записью администратора', 403);

  const users = await getAccessUsers(session.adminUserId);
  return Response.json({ users });
}

export async function POST(request: Request) {
  const { denied, session } = await requireAdminSession();
  if (denied) return denied;
  if (!session.adminUserId) return badRequest('Требуется вход под учетной записью администратора', 403);
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
  const isActive = typeof body.isActive === 'boolean' ? body.isActive : true;

  if (!name || !login || !password || !role) {
    if (!role) return badRequest('Некорректная роль пользователя');
    return badRequest('Имя, логин и пароль обязательны');
  }

  const supportManagerId = normalizeSupportManagerId(role, body.supportManagerId);

  const passwordPolicy = validatePasswordPolicy(password);
  if (!passwordPolicy.ok) {
    return badRequest(passwordPolicy.error || 'Пароль не подходит');
  }

  try {
    const user = await createAccessUser({
      name,
      login,
      email,
      role,
      isActive,
      supportManagerId,
      passwordHash: hashPassword(password),
    });

    await recordSecurityEvent({
      eventType: 'admin_user_created',
      actorType: 'admin',
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'access_user',
      entityId: user.id,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { login: user.login, email: user.email, role: user.role, source: user.source },
    });

    return Response.json({ user });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : 'Не удалось добавить пользователя');
  }
}
