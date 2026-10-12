import { getAdminSession, isManagerSessionRole } from '@/shared/lib/adminAuth';
import { query, recordWholesalePriceView } from '@/shared/lib/db';
import { getPublicWholesalePriceTelemetry, normalizePublicWholesalePriceToken } from '@/shared/lib/db/wholesalePriceTelemetryRepo';
import { PUBLIC_PRICE_SESSION_COOKIE, applySessionCookie, getOrCreateSessionCookie } from '@/shared/lib/publicSession';
import { checkDbRateLimit } from '@/shared/lib/rateLimit';

type Context = {
  params: Promise<{ token: string }>;
};

const VIEW_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const VIEW_SESSION_LIMIT = 30;
const VIEW_GLOBAL_LIMIT = 1500;

function getHeaderIp(headersList: Headers) {
  const forwardedFor = headersList.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwardedFor || headersList.get('x-real-ip') || 'unknown';
}

export async function POST(request: Request, context: Context) {
  const { token } = await context.params;
  const normalizedToken = normalizePublicWholesalePriceToken(token);
  if (!normalizedToken) return Response.json({ error: 'Not found' }, { status: 404 });

  const publicSession = getOrCreateSessionCookie(request, PUBLIC_PRICE_SESSION_COOKIE);
  const sessionId = publicSession.sessionId;
  const [sessionLimit, globalLimit] = await Promise.all([
    checkDbRateLimit(`public_price:token:${normalizedToken}:session:${sessionId}`, VIEW_SESSION_LIMIT, VIEW_LIMIT_WINDOW_MS),
    checkDbRateLimit('public_price:global', VIEW_GLOBAL_LIMIT, VIEW_LIMIT_WINDOW_MS),
  ]);

  if (!sessionLimit.allowed || !globalLimit.allowed) {
    const response = Response.json({ ok: true, limited: true });
    applySessionCookie(response.headers, publicSession);
    return response;
  }

  const priceList = await getPublicWholesalePriceTelemetry(normalizedToken);
  if (!priceList) return Response.json({ error: 'Not found' }, { status: 404 });

  const adminSession = await getAdminSession();
  const actorType = isManagerSessionRole(adminSession?.role) ? 'manager' : adminSession ? 'admin' : 'client';
  const actorUserId = isManagerSessionRole(adminSession?.role) ? adminSession?.managerId : null;

  const previous = await query<{ count: string }>(
    `select count(*)::text as count
     from wholesale_analytics_events
     where price_list_id = $1
       and session_id = $2
       and actor_type = $3
       and event_type in ('public_price_opened', 'public_price_reopened')`,
    [priceList.id, sessionId, actorType],
  ).catch(() => ({ rows: [{ count: '0' }] }));

  await recordWholesalePriceView(priceList.id, priceList.token, {
    ip: getHeaderIp(request.headers),
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
    sessionId,
    actorType,
    actorUserId,
    managerId: priceList.managerId,
    clientName: priceList.clientName,
    reopened: Number(previous.rows[0]?.count ?? 0) > 0,
  }).catch((error) => {
    console.error('Failed to record wholesale price view', error);
  });

  const response = Response.json({ ok: true });
  applySessionCookie(response.headers, publicSession);
  return response;
}
