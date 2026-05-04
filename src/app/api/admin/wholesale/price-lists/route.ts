import { randomBytes } from 'crypto';

import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireEmployee } from '@/shared/lib/adminAuth';
import { createWholesalePriceList, getWholesalePriceLists, type WholesalePriceListItemInput } from '@/shared/lib/db';
import {
  isValidNewPublicPriceToken,
  normalizeOptionalDate,
  normalizePublicPriceToken,
  normalizeTextField,
  normalizeWholesalePrice,
} from '@/shared/lib/wholesaleSecurity';

const MAX_PRICE_ITEMS = 5000;

function token() {
  return randomBytes(12).toString('hex');
}

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

export async function GET() {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;

  const priceLists = await getWholesalePriceLists(session);
  return Response.json({ priceLists });
}

export async function POST(request: Request) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const limited = await enforceAdminActionRateLimit(session, 'price_list_create', 80);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const title = normalizeTextField(body.title, 160);
  if (!title) return Response.json({ error: 'Title is required' }, { status: 400 });
  const nextToken = normalizePublicPriceToken(body.token) || token();
  if (!isValidNewPublicPriceToken(nextToken)) {
    return Response.json({ error: 'Token must be 24-128 letters, digits, _ or -' }, { status: 400 });
  }
  const validUntil = normalizeOptionalDate(body.validUntil);
  if (typeof body.validUntil === 'string' && body.validUntil.trim() && !validUntil) {
    return Response.json({ error: 'Invalid expiration date' }, { status: 400 });
  }

  const id = await createWholesalePriceList(
    {
      title,
      clientName: normalizeTextField(body.clientName, 200),
      managerId: Number.isFinite(Number(body.managerId)) ? Number(body.managerId) : null,
      validUntil,
      token: nextToken,
      comment: normalizeTextField(body.comment, 2000),
      showRetailPrices: Boolean(body.showRetailPrices),
      isActive: Boolean(body.isActive ?? true),
      items: itemsFromBody(body.items),
    },
    session,
  );

  return Response.json({ id });
}
