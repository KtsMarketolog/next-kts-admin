import { NextRequest, NextResponse } from 'next/server';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const OLD_HOSTS = new Set(['t-kts.ru', 'www.t-kts.ru']);
const PRIMARY_HOST = 'kts-impex.ru';

function isSameOrigin(request: NextRequest) {
  const forwardedHost = request.headers.get('x-forwarded-host') || request.headers.get('host');
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const requestOrigins = new Set([
    request.nextUrl.origin,
    forwardedHost && forwardedProto ? `${forwardedProto}://${forwardedHost}` : null,
  ].filter(Boolean) as string[]);
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');

  if (origin) {
    try {
      return requestOrigins.has(new URL(origin).origin);
    } catch {
      return false;
    }
  }

  if (referer) {
    try {
      return requestOrigins.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }

  return true;
}

export function proxy(request: NextRequest) {
  const host = (request.headers.get('x-forwarded-host') || request.headers.get('host') || '').split(':')[0].toLowerCase();
  if (OLD_HOSTS.has(host)) {
    const url = request.nextUrl.clone();
    url.protocol = 'https:';
    url.host = PRIMARY_HOST;
    return NextResponse.redirect(url, 301);
  }

  if (request.nextUrl.pathname.startsWith('/api/admin/') && MUTATING_METHODS.has(request.method) && !isSameOrigin(request)) {
    return NextResponse.json({ error: 'Forbidden origin' }, { status: 403 });
  }

  const response = NextResponse.next();
  if (request.nextUrl.pathname.startsWith('/admin') || request.nextUrl.pathname.startsWith('/api/admin/')) {
    response.headers.set('Cache-Control', 'private, no-store');
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
};
