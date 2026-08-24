import { createAdminSession, createEmployeeSession, validateAdminPassword, verifyPassword } from '@/shared/lib/adminAuth';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import {
  createTwoFactorChallenge,
  consumeTwoFactorChallenge,
  generateTwoFactorCode,
  isTwoFactorEnabled,
  type TwoFactorChallengeActor,
} from '@/shared/lib/db/twoFactorRepo';
import { getAdminUserByLogin, getWholesaleManagerByLogin, recordWholesaleManagerLogin, trackAnalyticsEvent } from '@/shared/lib/db';
import { sendSystemMail } from '@/shared/lib/mailer';
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

function maskEmail(email: string) {
  const [name, domain] = email.split('@');
  if (!name || !domain) return '';
  return `${name.slice(0, 2)}***@${domain}`;
}

function twoFactorRecipient(email: string | null | undefined) {
  return email || process.env.ADMIN_2FA_EMAIL || process.env.SMTP_TO || '';
}

function challengePredatesPasswordChange(
  challengeCreatedAt: string,
  passwordChangedAt: string | null,
) {
  if (!passwordChangedAt) return false;
  const challengeTime = new Date(challengeCreatedAt).getTime();
  const passwordChangeTime = new Date(passwordChangedAt).getTime();
  return !Number.isFinite(challengeTime)
    || !Number.isFinite(passwordChangeTime)
    || challengeTime < passwordChangeTime;
}

async function sendTwoFactorCode(email: string, code: string) {
  await sendSystemMail({
    to: email,
    subject: 'KTS: код подтверждения входа',
    text: `Код подтверждения входа: ${code}. Он действует 10 минут.`,
    html: `<p>Код подтверждения входа:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>Код действует 10 минут.</p>`,
  });
}

async function finishLogin(input: {
  actor: TwoFactorChallengeActor;
  request: Request;
  ip: string;
}) {
  const { actor, request, ip } = input;
  const userAgent = request.headers.get('user-agent');
  const referer = request.headers.get('referer');

  if (actor.actorType === 'client') {
    return Response.json({ error: 'Invalid session' }, { status: 401 });
  }

  if (actor.actorType === 'manager') {
    if (!actor.managerId) return Response.json({ error: 'Invalid session' }, { status: 401 });
    const currentManager = await getWholesaleManagerByLogin(actor.login);
    if (
      !currentManager?.isActive
      || currentManager.id !== actor.managerId
      || currentManager.login !== actor.login
      || currentManager.role !== actor.role
      || challengePredatesPasswordChange(actor.createdAt, currentManager.passwordChangedAt)
    ) {
      return Response.json({ error: 'Invalid session' }, { status: 401 });
    }
    await createEmployeeSession(
      { role: actor.role, managerId: actor.managerId },
      { ip, userAgent },
    );
    await recordWholesaleManagerLogin(actor.managerId, {
      ip,
      userAgent,
      referer,
      actorType: 'manager',
    }).catch((error) => {
      console.error('Failed to record manager login', error);
    });
    await recordSecurityEvent({
      eventType: 'login_success',
      actorType: 'manager',
      managerId: actor.managerId,
      login: actor.login,
      ip,
      userAgent,
      referer,
      metadata: { role: actor.role, twoFactor: true },
    });
    return Response.json({ ok: true, role: actor.role });
  }

  if ((actor.role === 'top' || actor.role === 'admintop') && !actor.adminUserId) {
    return Response.json({ error: 'Invalid session' }, { status: 401 });
  }
  if (actor.adminUserId) {
    const currentAdminUser = await getAdminUserByLogin(actor.login);
    if (
      !currentAdminUser?.isActive
      || currentAdminUser.id !== actor.adminUserId
      || currentAdminUser.login !== actor.login
      || currentAdminUser.role !== actor.role
      || challengePredatesPasswordChange(actor.createdAt, currentAdminUser.passwordChangedAt)
    ) {
      return Response.json({ error: 'Invalid session' }, { status: 401 });
    }
  }

  await createAdminSession(actor.role, {
    adminUserId: actor.adminUserId,
    ip,
    userAgent,
  });
  await trackAnalyticsEvent({
    eventType: 'manager_login',
    actorType: 'admin',
    actorUserId: actor.adminUserId,
    ip,
    userAgent,
    referer,
    metadata: { role: actor.role, login: actor.login, twoFactor: true },
  });
  await recordSecurityEvent({
    eventType: 'login_success',
    actorType: actor.role,
    adminUserId: actor.adminUserId,
    login: actor.login,
    ip,
    userAgent,
    referer,
    metadata: { twoFactor: true },
  });
  return Response.json({ ok: true, role: actor.role });
}

