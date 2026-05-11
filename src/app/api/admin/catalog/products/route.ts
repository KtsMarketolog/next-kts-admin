import {
  createCatalogAdminProduct,
  getCatalogAdminFilterOptions,
  getCatalogAdminProducts,
  getCatalogAdminStats,
  type CatalogProductInput,
} from '@/entities/catalog/api/catalogAdmin';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireAdminSession } from '@/shared/lib/adminAuth';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';

function productInputFromBody(body: Record<string, unknown>): CatalogProductInput {
  return {
    title: typeof body.title === 'string' ? body.title : '',
    article: typeof body.article === 'string' ? body.article : '',
    brand: typeof body.brand === 'string' ? body.brand : '',
    category: typeof body.category === 'string' ? body.category : '',
    subcategory: typeof body.subcategory === 'string' ? body.subcategory : '',
    priceGroup: typeof body.priceGroup === 'string' ? body.priceGroup : '',
    priceEur: typeof body.priceEur === 'string' || typeof body.priceEur === 'number' ? body.priceEur : null,
    priceRub: typeof body.priceRub === 'string' || typeof body.priceRub === 'number' ? body.priceRub : null,
    priceCny: typeof body.priceCny === 'string' || typeof body.priceCny === 'number' ? body.priceCny : null,
    stock: typeof body.stock === 'string' || typeof body.stock === 'number' ? body.stock : null,
    isExpected: typeof body.isExpected === 'boolean' ? body.isExpected : null,
    isActive: typeof body.isActive === 'boolean' ? body.isActive : true,
  };
}

function badRequest(error: string, status = 400) {
  return Response.json({ error }, { status });
}

export async function GET(request: Request) {
  const { denied } = await requireAdminSession();
  if (denied) return denied;

  const url = new URL(request.url);
  const category = url.searchParams.get('category') ?? '';
  const subcategory = url.searchParams.get('subcategory') ?? '';
  const brand = url.searchParams.get('brand') ?? '';
  const [products, stats, filterOptions] = await Promise.all([
    getCatalogAdminProducts({
      search: url.searchParams.get('search') ?? '',
      category,
      subcategory,
      brand,
      active: (url.searchParams.get('active') as 'all' | 'active' | 'inactive' | null) ?? 'all',
      limit: Number(url.searchParams.get('limit') ?? 200),
    }),
    getCatalogAdminStats(),
    getCatalogAdminFilterOptions({ category, subcategory, brand }),
  ]);
  return Response.json({ products, stats, filterOptions });
}

export async function POST(request: Request) {
  const { denied, session } = await requireAdminSession();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;
  const limited = await enforceAdminActionRateLimit(session, 'catalog_product_create', 80);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  try {
    const product = await createCatalogAdminProduct(productInputFromBody(body as Record<string, unknown>));
    await recordSecurityEvent({
      eventType: 'catalog_product_created',
      actorType: 'admin',
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'catalog_product',
      entityId: product?.id,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { title: product?.title, category: product?.category, brand: product?.brand },
    });
    return Response.json({ product });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : 'Не удалось добавить товар');
  }
}
