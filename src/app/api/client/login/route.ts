import { createClientSession } from '@/shared/lib/clientAuth';
import { verifyPassword } from '@/shared/lib/adminAuth';
import { getClientUserByLogin, recordClientUserLogin } from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { checkDbRateLimit, getClientIp, resetDbRateLimit } from '@/shared/lib/rateLimit';

const LOGIN_LIMIT = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export async function POST(request: Request) {
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const ip = getClientIp(request);
  const body = await request.json().catch(() => ({}));
  const login = typeof body.login === 'string' ? body.login.trim().toLowerCase().slice(0, 180) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const rateLimitKey = `client-login:${login || 'empty'}:${ip || 'unknown'}`;
  const loginRateLimit = await checkDbRateLimit(rateLimitKey, LOGIN_LIMIT, LOGIN_WINDOW_MS);

  if (!loginRateLimit.allowed) {
    await recordSecurityEvent({
      eventType: 'login_rate_limited',
      actorType: 'client',
      login,
      ip,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
    });
    return Response.json(
      { error: 'Too many login attempts' },
      { status: 429, headers: { 'Retry-After': String(loginRateLimit.retryAfter) } },
    );
  }

  const user = login ? await getClientUserByLogin(login) : null;
  if (!user?.isActive || !user.companyIsActive || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
    await recordSecurityEvent({
      eventType: 'login_failed',
      actorType: 'client',
      login,
      ip,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
    });
    return Response.json({ error: 'Invalid password' }, { status: 401 });
  }

  await resetDbRateLimit(rateLimitKey);
  await createClientSession(user.id, {
    ip,
    userAgent: request.headers.get('user-agent'),
  });
  await recordClientUserLogin(user.id);
  await recordSecurityEvent({
    eventType: 'login_success',
    actorType: 'client',
    login: user.login,
    entityType: 'client_user',
    entityId: user.id,
    ip,
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
    metadata: { companyId: user.companyId, companyTitle: user.companyTitle },
  });

  return Response.json({ ok: true });
}
