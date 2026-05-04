import { createAdminSession, createEmployeeSession, validateAdminPassword, verifyPassword } from '@/shared/lib/adminAuth';
import { getAdminUserByLogin, getWholesaleManagerByLogin, recordWholesaleManagerLogin, trackAnalyticsEvent } from '@/shared/lib/db';
import { checkRateLimit, getClientIp, getRateLimitStatus, resetRateLimit } from '@/shared/lib/rateLimit';

const LOGIN_LIMIT = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function tooManyAttempts(retryAfter: number) {
  return Response.json(
    { error: 'Too many login attempts' },
    {
      status: 429,
      headers: { 'Retry-After': String(retryAfter) },
    },
  );
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const rateLimitKey = `admin-login:${ip}`;
  const rateLimit = getRateLimitStatus(rateLimitKey, LOGIN_LIMIT);
  if (!rateLimit.allowed) {
    return tooManyAttempts(rateLimit.retryAfter);
  }

  const body = await request.json().catch(() => ({}));
  const login = typeof body.login === 'string' ? body.login.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const adminUser = login ? await getAdminUserByLogin(login) : null;
  if (adminUser?.isActive && adminUser.passwordHash && verifyPassword(password, adminUser.passwordHash)) {
    resetRateLimit(rateLimitKey);
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
    return Response.json({ ok: true, role: adminUser.role });
  }

  if (validateAdminPassword(password)) {
    resetRateLimit(rateLimitKey);
    await createAdminSession();
    await trackAnalyticsEvent({
      eventType: 'manager_login',
      actorType: 'admin',
      ip,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { role: 'admin' },
    });
    return Response.json({ ok: true, role: 'admin' });
  }

  const manager = login ? await getWholesaleManagerByLogin(login) : null;
  if (!manager?.isActive || !manager.passwordHash || !verifyPassword(password, manager.passwordHash)) {
    const failedRateLimit = checkRateLimit(rateLimitKey, LOGIN_LIMIT, LOGIN_WINDOW_MS);
    if (!failedRateLimit.allowed) {
      return tooManyAttempts(failedRateLimit.retryAfter);
    }
    return Response.json({ error: 'Invalid password' }, { status: 401 });
  }

  resetRateLimit(rateLimitKey);
  await createEmployeeSession({ role: 'manager', managerId: manager.id });
  await recordWholesaleManagerLogin(manager.id, {
    ip,
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
    actorType: 'manager',
  }).catch((error) => {
    console.error('Failed to record manager login', error);
  });
  return Response.json({ ok: true, role: 'manager' });
}
