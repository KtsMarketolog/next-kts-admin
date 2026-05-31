import { createClientSession } from '@/shared/lib/clientAuth';
import { verifyPassword } from '@/shared/lib/adminAuth';
import { getClientUserByLogin, recordClientUserLogin } from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import {
  createTwoFactorChallenge,
  consumeTwoFactorChallenge,
  generateTwoFactorCode,
} from '@/shared/lib/db/twoFactorRepo';
import { sendSystemMail } from '@/shared/lib/mailer';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { LOGIN_SESSION_COOKIE, applySessionCookie, getOrCreateSessionCookie, type SessionCookieState } from '@/shared/lib/publicSession';
import { checkDbRateLimit, getClientIp, resetDbRateLimit } from '@/shared/lib/rateLimit';

const LOGIN_LIMIT = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function withSessionCookie(response: Response, sessionCookie: SessionCookieState) {
  applySessionCookie(response.headers, sessionCookie);
  return response;
}

function maskEmail(email: string) {
  const [name, domain] = email.split('@');
  if (!name || !domain) return '';
  return `${name.slice(0, 2)}***@${domain}`;
}

async function sendClientTwoFactorCode(email: string, code: string) {
  await sendSystemMail({
    to: email,
    subject: 'KTS: код подтверждения входа',
    text: `Код подтверждения входа: ${code}. Он действует 10 минут.`,
    html: `<p>Код подтверждения входа:</p><p style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</p><p>Код действует 10 минут.</p>`,
  });
}

async function finishClientLogin(input: {
  login: string;
  clientUserId: number;
  request: Request;
  ip: string;
}) {
  const { login, clientUserId, request, ip } = input;
  const user = await getClientUserByLogin(login);
  if (!user?.isActive || !user.companyIsActive || user.id !== clientUserId) {
    return Response.json({ error: 'Invalid session' }, { status: 401 });
  }

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
    metadata: { companyId: user.companyId, companyTitle: user.companyTitle, twoFactor: true },
  });

  return Response.json({ ok: true });
}

export async function POST(request: Request) {
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const ip = getClientIp(request);
  const loginSession = getOrCreateSessionCookie(request, LOGIN_SESSION_COOKIE);
  const body = await request.json().catch(() => ({}));
  const login = typeof body.login === 'string' ? body.login.trim().toLowerCase().slice(0, 180) : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const twoFactorChallengeId = typeof body.twoFactorChallengeId === 'string' ? body.twoFactorChallengeId : '';
  const twoFactorCode = typeof body.twoFactorCode === 'string' ? body.twoFactorCode.trim() : '';
  const rateLimitKey = `client-login:${login || twoFactorChallengeId || 'empty'}:${ip || 'unknown'}`;
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
    return withSessionCookie(
      Response.json(
        { error: 'Too many login attempts' },
        { status: 429, headers: { 'Retry-After': String(loginRateLimit.retryAfter) } },
      ),
      loginSession,
    );
  }

  if (twoFactorChallengeId || twoFactorCode) {
    const actor = await consumeTwoFactorChallenge({
      challengeId: twoFactorChallengeId,
      loginSessionId: loginSession.sessionId,
      code: twoFactorCode,
    });

    if (!actor || actor.actorType !== 'client' || !actor.clientUserId) {
      await recordSecurityEvent({
        eventType: 'two_factor_failed',
        actorType: 'client',
        login,
        ip,
        userAgent: request.headers.get('user-agent'),
        referer: request.headers.get('referer'),
      });
      return withSessionCookie(Response.json({ error: 'Invalid code' }, { status: 401 }), loginSession);
    }

    const response = await finishClientLogin({
      login: actor.login,
      clientUserId: actor.clientUserId,
      request,
      ip,
    });
    return withSessionCookie(response, loginSession);
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
    return withSessionCookie(Response.json({ error: 'Invalid password' }, { status: 401 }), loginSession);
  }

  await resetDbRateLimit(rateLimitKey);

  if (user.requireTwoFactor) {
    const email = user.email || user.login;
    if (!email || !email.includes('@')) {
      return withSessionCookie(Response.json({ error: 'Client email is not configured' }, { status: 500 }), loginSession);
    }

    const code = generateTwoFactorCode();
    const challengeId = await createTwoFactorChallenge({
      login: user.login,
      actorType: 'client',
      role: 'client',
      clientUserId: user.id,
      loginSessionId: loginSession.sessionId,
      code,
    });
    await sendClientTwoFactorCode(email, code);
    await recordSecurityEvent({
      eventType: 'two_factor_challenge_created',
      actorType: 'client',
      login: user.login,
      entityType: 'client_user',
      entityId: user.id,
      ip,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { companyId: user.companyId, companyTitle: user.companyTitle, email: maskEmail(email) },
    });

    return withSessionCookie(
      Response.json({
        ok: false,
        twoFactorRequired: true,
        challengeId,
        email: maskEmail(email),
      }),
      loginSession,
    );
  }

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
    metadata: { companyId: user.companyId, companyTitle: user.companyTitle, twoFactor: false },
  });

  return withSessionCookie(Response.json({ ok: true }), loginSession);
}
