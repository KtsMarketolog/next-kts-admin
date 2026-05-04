import { requireEmployee } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { getWholesalePriceListEditor, trackAnalyticsEvent } from '@/shared/lib/db';

type Context = {
  params: Promise<{ id: string }>;
};

function actorType(role: 'admin' | 'wholesale_admin' | 'manager') {
  return role === 'manager' ? 'manager' : 'admin';
}

export async function POST(request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const limited = await enforceAdminActionRateLimit(session, 'price_public_link_copied', 200);
  if (limited) return limited;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  const priceList = await getWholesalePriceListEditor(numericId, session);
  if (!priceList) return Response.json({ error: 'Not found' }, { status: 404 });

  await trackAnalyticsEvent({
    eventType: 'price_public_link_copied',
    actorType: actorType(session.role),
    actorUserId: session.role === 'manager' ? session.managerId : null,
    managerId: priceList.managerId,
    clientId: priceList.clientName ? priceList.clientName.trim().toLowerCase() : null,
    priceListId: priceList.id,
    token: priceList.token,
    ip: request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip'),
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
    metadata: {
      title: priceList.title,
      clientName: priceList.clientName,
    },
  });

  return Response.json({ ok: true });
}
