import { requireEmployee } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import {
  searchAnalogs,
  searchAnalogsForCatalogProduct,
  normalizeAnalogTerm,
  ANALOG_KNOWLEDGE_GENERATED_AT,
  ANALOG_KNOWLEDGE_STATS,
} from '@/shared/lib/analogs';
import { findAnalogCatalogProducts, getActiveAnalogCatalog } from '@/shared/lib/db/analogCatalogRepo';
import { getAnalogStockMatches } from '@/shared/lib/db/analogStockRepo';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { session, denied } = await requireEmployee();
  if (denied) return denied;

  const url = new URL(request.url);
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 180);
  const refrigerant = url.searchParams.get('refrigerant');
  const sourceBrand = (url.searchParams.get('sourceBrand') ?? '').trim().slice(0, 120);
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const limited = await enforceAdminActionRateLimit(session, 'analog-search', 120, 60_000);
    if (limited) return Response.json({ error: 'Слишком много поисковых запросов. Подождите немного и повторите.' }, {
      status: 429, headers: { ...headers, 'Retry-After': limited.headers.get('Retry-After') ?? '60' },
    });
    let search = searchAnalogs(query, refrigerant, sourceBrand);
    if (search.normalizedQuery.length < 2) return Response.json({ ...search, catalogOnly: true }, { headers });
    const catalog = await getActiveAnalogCatalog();
    const catalogProducts = findAnalogCatalogProducts(query, catalog);
    const catalogProduct = catalogProducts.length === 1 ? catalogProducts[0] : null;
    const exactCatalogIdentity = catalogProduct && [catalogProduct.sku, catalogProduct.title]
      .some((value) => normalizeAnalogTerm(value) === search.normalizedQuery);
    // A model shared by different brands is not resolved just because only one
    // of those brands is stocked here. An exact own SKU/full title is explicit.
    if (catalogProduct && (!search.requiresModelSelection || exactCatalogIdentity)) {
      search = searchAnalogsForCatalogProduct(query, catalogProduct, refrigerant, sourceBrand);
    }
    const stockMatches = getAnalogStockMatches(search.results, catalog);
    const results = search.results.flatMap((result) => {
      const catalogMatches = stockMatches.get(result.id) ?? [];
      if (catalogMatches.length === 0) return [];
      return [{ ...result, catalogMatches, stock: catalogMatches.length === 1 ? catalogMatches[0] : null }];
    });
    return Response.json({
      ...search,
      results,
      total: results.length,
      catalogOnly: true,
      knowledgeBase: {
        generatedAt: ANALOG_KNOWLEDGE_GENERATED_AT,
        stats: ANALOG_KNOWLEDGE_STATS,
      },
    }, { headers });
  } catch (error) {
    console.error('Failed to load analog catalog', error);
    return Response.json({ error: 'Не удалось проверить актуальный каталог и остатки. Повторите поиск позже.' }, { status: 503, headers });
  }
}
