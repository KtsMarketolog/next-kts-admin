import type { PoolClient } from 'pg';
import { cacheKey, normalizeText, normalizeCatalogPrice, slugify } from './helpers';
import type { EntityCache } from './entityWrites';
import type { NormalizedCatalogProductInput } from './productInput';

export async function ensureWholesaleCategory(client: PoolClient, cache: EntityCache, title: string, sortOrder: number) {
  const normalized = normalizeText(title, 180) || 'Без категории';
  const key = cacheKey(normalized);
  const cached = cache.wholesaleCategories.get(key);
  if (cached) return cached;

  const slug = slugify(normalized, `wholesale-category-${sortOrder + 1}`);
  const inserted = await client.query<{ id: string }>(
    `insert into wholesale_categories (title, slug, sort_order, is_active, updated_at)
     values ($1, $2, $3, true, now())
     on conflict (slug)
     do update set title = excluded.title,
                   sort_order = excluded.sort_order,
                   is_active = true,
                   updated_at = now()
     returning id::text`,
    [normalized, slug, sortOrder],
  );
  const id = Number(inserted.rows[0]?.id);
  cache.wholesaleCategories.set(key, id);
  return id;
}

export async function syncWholesaleProduct(
  client: PoolClient,
  cache: EntityCache,
  catalogProductId: number,
  input: NormalizedCatalogProductInput,
  sortOrder: number,
) {
  const categoryId = await ensureWholesaleCategory(client, cache, input.category, sortOrder);
  const existing = await client.query<{ id: string }>(
    `select id::text from wholesale_products where catalog_product_id = $1 limit 1`,
    [catalogProductId],
  );
  const values = [
    catalogProductId,
    categoryId,
    input.title,
    input.article,
    input.model,
    input.subcategory,
    input.brand,
    input.subcategory,
    input.priceGroup,
    input.unit,
    normalizeCatalogPrice(input.priceEur),
    normalizeCatalogPrice(input.priceRub),
    normalizeCatalogPrice(input.priceCny),
    null,
    normalizeCatalogPrice(input.generalDiscount),
    normalizeCatalogPrice(input.manualDiscount),
    normalizeCatalogPrice(input.manualDiscountRop),
    input.stock,
    input.isExpected,
    sortOrder,
    input.isActive,
  ];

  if (existing.rows[0]) {
    await client.query(
      `update wholesale_products
       set category_id = $2,
           title = $3,
           sku = $4,
           model = $5,
           series_description = $6,
           brand_title = $7,
           subcategory_title = $8,
           price_group = $9,
           unit = coalesce($10, unit),
           price_eur = $11,
           price_rub = $12,
           price_cny = $13,
           price_usd = $14,
           general_discount = $15,
           manual_discount = $16,
           manual_discount_rop = $17,
           stock = coalesce($18, stock),
           is_expected = coalesce($19, is_expected),
           stock_updated_at = case
             when $18::integer is not null and wholesale_products.stock is distinct from $18 then now()
             when $19::boolean is not null and wholesale_products.is_expected is distinct from $19 then now()
             else wholesale_products.stock_updated_at
           end,
           sort_order = $20,
           is_active = $21,
           updated_at = now()
       where catalog_product_id = $1`,
      values,
    );
    return;
  }

  await client.query(
    `insert into wholesale_products (
       catalog_product_id,
       category_id,
       title,
       sku,
       model,
       series_description,
       brand_title,
       subcategory_title,
       price_group,
       unit,
       price_eur,
       price_rub,
       price_cny,
       price_usd,
       general_discount,
       manual_discount,
       manual_discount_rop,
       stock,
       is_expected,
       stock_updated_at,
       sort_order,
       is_active
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, coalesce($18, 0), coalesce($19, false), null, $20, $21)`,
    values,
  );
}
