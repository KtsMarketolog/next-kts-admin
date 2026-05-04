import { randomUUID } from 'crypto';

import { getAdminSession } from '@/shared/lib/adminAuth';
import { getPublicWholesalePriceList, query, recordWholesalePriceView } from '@/shared/lib/db';

type Context = {
  params: Promise<{ token: string }>;
};

const SESSION_COOKIE = 'kts_price_analytics_sid';
const SESSION_MAX_AGE = 60 * 60 * 24 * 365;

function getHeaderIp(headersList: Headers) {
  const forwardedFor = headersList.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwardedFor || headersList.get('x-real-ip') || 'unknown';
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get('cookie') || '';
  return cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function sessionCookie(value: string) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_MAX_AGE}; SameSite=Lax; Secure; HttpOnly`;
}

export async function POST(request: Request, context: Context) {
  const { token } = await context.params;
  const priceList = await getPublicWholesalePriceList(token);
  if (!priceList) return Response.json({ error: 'Not found' }, { status: 404 });

  const existingSessionId = cookieValue(request, SESSION_COOKIE);
  const sessionId = existingSessionId || randomUUID();
  const adminSession = await getAdminSession();
  const actorType = adminSession?.role === 'manager' ? 'manager' : adminSession ? 'admin' : 'client';
  const actorUserId = adminSession?.role === 'manager' ? adminSession.managerId : null;

  const previous = await query<{ count: string }>(
    `select count(*)::text as count
     from wholesale_analytics_events
     where price_list_id = $1
       and session_id = $2
       and event_type in ('public_price_opened', 'public_price_reopened')`,
    [priceList.id, sessionId],
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

  return Response.json(
    { ok: true },
    existingSessionId
      ? undefined
      : {
          headers: {
            'Set-Cookie': sessionCookie(sessionId),
          },
        },
  );
}
