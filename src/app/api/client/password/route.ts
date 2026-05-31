import { createClientSession, requireClientSession } from '@/shared/lib/clientAuth';
import { hashPassword, verifyPassword } from '@/shared/lib/adminAuth';
import {
  getClientUserPasswordHash,
  revokeClientUserSessions,
  updateClientUserPassword,
} from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { getClientIp } from '@/shared/lib/rateLimit';

export async function PUT(request: Request) {
  const { denied, session } = await requireClientSession();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const body = await request.json().catch(() => ({}));
  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
  const nextPassword = typeof body.nextPassword === 'string' ? body.nextPassword : '';
  const currentHash = await getClientUserPasswordHash(session.clientUserId);

  if (!currentHash || !verifyPassword(currentPassword, currentHash)) {
    return Response.json({ error: 'Неверный текущий пароль' }, { status: 400 });
  }

  const passwordPolicy = validatePasswordPolicy(nextPassword);
  if (!passwordPolicy.ok) {
    return Response.json({ error: passwordPolicy.error || 'Пароль не подходит' }, { status: 400 });
  }

  await updateClientUserPassword(session.clientUserId, hashPassword(nextPassword), nextPassword);
  await revokeClientUserSessions(session.clientUserId);
  await createClientSession(session.clientUserId, {
    ip: getClientIp(request),
    userAgent: request.headers.get('user-agent'),
  });
  await recordSecurityEvent({
    eventType: 'password_changed',
    actorType: 'client',
    entityType: 'client_user',
    entityId: session.clientUserId,
    ip: getClientIp(request),
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
  });

  return Response.json({ ok: true });
}
