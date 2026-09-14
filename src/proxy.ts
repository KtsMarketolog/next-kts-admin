import { NextRequest, NextResponse } from 'next/server';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PRIVATE_CACHE_PREFIXES = ['/admin', '/cabinet', '/login', '/price'];
const PRIVATE_API_PREFIXES = ['/api/admin', '/api/client', '/api/price'];
const X_ROBOTS_TAG_PRIVATE = 'noindex, nofollow, noarchive';
const FIRMWARE_PUBLIC_ROOT = '/klimatika/prog/firmware/update';
const FIRMWARE_DOWNLOAD_PATHS = new Set([
  `${FIRMWARE_PUBLIC_ROOT}/hse/gen_1/hse_gen_1.c23`,
  `${FIRMWARE_PUBLIC_ROOT}/hse/gen_1/hse_gen_1.ver`,
]);

function matchesPathPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function normalizedPathSegments(pathname: string) {
  const parts: string[] = [];
  for (const part of pathname.replace(/\\/g, '/').split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function blocksFirmwareStoragePath(pathname: string) {
  if (FIRMWARE_DOWNLOAD_PATHS.has(pathname)) return false;
  let decoded = pathname;
  // Static lookup and upstream URL parsers can decode separators or dot segments.
  // Decode ASCII escapes even beside malformed UTF-8; never let malformed suffixes
  // hide an otherwise recognizable protected prefix. Work is strictly bounded.
  for (let depth = 0; depth < 8; depth += 1) {
    const slashes = decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
    if (matchesPathPrefix(slashes, FIRMWARE_PUBLIC_ROOT)
      || matchesPathPrefix(normalizedPathSegments(slashes), FIRMWARE_PUBLIC_ROOT)) return true;
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === decoded) return false;
    decoded = next;
  }
  // Excessively nested encodings are not canonical public paths.
  return true;
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
  // The firmware backup tree also contains private staging, history and state.
  // Only the two canonical URLs may proceed to their beforeFiles rewrites.
  if (blocksFirmwareStoragePath(request.nextUrl.pathname)) {
    return new NextResponse(null, {
      status: 404,
      headers: {
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': X_ROBOTS_TAG_PRIVATE,
      },
    });
  }
  // This application does not expose Server Actions. Rejecting the header in
  // the lightweight proxy prevents stale clients and automated probes from
  // reaching React's comparatively expensive action decoder.
  if (request.headers.has('next-action')) {
    return new NextResponse(null, {
      status: 404,
      headers: {
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': X_ROBOTS_TAG_PRIVATE,
      },
    });
  }

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
  matcher: [
    {
      source: '/:path*',
      has: [{ type: 'header', key: 'next-action' }],
    },
    {
      source: '/api/admin/top-dashboard/blocks/:blockId/data',
      missing: [{ type: 'header', key: 'x-kts-top-data-upload', value: '1' }],
    },
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|api/admin/top-dashboard/blocks/[^/]+/data/?$).*)',
  ],
};
