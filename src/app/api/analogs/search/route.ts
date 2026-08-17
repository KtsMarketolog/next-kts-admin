import { getAdminSession } from '@/shared/lib/adminAuth';
import {
  searchAnalogs,
  searchAnalogsForCatalogProduct,
  normalizeAnalogTerm,
  ANALOG_KNOWLEDGE_GENERATED_AT,
  ANALOG_KNOWLEDGE_STATS,
} from '@/shared/lib/analogs';
import { findAnalogCatalogProducts } from '@/shared/lib/db/analogCatalogRepo';
import { getAnalogStockMatches } from '@/shared/lib/db/analogStockRepo';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const employeeSession = await getAdminSession();
  if (!employeeSession) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const query = url.searchParams.get('q') ?? '';
  const refrigerant = url.searchParams.get('refrigerant');
  let search = searchAnalogs(query, refrigerant);

  try {
    const catalogProducts = await findAnalogCatalogProducts(query);
    if (catalogProducts.length === 1) {
      search = searchAnalogsForCatalogProduct(query, catalogProducts[0], refrigerant);
    }
  } catch (error) {
    console.error('Failed to resolve analog search through catalog', error);
  }

  let stockMatches = [] as Awaited<ReturnType<typeof getAnalogStockMatches>>;
  if (search.results.length > 0) {
    try {
      stockMatches = await getAnalogStockMatches(search.results.map((result) => result.model));
    } catch (error) {
      console.error('Failed to load analog stock matches', error);
    }
  }

  const stockByModel = new Map<string, (typeof stockMatches)[number]>();
  for (const stock of stockMatches) {
    const current = stockByModel.get(stock.modelKey);
    if (!current || stock.stock > current.stock) stockByModel.set(stock.modelKey, stock);
  }

  return Response.json(
    {
      ...search,
      results: search.results.map((result) => ({
        ...result,
        stock: stockByModel.get(normalizeAnalogTerm(result.model)) ?? null,
      })),
      knowledgeBase: {
        generatedAt: ANALOG_KNOWLEDGE_GENERATED_AT,
        stats: ANALOG_KNOWLEDGE_STATS,
      },
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
