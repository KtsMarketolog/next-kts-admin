import { NextRequest, NextResponse } from 'next/server';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PRIVATE_CACHE_PREFIXES = ['/admin', '/cabinet', '/login', '/price'];
const PRIVATE_API_PREFIXES = ['/api/admin', '/api/client', '/api/price'];
const X_ROBOTS_TAG_PRIVATE = 'noindex, nofollow, noarchive';

function matchesPathPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isPrivatePagePath(pathname: string) {
  return PRIVATE_CACHE_PREFIXES.some((prefix) => matchesPathPrefix(pathname, prefix));
}

function isApiPath(pathname: string) {
  return matchesPathPrefix(pathname, '/api');
}

function isPrivateApiPath(pathname: string) {
  return PRIVATE_API_PREFIXES.some((prefix) => matchesPathPrefix(pathname, prefix));
}

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
  if (
    (request.nextUrl.pathname.startsWith('/api/admin/') || request.nextUrl.pathname.startsWith('/api/client/')) &&
    MUTATING_METHODS.has(request.method) &&
    !isSameOrigin(request)
  ) {
    return NextResponse.json({ error: 'Forbidden origin' }, { status: 403 });
  }

  const response = NextResponse.next();
  if (
    isPrivatePagePath(request.nextUrl.pathname) ||
    isPrivateApiPath(request.nextUrl.pathname)
  ) {
    response.headers.set('Cache-Control', 'private, no-store');
  }
  if (isPrivatePagePath(request.nextUrl.pathname) || isApiPath(request.nextUrl.pathname)) {
    response.headers.set('X-Robots-Tag', X_ROBOTS_TAG_PRIVATE);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)'],
};
