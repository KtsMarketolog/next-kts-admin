import type { PoolClient } from 'pg';
import { cacheKey, normalizeText, slugify, uniqueSlug } from './helpers';

export type EntityCache = {
  categories: Map<string, number>;
  subcategories: Map<string, number>;
  brands: Map<string, number>;
  wholesaleCategories: Map<string, number>;
};

export async function ensureCategory(client: PoolClient, cache: EntityCache, title: string, sortOrder: number) {
  const normalized = normalizeText(title, 180);
  if (!normalized) return null;
  const key = cacheKey(normalized);
  const cached = cache.categories.get(key);
  if (cached) return cached;

  const existing = await client.query<{ id: string }>(
    `select id::text from catalog_categories where lower(title) = lower($1) limit 1`,
    [normalized],
  );
  if (existing.rows[0]) {
    const id = Number(existing.rows[0].id);
    await client.query(
      `update catalog_categories
       set title = $1, sort_order = $2, is_active = true, updated_at = now()
       where id = $3`,
      [normalized, sortOrder, id],
    );
    cache.categories.set(key, id);
    return id;
  }

  const slug = await uniqueSlug(client, 'catalog_categories', slugify(normalized, `category-${sortOrder + 1}`));
  const inserted = await client.query<{ id: string }>(
    `insert into catalog_categories (slug, title, sort_order, is_active)
     values ($1, $2, $3, true)
     returning id::text`,
    [slug, normalized, sortOrder],
  );
  const id = Number(inserted.rows[0]?.id);
  cache.categories.set(key, id);
  return id;
}

export async function ensureSubcategory(client: PoolClient, cache: EntityCache, title: string, sortOrder: number) {
  const normalized = normalizeText(title, 180);
  if (!normalized) return null;
  const key = cacheKey(normalized);
  const cached = cache.subcategories.get(key);
  if (cached) return cached;

  const existing = await client.query<{ id: string }>(
    `select id::text from catalog_subcategories where lower(title) = lower($1) limit 1`,
    [normalized],
  );
  if (existing.rows[0]) {
    const id = Number(existing.rows[0].id);
    await client.query(
      `update catalog_subcategories
       set title = $1, sort_order = $2, is_active = true, updated_at = now()
       where id = $3`,
      [normalized, sortOrder, id],
    );
    cache.subcategories.set(key, id);
    return id;
  }

  const slug = await uniqueSlug(client, 'catalog_subcategories', slugify(normalized, `subcategory-${sortOrder + 1}`));
  const inserted = await client.query<{ id: string }>(
    `insert into catalog_subcategories (slug, title, sort_order, is_active)
     values ($1, $2, $3, true)
     returning id::text`,
    [slug, normalized, sortOrder],
  );
  const id = Number(inserted.rows[0]?.id);
  cache.subcategories.set(key, id);
  return id;
}

export async function ensureBrand(client: PoolClient, cache: EntityCache, title: string) {
  const normalized = normalizeText(title, 180);
  if (!normalized) return null;
  const key = cacheKey(normalized);
  const cached = cache.brands.get(key);
  if (cached) return cached;

  const existing = await client.query<{ id: string }>(
    `select id::text from catalog_brands where lower(title) = lower($1) limit 1`,
    [normalized],
  );
  if (existing.rows[0]) {
    const id = Number(existing.rows[0].id);
    await client.query(
      `update catalog_brands
       set title = $1, is_active = true, updated_at = now()
       where id = $2`,
      [normalized, id],
    );
    cache.brands.set(key, id);
    return id;
  }

  const slug = await uniqueSlug(client, 'catalog_brands', slugify(normalized, 'brand'));
  const inserted = await client.query<{ id: string }>(
    `insert into catalog_brands (slug, title, popular, is_active)
     values ($1, $2, false, true)
     returning id::text`,
    [slug, normalized],
  );
  const id = Number(inserted.rows[0]?.id);
  cache.brands.set(key, id);
  return id;
}

export async function linkCatalogEntities(
  client: PoolClient,
  categoryId: number | null,
  subcategoryId: number | null,
  brandId: number | null,
  sortOrder: number,
) {
  if (categoryId && subcategoryId) {
    await client.query(
      `insert into catalog_category_subcategories (category_id, subcategory_id, sort_order)
       values ($1, $2, $3)
       on conflict (category_id, subcategory_id)
       do update set sort_order = least(catalog_category_subcategories.sort_order, excluded.sort_order)`,
      [categoryId, subcategoryId, sortOrder],
    );
  }

  if (brandId && categoryId) {
    await client.query(
      `insert into catalog_brand_categories (brand_id, category_id, sort_order)
       values ($1, $2, $3)
       on conflict (brand_id, category_id)
       do update set sort_order = least(catalog_brand_categories.sort_order, excluded.sort_order)`,
      [brandId, categoryId, sortOrder],
    );
  }

  if (brandId && subcategoryId) {
    await client.query(
      `insert into catalog_brand_subcategories (brand_id, subcategory_id, sort_order)
       values ($1, $2, $3)
       on conflict (brand_id, subcategory_id)
       do update set sort_order = least(catalog_brand_subcategories.sort_order, excluded.sort_order)`,
      [brandId, subcategoryId, sortOrder],
    );
  }
}

export function createCache(): EntityCache {
  return {
    categories: new Map(),
    subcategories: new Map(),
    brands: new Map(),
    wholesaleCategories: new Map(),
  };
}
