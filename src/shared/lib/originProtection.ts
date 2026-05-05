function allowedOrigins(request: Request) {
  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers.get('x-forwarded-host') || request.headers.get('host');
  const forwardedProto = request.headers.get('x-forwarded-proto') || requestUrl.protocol.replace(':', '');
  return new Set([
    requestUrl.origin,
    forwardedHost ? `${forwardedProto}://${forwardedHost}` : '',
  ].filter(Boolean));
}

function headerOrigin(value: string | null) {
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
}

export function enforceSameOriginRequest(request: Request) {
  const origin = headerOrigin(request.headers.get('origin'));
  const referer = headerOrigin(request.headers.get('referer'));
  const candidate = origin || referer;
  if (candidate && allowedOrigins(request).has(candidate)) return null;

  return Response.json({ error: 'Forbidden origin' }, { status: 403 });
}
