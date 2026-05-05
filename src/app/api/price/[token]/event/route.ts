import { getAdminSession } from '@/shared/lib/adminAuth';
import { getPublicWholesalePriceList, trackAnalyticsEvent, type AnalyticsEventType } from '@/shared/lib/db';
import { PUBLIC_PRICE_SESSION_COOKIE, applySessionCookie, getOrCreateSessionCookie } from '@/shared/lib/publicSession';
import { checkDbRateLimit } from '@/shared/lib/rateLimit';

type Context = {
  params: Promise<{ token: string }>;
};

const EVENT_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const EVENT_SESSION_LIMIT = 120;
const EVENT_GLOBAL_LIMIT = 4000;
const MAX_BODY_BYTES = 16 * 1024;

const allowedEvents = new Set<AnalyticsEventType>([
  'public_price_phone_clicked',
  'public_price_email_clicked',
  'public_price_product_opened',
  'public_price_search_used',
  'public_price_filter_used',
  'public_price_request_started',
  'public_price_quantity_changed',
  'public_price_request_abandoned',
]);

function getHeaderIp(headersList: Headers) {
  const forwardedFor = headersList.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwardedFor || headersList.get('x-real-ip') || 'unknown';
}

function cleanString(value: unknown, maxLength = 160) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function cleanNumber(value: unknown, max = 999999) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.floor(number), max) : null;
}

function cleanMetadata(input: unknown) {
  if (!input || typeof input !== 'object') return {};
  const source = input as Record<string, unknown>;
  return {
    productId: cleanNumber(source.productId),
    productTitle: cleanString(source.productTitle, 220),
    priceItemId: cleanNumber(source.priceItemId),
    quantity: cleanNumber(source.quantity, 999),
    selectedItems: cleanNumber(source.selectedItems, 100),
    totalQuantity: cleanNumber(source.totalQuantity, 99999),
    source: cleanString(source.source, 80),
  };
}

export async function POST(request: Request, context: Context) {
  const publicSession = getOrCreateSessionCookie(request, PUBLIC_PRICE_SESSION_COOKIE);
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    const response = Response.json({ ok: false, error: 'BODY_TOO_LARGE' }, { status: 413 });
    applySessionCookie(response.headers, publicSession);
    return response;
  }

  const { token } = await context.params;
  const priceList = await getPublicWholesalePriceList(token);
  if (!priceList) {
    const response = Response.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
    applySessionCookie(response.headers, publicSession);
    return response;
  }

  const [sessionLimit, globalLimit] = await Promise.all([
    checkDbRateLimit(`public_price_event:token:${priceList.token}:session:${publicSession.sessionId}`, EVENT_SESSION_LIMIT, EVENT_LIMIT_WINDOW_MS),
    checkDbRateLimit('public_price_event:global', EVENT_GLOBAL_LIMIT, EVENT_LIMIT_WINDOW_MS),
  ]);

  if (!sessionLimit.allowed || !globalLimit.allowed) {
    const retryAfter = Math.max(sessionLimit.retryAfter, globalLimit.retryAfter);
    const response = Response.json(
      { ok: false, error: 'TOO_MANY_EVENTS' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
    applySessionCookie(response.headers, publicSession);
    return response;
  }

  const body = await request.json().catch(() => null);
  const eventType = cleanString(body && typeof body === 'object' ? (body as Record<string, unknown>).eventType : null) as AnalyticsEventType;
  if (!allowedEvents.has(eventType)) {
    const response = Response.json({ ok: false, error: 'INVALID_EVENT' }, { status: 400 });
    applySessionCookie(response.headers, publicSession);
    return response;
  }

  const adminSession = await getAdminSession();
  const actorType = adminSession?.role === 'manager' ? 'manager' : adminSession ? 'admin' : 'client';
  const actorUserId = adminSession?.role === 'manager' ? adminSession.managerId : adminSession?.adminUserId ?? null;

  await trackAnalyticsEvent({
    eventType,
    actorType,
    actorUserId,
    managerId: priceList.managerId,
    clientId: priceList.clientName ? priceList.clientName.trim().toLowerCase() : null,
    priceListId: priceList.id,
    token: priceList.token,
    sessionId: publicSession.sessionId,
    ip: getHeaderIp(request.headers),
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
    metadata: cleanMetadata(body && typeof body === 'object' ? (body as Record<string, unknown>).metadata : null),
  });

  const response = Response.json({ ok: true });
  applySessionCookie(response.headers, publicSession);
  return response;
}
