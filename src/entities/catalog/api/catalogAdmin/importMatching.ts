import type { PoolClient } from 'pg';
import { cacheKey, normalizeText } from './helpers';
import type { NormalizedCatalogProductInput } from './productInput';

export function catalogProductImportKey(input: Pick<NormalizedCatalogProductInput, 'article' | 'title'>) {
  return cacheKey(normalizeText(input.article, 120)) || cacheKey(normalizeText(input.title, 500));
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

  const products = new Map<string, Array<{ id: number; sortOrder: number }>>();
  for (const row of result.rows) {
    const key = catalogProductImportKey({ article: row.article ?? '', title: row.title });
    if (!key) continue;
    const bucket = products.get(key) ?? [];
    bucket.push({
      id: Number(row.id),
      sortOrder: Number(row.sort_order ?? 0),
    });
    products.set(key, bucket);
  }

  return products;
}
