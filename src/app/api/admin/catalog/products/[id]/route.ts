import {
  deleteCatalogAdminProduct,
  updateCatalogAdminProduct,
  type CatalogProductInput,
} from '@/entities/catalog/api/catalogAdmin';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireAdminSession } from '@/shared/lib/adminAuth';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';

type Context = {
  params: Promise<{ id: string }>;
};

function productInputFromBody(body: Record<string, unknown>): CatalogProductInput {
  return {
    title: typeof body.title === 'string' ? body.title : '',
    article: typeof body.article === 'string' ? body.article : '',
    brand: typeof body.brand === 'string' ? body.brand : '',
    category: typeof body.category === 'string' ? body.category : '',
    subcategory: typeof body.subcategory === 'string' ? body.subcategory : '',
    priceGroup: typeof body.priceGroup === 'string' ? body.priceGroup : '',
    unit: typeof body.unit === 'string' ? body.unit : '',
    priceEur: typeof body.priceEur === 'string' || typeof body.priceEur === 'number' ? body.priceEur : null,
    priceRub: typeof body.priceRub === 'string' || typeof body.priceRub === 'number' ? body.priceRub : null,
    priceCny: typeof body.priceCny === 'string' || typeof body.priceCny === 'number' ? body.priceCny : null,
    priceUsd: typeof body.priceUsd === 'string' || typeof body.priceUsd === 'number' ? body.priceUsd : null,
    manualDiscount: typeof body.manualDiscount === 'string' || typeof body.manualDiscount === 'number' ? body.manualDiscount : null,
    manualDiscountRop: typeof body.manualDiscountRop === 'string' || typeof body.manualDiscountRop === 'number' ? body.manualDiscountRop : null,
    stock: typeof body.stock === 'string' || typeof body.stock === 'number' ? body.stock : null,
    isExpected: typeof body.isExpected === 'boolean' ? body.isExpected : null,
    isActive: typeof body.isActive === 'boolean' ? body.isActive : true,
  };
}

function badRequest(error: string, status = 400) {
  return Response.json({ error }, { status });
}

function parseId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PUT(request: Request, context: Context) {
  const { denied, session } = await requireAdminSession();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;
  const limited = await enforceAdminActionRateLimit(session, 'catalog_product_update', 120);
  if (limited) return limited;

  const { id } = await context.params;
  const productId = parseId(id);
  if (!productId) return badRequest('Некорректный товар');

  const body = await request.json().catch(() => ({}));
  try {
    const product = await updateCatalogAdminProduct(productId, productInputFromBody(body as Record<string, unknown>));
    await recordSecurityEvent({
      eventType: 'catalog_product_updated',
      actorType: 'admin',
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'catalog_product',
      entityId: productId,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { title: product?.title, category: product?.category, brand: product?.brand },
    });
    return Response.json({ product });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : 'Не удалось сохранить товар');
  }
}

export async function DELETE(request: Request, context: Context) {
  const { denied, session } = await requireAdminSession();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;
  const limited = await enforceAdminActionRateLimit(session, 'catalog_product_delete', 60);
  if (limited) return limited;

  const { id } = await context.params;
  const productId = parseId(id);
  if (!productId) return badRequest('Некорректный товар');

  try {
    await deleteCatalogAdminProduct(productId);
    await recordSecurityEvent({
      eventType: 'catalog_product_deleted',
      actorType: 'admin',
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'catalog_product',
      entityId: productId,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
    });
    return Response.json({ ok: true });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : 'Не удалось удалить товар');
  }
}
