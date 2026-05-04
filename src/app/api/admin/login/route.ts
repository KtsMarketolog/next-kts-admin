import { createAdminSession, createEmployeeSession, validateAdminPassword, verifyPassword } from '@/shared/lib/adminAuth';
import { getAdminUserByLogin, getWholesaleManagerByLogin, recordWholesaleManagerLogin, trackAnalyticsEvent } from '@/shared/lib/db';
import { LOGIN_SESSION_COOKIE, applySessionCookie, getOrCreateSessionCookie, type SessionCookieState } from '@/shared/lib/publicSession';
import { checkDbRateLimit, getClientIp, resetDbRateLimit } from '@/shared/lib/rateLimit';

const LOGIN_LIMIT = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_LOGIN_LIMIT = 250;

function withSessionCookie(response: Response, sessionCookie: SessionCookieState) {
  applySessionCookie(response.headers, sessionCookie);
  return response;
}

function tooManyAttempts(retryAfter: number, sessionCookie: SessionCookieState) {
  return withSessionCookie(Response.json(
    { error: 'Too many login attempts' },
    {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    },
  ), sessionCookie);
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const loginSession = getOrCreateSessionCookie(request, LOGIN_SESSION_COOKIE);

  const body = await request.json().catch(() => ({}));
  const login = typeof body.login === 'string' ? body.login.trim().toLowerCase().slice(0, 160) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const rateLimitKey = `login:${login || 'empty'}:session:${loginSession.sessionId}`;
  const [loginRateLimit, globalRateLimit] = await Promise.all([
    checkDbRateLimit(rateLimitKey, LOGIN_LIMIT, LOGIN_WINDOW_MS),
    checkDbRateLimit('login:global', GLOBAL_LOGIN_LIMIT, LOGIN_WINDOW_MS),
  ]);

  if (!loginRateLimit.allowed) {
    return tooManyAttempts(loginRateLimit.retryAfter, loginSession);
  }

  if (!globalRateLimit.allowed) {
    return tooManyAttempts(globalRateLimit.retryAfter, loginSession);
  }

  const adminUser = login ? await getAdminUserByLogin(login) : null;
  if (adminUser?.isActive && adminUser.passwordHash && verifyPassword(password, adminUser.passwordHash)) {
    await resetDbRateLimit(rateLimitKey);
    await createAdminSession(adminUser.role);
    await trackAnalyticsEvent({
      eventType: 'manager_login',
      actorType: 'admin',
      actorUserId: adminUser.id,
      ip,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { role: adminUser.role, login: adminUser.login },
    });
    return withSessionCookie(Response.json({ ok: true, role: adminUser.role }), loginSession);
  }

  if (validateAdminPassword(password)) {
    await resetDbRateLimit(rateLimitKey);
    await createAdminSession();
    await trackAnalyticsEvent({
      eventType: 'manager_login',
      actorType: 'admin',
      ip,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { role: 'admin' },
    });
    return withSessionCookie(Response.json({ ok: true, role: 'admin' }), loginSession);
  }

  const manager = login ? await getWholesaleManagerByLogin(login) : null;
  if (!manager?.isActive || !manager.passwordHash || !verifyPassword(password, manager.passwordHash)) {
    return withSessionCookie(Response.json({ error: 'Invalid password' }, { status: 401 }), loginSession);
  }

  await resetDbRateLimit(rateLimitKey);
  await createEmployeeSession({ role: 'manager', managerId: manager.id });
  await recordWholesaleManagerLogin(manager.id, {
    ip,
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
    actorType: 'manager',
  }).catch((error) => {
    console.error('Failed to record manager login', error);
  });
  return withSessionCookie(Response.json({ ok: true, role: 'manager' }), loginSession);
}
