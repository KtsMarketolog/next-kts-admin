import {
  deleteWholesalePriceList,
  getWholesalePriceListEditor,
  updateWholesalePriceList,
  type WholesalePriceListItemInput,
} from '@/shared/lib/db';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireEmployee } from '@/shared/lib/adminAuth';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { getClientIp } from '@/shared/lib/rateLimit';
import { normalizeWholesalePriceWorkflowStatus } from '@/shared/lib/wholesalePriceWorkflowStatus';
import {
  isTokenUnchanged,
  isValidNewPublicPriceToken,
  normalizeOptionalDate,
  normalizePublicPriceToken,
  normalizeTextField,
  normalizeWholesalePrice,
  shortToken,
} from '@/shared/lib/wholesaleSecurity';

type Context = {
  params: Promise<{ id: string }>;
};

const MAX_PRICE_ITEMS = 5000;

function itemsFromBody(items: unknown): WholesalePriceListItemInput[] {
  if (!Array.isArray(items)) return [];
  return items
    .slice(0, MAX_PRICE_ITEMS)
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const source = item as Record<string, unknown>;
      const productId = Number(source.productId);
      if (!Number.isInteger(productId) || productId <= 0) return null;
      const parsedVariantId = source.variantId === null || source.variantId === undefined ? null : Number(source.variantId);
      return {
        productId,
        variantId: parsedVariantId !== null && Number.isInteger(parsedVariantId) && parsedVariantId > 0 ? parsedVariantId : null,
        customWholesalePrice: normalizeWholesalePrice(source.customWholesalePrice),
        visible: Boolean(source.visible),
        sortOrder: Number.isInteger(Number(source.sortOrder)) ? Math.max(0, Number(source.sortOrder)) : index + 1,
      };
    })
    .filter(Boolean) as WholesalePriceListItemInput[];
}

export async function GET(_request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const limited = await enforceAdminActionRateLimit(session, 'price_list_update', 120);
  if (limited) return limited;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  const priceList = await getWholesalePriceListEditor(numericId, session);
  if (!priceList) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json({ priceList });
}

export async function PUT(request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const limited = await enforceAdminActionRateLimit(session, 'price_list_delete', 40);
  if (limited) return limited;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const existing = await getWholesalePriceListEditor(numericId, session);
  if (!existing) return Response.json({ error: 'Not found' }, { status: 404 });

  const title = normalizeTextField(body.title, 160);
  if (!title) return Response.json({ error: 'Title is required' }, { status: 400 });
  const nextToken = normalizePublicPriceToken(body.token);
  if (!nextToken) return Response.json({ error: 'Token is required' }, { status: 400 });
  if (!isTokenUnchanged(existing.token, nextToken) && !isValidNewPublicPriceToken(nextToken)) {
    return Response.json({ error: 'Token must be 24-128 letters, digits, _ or -' }, { status: 400 });
  }
  const validUntil = normalizeOptionalDate(body.validUntil);
  if (typeof body.validUntil === 'string' && body.validUntil.trim() && !validUntil) {
    return Response.json({ error: 'Invalid expiration date' }, { status: 400 });
  }

  await updateWholesalePriceList(
    numericId,
    {
      title,
      clientName: normalizeTextField(body.clientName, 200),
      managerId: Number.isFinite(Number(body.managerId)) ? Number(body.managerId) : null,
      validUntil,
      token: nextToken,
      comment: normalizeTextField(body.comment, 2000),
      workflowStatus: normalizeWholesalePriceWorkflowStatus(body.workflowStatus),
      showRetailPrices: Boolean(body.showRetailPrices),
      showStock: body.showStock !== false,
      isActive: Boolean(body.isActive ?? true),
      items: itemsFromBody(body.items),
    },
    session,
  );

  if (!isTokenUnchanged(existing.token, nextToken)) {
    await recordSecurityEvent({
      eventType: 'price_token_changed',
      actorType: session.role === 'manager' ? 'manager' : session.role === 'wholesale_admin' ? 'wholesale_admin' : 'admin',
      adminUserId: session.adminUserId,
      managerId: session.role === 'manager' ? session.managerId : undefined,
      sessionId: session.sessionId,
      entityType: 'wholesale_price_list',
      entityId: numericId,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        oldToken: shortToken(existing.token),
        newToken: shortToken(nextToken),
        title,
      },
    });
  }

  return Response.json({ ok: true });
}

export async function DELETE(request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  await deleteWholesalePriceList(numericId, session);
  await recordSecurityEvent({
    eventType: 'price_deleted',
    actorType: session.role === 'manager' ? 'manager' : session.role === 'wholesale_admin' ? 'wholesale_admin' : 'admin',
    adminUserId: session.adminUserId,
    managerId: session.role === 'manager' ? session.managerId : undefined,
    sessionId: session.sessionId,
    entityType: 'wholesale_price_list',
    entityId: numericId,
    ip: getClientIp(request),
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
  });
  return Response.json({ ok: true });
}
