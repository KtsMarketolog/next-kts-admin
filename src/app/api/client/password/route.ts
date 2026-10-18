import { createClientSession, requireClientSession } from '@/shared/lib/clientAuth';
import { hashPassword, verifyPassword } from '@/shared/lib/adminAuth';
import {
  getClientUserPasswordHash,
  updateClientUserPassword,
} from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { getClientIp } from '@/shared/lib/rateLimit';
import { LoginCredentialsChangedError } from '@/shared/lib/loginCredentialProof';

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

  let credentialProof: string;
  try {
    credentialProof = await updateClientUserPassword(session.clientUserId, hashPassword(nextPassword), nextPassword, currentHash);
  } catch (error) {
    if (error instanceof LoginCredentialsChangedError) return Response.json({ error: 'Пароль уже изменён. Войдите заново.' }, { status: 409 });
    throw error;
  }
  await createClientSession(session.clientUserId, {
    credentialProof,
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
