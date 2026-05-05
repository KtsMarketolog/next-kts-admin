import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { hashPassword, requireAdminSession } from '@/shared/lib/adminAuth';
import {
  deleteAccessUser,
  revokeAdminUserSessions,
  revokeManagerSessions,
  updateAccessUser,
  type AccessUserRole,
} from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { getClientIp } from '@/shared/lib/rateLimit';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';

const ACCESS_ROLES = new Set<AccessUserRole>(['admin', 'wholesale_admin', 'manager']);

type Context = {
  params: Promise<{ id: string }>;
};

function normalizeRole(value: unknown): AccessUserRole | null {
  return typeof value === 'string' && ACCESS_ROLES.has(value as AccessUserRole) ? (value as AccessUserRole) : null;
}

function badRequest(error: string, status = 400) {
  return Response.json({ error }, { status });
}

async function revokePreviousSessions(source: 'admin' | 'manager', numericId: number) {
  if (source === 'admin') {
    await revokeAdminUserSessions(numericId);
    return;
  }
  await revokeManagerSessions(numericId);
}

export async function PUT(request: Request, context: Context) {
  const { denied, session } = await requireAdminSession();
  if (denied) return denied;
  if (!session.adminUserId) return badRequest('Требуется вход под учетной записью администратора', 403);
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(session, 'access_user_update', 80);
  if (limited) return limited;

  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const name = normalizeTextField(body.name, 120);
  const login = normalizeTextField(body.login, 80).toLowerCase();
  const email = normalizeTextField(body.email, 160);
  const password = typeof body.password === 'string' ? body.password : '';
  const role = normalizeRole(body.role);
  const isActive = typeof body.isActive === 'boolean' ? body.isActive : true;

  if (!name || !login || !role) {
    return badRequest('Имя, логин и роль обязательны');
  }
  if (password) {
    const passwordPolicy = validatePasswordPolicy(password);
    if (!passwordPolicy.ok) {
      return badRequest(passwordPolicy.error || 'Пароль не подходит');
    }
  }

  try {
    const result = await updateAccessUser(
      id,
      {
        name,
        login,
        email,
        role,
        isActive,
        passwordHash: password ? hashPassword(password) : undefined,
      },
      session.adminUserId,
    );

    if (result.roleChanged || result.passwordChanged || result.previous.isActive !== result.user.isActive) {
      await revokePreviousSessions(result.previous.source, result.previous.numericId);
    }

    await recordSecurityEvent({
      eventType: 'admin_user_updated',
      actorType: 'admin',
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'access_user',
      entityId: result.user.id,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        previousId: result.previous.id,
        previousRole: result.previous.role,
        role: result.user.role,
        previousSource: result.previous.source,
        source: result.user.source,
        login: result.user.login,
        email: result.user.email,
        roleChanged: result.roleChanged,
        passwordChanged: result.passwordChanged,
        isActive: result.user.isActive,
      },
    });

    if (result.passwordChanged) {
      await recordSecurityEvent({
        eventType: 'password_changed',
        actorType: 'admin',
        adminUserId: session.adminUserId,
        sessionId: session.sessionId,
        entityType: 'access_user',
        entityId: result.user.id,
        ip: getClientIp(request),
        userAgent: request.headers.get('user-agent'),
        referer: request.headers.get('referer'),
        metadata: { targetLogin: result.user.login, targetRole: result.user.role },
      });
    }

    return Response.json({ user: result.user });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : 'Не удалось сохранить пользователя');
  }
}

export async function DELETE(request: Request, context: Context) {
  const { denied, session } = await requireAdminSession();
  if (denied) return denied;
  if (!session.adminUserId) return badRequest('Требуется вход под учетной записью администратора', 403);
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(session, 'access_user_delete', 30);
  if (limited) return limited;

  const { id } = await context.params;

  try {
    const user = await deleteAccessUser(id, session.adminUserId);
    await revokePreviousSessions(user.source, user.numericId);

    await recordSecurityEvent({
      eventType: 'admin_user_deleted',
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

    return Response.json({ ok: true });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : 'Не удалось удалить пользователя');
  }
}
