import type { PoolClient } from 'pg';
import { cacheKey, normalizeText } from './helpers';
import type { NormalizedCatalogProductInput } from './productInput';

export function catalogProductImportKey(input: Pick<NormalizedCatalogProductInput, 'article'>) {
  // An old empty SKU is not an identity, even if its title equals a new SKU.
  return cacheKey(normalizeText(input.article, 120));
}

type ExistingProducts = Map<string, Array<{ id: number; sortOrder: number }>>;
type ExistingDuplicate = { article: string; productIds: number[]; totalProducts: number };
const MAX_REPORTED_DUPLICATES = 25;
const MAX_REPORTED_PRODUCTS = 20;

export class CatalogExistingArticleConflictError extends Error {
  readonly code = 'CATALOG_EXISTING_DUPLICATE_ARTICLES';
  readonly duplicates: ExistingDuplicate[];
  readonly duplicateCount: number;
  readonly truncated: boolean;
  constructor(duplicates: ExistingDuplicate[]) {
    const reported = duplicates.slice(0, MAX_REPORTED_DUPLICATES).map(item => ({
      ...item, productIds: item.productIds.slice(0, MAX_REPORTED_PRODUCTS),
    }));
    super(`Импорт не выполнен: в каталоге уже есть несколько товаров с одинаковым артикулом (включая неактивные): ${reported.map(item => `«${item.article}» — ${item.totalProducts} товаров`).join('; ')}${duplicates.length > reported.length ? '; и другие' : ''}. Сначала нужно устранить неоднозначность существующих записей. Товары, остатки и настройки прайсов не изменены.`);
    this.name = 'CatalogExistingArticleConflictError';
    this.duplicates = reported;
    this.duplicateCount = duplicates.length;
    this.truncated = duplicates.length > reported.length || reported.some(item => item.productIds.length < item.totalProducts);
  }
}

/** Called under the catalog/stock writer lock, before any entity is changed. */
export function assertUnambiguousCatalogImportMatches(rows: NormalizedCatalogProductInput[], existing: ExistingProducts) {
  const conflicts: ExistingDuplicate[] = [];
  for (const row of rows) {
    const matches = existing.get(catalogProductImportKey(row));
    if (matches && matches.length > 1) conflicts.push({ article: row.article, productIds: matches.map(item => item.id), totalProducts: matches.length });
  }
  if (conflicts.length) throw new CatalogExistingArticleConflictError(conflicts);
}

export async function getExistingCatalogProducts(client: PoolClient) {
  const result = await client.query<{
    id: string;
    title: string;
    article: string | null;
    sort_order: string | null;
  }>(`
    select p.id::text,
           p.title,
           p.article,
           coalesce(wp.sort_order, 0)::text as sort_order
    from catalog_products p
    left join wholesale_products wp on wp.catalog_product_id = p.id
    order by p.is_active desc, p.updated_at desc, p.id asc
  `);

  const products: ExistingProducts = new Map();
  const seenIds = new Set<number>();
  for (const row of result.rows) {
    const id = Number(row.id);
    // Legacy wholesale links can multiply the JOIN; they are not extra catalog products.
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const key = catalogProductImportKey({ article: row.article ?? '' });
    if (!key) continue;
    const bucket = products.get(key) ?? [];
    bucket.push({
      id,
      sortOrder: Number(row.sort_order ?? 0),
    });
    products.set(key, bucket);
  }

  return products;
}
