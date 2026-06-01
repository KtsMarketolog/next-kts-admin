import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { hashPassword, requireWholesaleAdminSession } from '@/shared/lib/adminAuth';
import { deleteWholesaleManager, revokeManagerSessions, updateWholesaleManager } from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { getClientIp } from '@/shared/lib/rateLimit';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';

type Context = {
  params: Promise<{ id: string }>;
};

export async function PUT(request: Request, context: Context) {
  const { denied, session } = await requireWholesaleAdminSession();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(session, 'manager_update', 80);
  if (limited) return limited;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const name = normalizeTextField(body.name, 120);
  const login = normalizeTextField(body.login, 80);
  const email = normalizeTextField(body.email, 160);
  const phone = normalizeTextField(body.phone, 60);
  const password = typeof body.password === 'string' ? body.password : '';
  const normalizedSupportManagerId = null;

  if (!name || !login) {
    return Response.json({ error: 'Имя и логин обязательны' }, { status: 400 });
  }
  if (password) {
    const passwordPolicy = validatePasswordPolicy(password);
    if (!passwordPolicy.ok) {
      return Response.json({ error: passwordPolicy.error }, { status: 400 });
    }
  }

  try {
    await updateWholesaleManager(numericId, {
      name,
      login,
      email,
      phone,
      supportManagerId: normalizedSupportManagerId,
      passwordHash: password ? hashPassword(password) : undefined,
      displayPassword: password || undefined,
      isActive: Boolean(body.isActive ?? true),
    });
    if (password) {
      await revokeManagerSessions(numericId);
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Не удалось сохранить менеджера' }, { status: 400 });
  }

  await recordSecurityEvent({
    eventType: password ? 'password_changed' : 'manager_updated',
    actorType: session.role === 'admin' ? 'admin' : 'wholesale_admin',
    adminUserId: session.adminUserId,
    sessionId: session.sessionId,
    entityType: 'wholesale_manager',
    entityId: numericId,
    ip: getClientIp(request),
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
    metadata: { login, email, phone, supportManagerId: normalizedSupportManagerId, isActive: Boolean(body.isActive ?? true) },
  });

  return Response.json({ ok: true });
}

export async function DELETE(request: Request, context: Context) {
  const { denied, session } = await requireWholesaleAdminSession();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(session, 'manager_delete', 30);
  if (limited) return limited;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  await deleteWholesaleManager(numericId);
  await recordSecurityEvent({
    eventType: 'manager_deleted',
    actorType: session.role === 'admin' ? 'admin' : 'wholesale_admin',
    adminUserId: session.adminUserId,
    sessionId: session.sessionId,
    entityType: 'wholesale_manager',
    entityId: numericId,
    ip: getClientIp(request),
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
  });
  return Response.json({ ok: true });
}