async function startTwoFactor(input: {
  login: string;
  actorType: 'admin' | 'manager';
  role: 'admin' | 'wholesale_admin' | 'manager' | 'support_manager' | 'top' | 'admintop';
  email: string;
  loginSessionId: string;
  adminUserId?: number | null;
  managerId?: number | null;
  request: Request;
  ip: string;
}) {
  const email = twoFactorRecipient(input.email);
  if (!email) {
    return Response.json({ error: 'Two-factor email is not configured' }, { status: 500 });
  }

  const code = generateTwoFactorCode();
  const challengeId = await createTwoFactorChallenge({
    login: input.login,
    actorType: input.actorType,
    role: input.role,
    adminUserId: input.adminUserId,
    managerId: input.managerId,
    loginSessionId: input.loginSessionId,
    code,
  });
  await sendTwoFactorCode(email, code);
  await recordSecurityEvent({
    eventType: 'two_factor_challenge_created',
    actorType: input.actorType,
    adminUserId: input.adminUserId,
    managerId: input.managerId,
    login: input.login,
    ip: input.ip,
    userAgent: input.request.headers.get('user-agent'),
    referer: input.request.headers.get('referer'),
    metadata: { email: maskEmail(email) },
  });

  return Response.json({
    ok: false,
    twoFactorRequired: true,
    challengeId,
    email: maskEmail(email),
  });
}

