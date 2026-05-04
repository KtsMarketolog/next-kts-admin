import { randomUUID } from 'crypto';

export const PUBLIC_PRICE_SESSION_COOKIE = 'kts_price_analytics_sid';
export const LOGIN_SESSION_COOKIE = 'kts_login_sid';

const DEFAULT_MAX_AGE = 60 * 60 * 24 * 180;
const SESSION_PATTERN = /^[a-zA-Z0-9_-]{16,128}$/;

export type SessionCookieState = {
  sessionId: string;
  setCookie: string | null;
};

export function getCookieValue(request: Request, name: string) {
  const cookie = request.headers.get('cookie') || '';
  return cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function buildSessionCookie(name: string, value: string, maxAge = DEFAULT_MAX_AGE) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}; HttpOnly`;
}

export function getOrCreateSessionCookie(request: Request, name: string): SessionCookieState {
  const existing = getCookieValue(request, name);
  if (existing && SESSION_PATTERN.test(existing)) {
    return { sessionId: existing, setCookie: null };
  }

  const sessionId = randomUUID();
  return {
    sessionId,
    setCookie: buildSessionCookie(name, sessionId),
  };
}

export function applySessionCookie(headers: Headers, state: SessionCookieState) {
  if (state.setCookie) headers.set('Set-Cookie', state.setCookie);
}