export async function POST(request: Request) {
  const ip = getClientIp(request);
  const loginSession = getOrCreateSessionCookie(request, LOGIN_SESSION_COOKIE);

  const body = await request.json().catch(() => ({}));
  const login = typeof body.login === 'string' ? body.login.trim().toLowerCase().slice(0, 160) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const twoFactorChallengeId = typeof body.twoFactorChallengeId === 'string' ? body.twoFactorChallengeId : '';
  const twoFactorCode = typeof body.twoFactorCode === 'string' ? body.twoFactorCode.trim() : '';
  const rateLimitKey = `login:${login || 'empty'}:session:${loginSession.sessionId}`;
  const [loginRateLimit, globalRateLimit] = await Promise.all([
    checkDbRateLimit(rateLimitKey, LOGIN_LIMIT, LOGIN_WINDOW_MS),
    checkDbRateLimit('login:global', GLOBAL_LOGIN_LIMIT, LOGIN_WINDOW_MS),
  ]);

  if (!loginRateLimit.allowed) {
    await recordSecurityEvent({
      eventType: 'login_rate_limited',
      actorType: 'system',
      login,
      ip,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { scope: 'login_session' },
    });
    return tooManyAttempts(loginRateLimit.retryAfter, loginSession);
  }

  if (!globalRateLimit.allowed) {
    await recordSecurityEvent({
      eventType: 'login_rate_limited',
      actorType: 'system',
      login,
      ip,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { scope: 'global' },
    });
    return tooManyAttempts(globalRateLimit.retryAfter, loginSession);
  }

  if (twoFactorChallengeId || twoFactorCode) {
    const actor = await consumeTwoFactorChallenge({
      challengeId: twoFactorChallengeId,
      loginSessionId: loginSession.sessionId,
      code: twoFactorCode,
    });
    if (!actor) {
      await recordSecurityEvent({
        eventType: 'two_factor_failed',
        actorType: 'system',
        login,
        ip,
        userAgent: request.headers.get('user-agent'),
        referer: request.headers.get('referer'),
      });
      return withSessionCookie(Response.json({ error: 'Invalid code' }, { status: 401 }), loginSession);
    }

    const response = await finishLogin({ actor, request, ip });
    return withSessionCookie(response, loginSession);
  }

  const adminUser = login ? await getAdminUserByLogin(login) : null;
  if (adminUser?.isActive && adminUser.passwordHash && verifyPassword(password, adminUser.passwordHash)) {
    await resetDbRateLimit(rateLimitKey);
    if (isTwoFactorEnabled()) {
      const response = await startTwoFactor({
        login: adminUser.login,
        actorType: 'admin',
        role: adminUser.role,
        email: adminUser.email,
        adminUserId: adminUser.id,
        loginSessionId: loginSession.sessionId,
        request,
        ip,
      });
      return withSessionCookie(response, loginSession);
    }

    await createAdminSession(adminUser.role, {
      adminUserId: adminUser.id,
      ip,
      userAgent: request.headers.get('user-agent'),
    });
    await trackAnalyticsEvent({
      eventType: 'manager_login',
      actorType: 'admin',
      actorUserId: adminUser.id,
      ip,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { role: adminUser.role, login: adminUser.login },
    });
    await recordSecurityEvent({
      eventType: 'login_success',
      actorType: adminUser.role,
      adminUserId: adminUser.id,
      login: adminUser.login,
      ip,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { twoFactor: false },
    });
    return withSessionCookie(Response.json({ ok: true, role: adminUser.role }), loginSession);
  }

  if (validateAdminPassword(password)) {
    await resetDbRateLimit(rateLimitKey);
    if (isTwoFactorEnabled()) {
      const response = await startTwoFactor({
        login: login || 'env-admin',
        actorType: 'admin',
        role: 'admin',
        email: process.env.ADMIN_2FA_EMAIL || '',
        loginSessionId: loginSession.sessionId,
        request,
        ip,
      });
      return withSessionCookie(response, loginSession);
    }

    await createAdminSession('admin', {
      ip,
      userAgent: request.headers.get('user-agent'),
    });
    await trackAnalyticsEvent({
      eventType: 'manager_login',
      actorType: 'admin',
      ip,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { role: 'admin' },
    });
    await recordSecurityEvent({
      eventType: 'login_success',
      actorType: 'admin',
      login: login || 'env-admin',
      ip,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { legacyEnvPassword: true, twoFactor: false },
    });
    return withSessionCookie(Response.json({ ok: true, role: 'admin' }), loginSession);
  }

  const manager = login ? await getWholesaleManagerByLogin(login) : null;
  if (!manager?.isActive || !manager.passwordHash || !verifyPassword(password, manager.passwordHash)) {
    await recordSecurityEvent({
      eventType: 'login_failed',
      actorType: 'system',
      login,
      ip,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
    });
    return withSessionCookie(Response.json({ error: 'Invalid password' }, { status: 401 }), loginSession);
  }

  await resetDbRateLimit(rateLimitKey);
  if (isTwoFactorEnabled()) {
    const response = await startTwoFactor({
      login: manager.login,
      actorType: 'manager',
      role: manager.role,
      email: manager.email,
      managerId: manager.id,
      loginSessionId: loginSession.sessionId,
      request,
      ip,
    });
    return withSessionCookie(response, loginSession);
  }

  await createEmployeeSession(
    { role: manager.role, managerId: manager.id },
    { ip, userAgent: request.headers.get('user-agent') },
  );
  await recordWholesaleManagerLogin(manager.id, {
    ip,
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
    actorType: 'manager',
  }).catch((error) => {
    console.error('Failed to record manager login', error);
  });
  await recordSecurityEvent({
    eventType: 'login_success',
    actorType: 'manager',
    managerId: manager.id,
    login: manager.login,
    ip,
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
    metadata: { role: manager.role, twoFactor: false },
  });
  return withSessionCookie(Response.json({ ok: true, role: manager.role }), loginSession);
}
