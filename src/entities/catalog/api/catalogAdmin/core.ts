import type { PoolClient } from 'pg';

import { ensureSiteSchema } from '@/shared/lib/db';
import { query, withTransaction } from '@/shared/lib/db/client';

import { ensureCatalogSchema } from '../catalogDb';
import { cacheKey, normalizeCatalogPrice, normalizeStockValue, normalizeText, slugify, uniqueSlug } from './helpers';
import { getCatalogAdminProductById } from './productQueries';
export { normalizeCatalogPrice } from './helpers';

export type {
  CatalogProductInput,
  CatalogAdminStats,
  CatalogImportResult
} from './types';
import type {
  CatalogProductInput,
  CatalogAdminStats,
  CatalogImportResult
} from './types';

type NormalizedCatalogProductInput = {
  title: string;
  article: string;
  brand: string;
  category: string;
  subcategory: string;
  priceGroup: string;
  unit: string | null;
  priceEur: string | null;
  priceRub: string | null;
  priceCny: string | null;
  generalDiscount: string | null;
  manualDiscount: string | null;
  manualDiscountRop: string | null;
  stock: number | null;
  isExpected: boolean | null;
  isActive: boolean;
};

type EntityCache = {
  categories: Map<string, number>;
  subcategories: Map<string, number>;
  brands: Map<string, number>;
  wholesaleCategories: Map<string, number>;
};

async function ensureCategory(client: PoolClient, cache: EntityCache, title: string, sortOrder: number) {
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

async function ensureSubcategory(client: PoolClient, cache: EntityCache, title: string, sortOrder: number) {
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

async function ensureBrand(client: PoolClient, cache: EntityCache, title: string) {
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

async function linkCatalogEntities(
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

async function ensureWholesaleCategory(client: PoolClient, cache: EntityCache, title: string, sortOrder: number) {
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

async function syncWholesaleProduct(
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
           series_description = $5,
           brand_title = $6,
           subcategory_title = $7,
           price_group = $8,
           unit = coalesce($9, unit),
           price_eur = $10,
           price_rub = $11,
           price_cny = $12,
           price_usd = $13,
           general_discount = $14,
           manual_discount = $15,
           manual_discount_rop = $16,
           stock = coalesce($17, stock),
           is_expected = coalesce($18, is_expected),
           stock_updated_at = case
             when $17::integer is not null and wholesale_products.stock is distinct from $17 then now()
             when $18::boolean is not null and wholesale_products.is_expected is distinct from $18 then now()
             else wholesale_products.stock_updated_at
           end,
           sort_order = $19,
           is_active = $20,
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
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, coalesce($17, 0), coalesce($18, false), null, $19, $20)`,
    values,
  );
}

function normalizeInput(input: CatalogProductInput): NormalizedCatalogProductInput {
  const article = normalizeText(input.article, 120);
  const unit = normalizeText(input.unit, 80);
  return {
    title: normalizeText(input.title, 500) || article,
    article,
    brand: normalizeText(input.brand, 180),
    category: normalizeText(input.category, 180),
    subcategory: normalizeText(input.subcategory, 180),
    priceGroup: normalizeText(input.priceGroup, 180),
    unit: unit || null,
    priceEur: normalizeCatalogPrice(input.priceEur),
    priceRub: normalizeCatalogPrice(input.priceRub),
    priceCny: normalizeCatalogPrice(input.priceCny),
    generalDiscount: normalizeCatalogPrice(input.generalDiscount),
    manualDiscount: normalizeCatalogPrice(input.manualDiscount),
    manualDiscountRop: normalizeCatalogPrice(input.manualDiscountRop),
    stock: normalizeStockValue(input.stock),
    isExpected: input.isExpected === null || input.isExpected === undefined ? null : Boolean(input.isExpected),
    isActive: input.isActive ?? true,
  };
}

function createCache(): EntityCache {
  return {
    categories: new Map(),
    subcategories: new Map(),
    brands: new Map(),
    wholesaleCategories: new Map(),
  };
}

function catalogProductImportKey(input: Pick<NormalizedCatalogProductInput, 'article' | 'title'>) {
  return cacheKey(normalizeText(input.article, 120)) || cacheKey(normalizeText(input.title, 500));
}

async function getExistingCatalogProducts(client: PoolClient) {
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

async function insertCatalogProduct(client: PoolClient, cache: EntityCache, input: NormalizedCatalogProductInput, sortOrder: number) {
  const categoryId = await ensureCategory(client, cache, input.category, sortOrder);
  const subcategoryId = await ensureSubcategory(client, cache, input.subcategory, sortOrder);
  const brandId = await ensureBrand(client, cache, input.brand);
  await linkCatalogEntities(client, categoryId, subcategoryId, brandId, sortOrder);

  const slug = await uniqueSlug(client, 'catalog_products', slugify(input.title, `product-${sortOrder + 1}`));
  const inserted = await client.query<{ id: string }>(
    `insert into catalog_products (
       document_id,
       slug,
       title,
       article,
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
       promo,
       brand_id,
       category_id,
       subcategory_id,
       is_active
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, case when $16 = true then now() else null end, false, $17, $18, $19, $20)
     returning id::text`,
    [
      `excel:${sortOrder + 1}`,
      slug,
      input.title,
      input.article,
      input.priceGroup,
      input.unit,
      input.priceEur,
      input.priceRub,
      input.priceCny,
      null,
      input.generalDiscount,
      input.manualDiscount,
      input.manualDiscountRop,
      input.stock ?? 0,
      input.isExpected ?? false,
      input.stock !== null || input.isExpected !== null,
      brandId,
      categoryId,
      subcategoryId,
      input.isActive,
    ],
  );
  const id = Number(inserted.rows[0]?.id);
  await syncWholesaleProduct(client, cache, id, input, sortOrder);
  return id;
}

async function updateCatalogProductFromImport(
  client: PoolClient,
  cache: EntityCache,
  id: number,
  input: NormalizedCatalogProductInput,
  sortOrder: number,
) {
  const categoryId = await ensureCategory(client, cache, input.category, sortOrder);
  const subcategoryId = await ensureSubcategory(client, cache, input.subcategory, sortOrder);
  const brandId = await ensureBrand(client, cache, input.brand);
  await linkCatalogEntities(client, categoryId, subcategoryId, brandId, sortOrder);

  const slug = await uniqueSlug(client, 'catalog_products', slugify(input.title, `product-${id}`), id);
  await client.query(
    `update catalog_products
     set document_id = $2,
         slug = $3,
         title = $4,
         article = $5,
         price_group = $6,
         unit = coalesce($7, unit),
         price_eur = $8,
         price_rub = $9,
         price_cny = $10,
         price_usd = $11,
         general_discount = $12,
         manual_discount = $13,
         manual_discount_rop = $14,
         brand_id = $15,
         category_id = $16,
         subcategory_id = $17,
         stock = coalesce($18, stock),
         is_expected = coalesce($19, is_expected),
         stock_updated_at = case
           when $18::integer is not null and stock is distinct from $18 then now()
           when $19::boolean is not null and is_expected is distinct from $19 then now()
           else stock_updated_at
         end,
         is_active = $20,
         updated_at = now()
     where id = $1`,
    [
      id,
      `excel:${sortOrder + 1}`,
      slug,
      input.title,
      input.article,
      input.priceGroup,
      input.unit,
      input.priceEur,
      input.priceRub,
      input.priceCny,
      null,
      input.generalDiscount,
      input.manualDiscount,
      input.manualDiscountRop,
      brandId,
      categoryId,
      subcategoryId,
      input.stock,
      input.isExpected,
      input.isActive,
    ],
  );
  await syncWholesaleProduct(client, cache, id, input, sortOrder);
}

export async function getCatalogAdminStats(): Promise<CatalogAdminStats> {
  await ensureCatalogSchema();
  const result = await query<{
    products: string;
    active_products: string;
    categories: string;
    subcategories: string;
    brands: string;
  }>(`
    select
      (select count(*)::text from catalog_products) as products,
      (select count(*)::text from catalog_products where is_active = true) as active_products,
      (select count(*)::text from catalog_categories where is_active = true) as categories,
      (select count(*)::text from catalog_subcategories where is_active = true) as subcategories,
      (select count(*)::text from catalog_brands where is_active = true) as brands
  `);
  const row = result.rows[0];
  return {
    products: Number(row?.products ?? 0),
    activeProducts: Number(row?.active_products ?? 0),
    categories: Number(row?.categories ?? 0),
    subcategories: Number(row?.subcategories ?? 0),
    brands: Number(row?.brands ?? 0),
  };
}

export async function createCatalogAdminProduct(input: CatalogProductInput) {
  await ensureCatalogSchema();
  await ensureSiteSchema();
  const normalized = normalizeInput(input);
  if (!normalized.article) throw new Error('Артикул товара обязателен');

  const id = await withTransaction(async (client) => {
    const count = await client.query<{ count: string }>('select count(*)::text as count from catalog_products');
    return insertCatalogProduct(client, createCache(), normalized, Number(count.rows[0]?.count ?? 0));
  });
  return getCatalogAdminProductById(id);
}

export async function updateCatalogAdminProduct(id: number, input: CatalogProductInput) {
  await ensureCatalogSchema();
  await ensureSiteSchema();
  const normalizedId = Number(id);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) throw new Error('Некорректный товар');
  const normalized = normalizeInput(input);
  if (!normalized.article) throw new Error('Артикул товара обязателен');

  await withTransaction(async (client) => {
    const existing = await client.query<{ id: string; sort_order: string }>(
      `select id::text, coalesce((
         select sort_order::text from wholesale_products where catalog_product_id = $1 limit 1
       ), '0') as sort_order
       from catalog_products
       where id = $1
       limit 1`,
      [normalizedId],
    );
    if (!existing.rows[0]) throw new Error('Товар не найден');

    const cache = createCache();
    const categoryId = await ensureCategory(client, cache, normalized.category, 0);
    const subcategoryId = await ensureSubcategory(client, cache, normalized.subcategory, 0);
    const brandId = await ensureBrand(client, cache, normalized.brand);
    await linkCatalogEntities(client, categoryId, subcategoryId, brandId, 0);

    const slug = await uniqueSlug(client, 'catalog_products', slugify(normalized.title, `product-${normalizedId}`), normalizedId);
    await client.query(
      `update catalog_products
       set slug = $2,
           title = $3,
           article = $4,
           price_group = $5,
           unit = coalesce($6, unit),
           price_eur = $7,
           price_rub = $8,
           price_cny = $9,
           price_usd = $10,
           general_discount = $11,
           manual_discount = $12,
           manual_discount_rop = $13,
           brand_id = $14,
           category_id = $15,
           subcategory_id = $16,
           stock = coalesce($17, stock),
           is_expected = coalesce($18, is_expected),
           stock_updated_at = case
             when $17::integer is not null and stock is distinct from $17 then now()
             when $18::boolean is not null and is_expected is distinct from $18 then now()
             else stock_updated_at
           end,
           is_active = $19,
           updated_at = now()
       where id = $1`,
      [
        normalizedId,
        slug,
        normalized.title,
        normalized.article,
        normalized.priceGroup,
        normalized.unit,
        normalized.priceEur,
        normalized.priceRub,
        normalized.priceCny,
        null,
        normalized.generalDiscount,
        normalized.manualDiscount,
        normalized.manualDiscountRop,
        brandId,
        categoryId,
        subcategoryId,
        normalized.stock,
        normalized.isExpected,
        normalized.isActive,
      ],
    );
    await syncWholesaleProduct(client, cache, normalizedId, normalized, Number(existing.rows[0].sort_order || 0));
  });

  return getCatalogAdminProductById(normalizedId);
}

export async function deleteCatalogAdminProduct(id: number) {
  await ensureCatalogSchema();
  await ensureSiteSchema();
  const normalizedId = Number(id);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) throw new Error('Некорректный товар');
  await withTransaction(async (client) => {
    await client.query(`update wholesale_products set is_active = false, updated_at = now() where catalog_product_id = $1`, [normalizedId]);
    await client.query(`delete from catalog_products where id = $1`, [normalizedId]);
  });
}

export async function replaceCatalogFromRows(rows: CatalogProductInput[]): Promise<CatalogImportResult> {
  await ensureCatalogSchema();
  await ensureSiteSchema();
  const normalizedRows = rows.map(normalizeInput).filter((row) => row.article);
  if (normalizedRows.length === 0) throw new Error('В файле нет товаров с заполненным артикулом');

  await withTransaction(async (client) => {
    const cache = createCache();
    const existingProducts = await getExistingCatalogProducts(client);
    const touchedProductIds = new Set<number>();

    for (const [index, row] of normalizedRows.entries()) {
      const key = catalogProductImportKey(row);
      const existingBucket = existingProducts.get(key);
      const existingProduct = existingBucket?.shift();

      if (existingProduct) {
        await updateCatalogProductFromImport(client, cache, existingProduct.id, row, index);
        touchedProductIds.add(existingProduct.id);
      } else {
        const insertedId = await insertCatalogProduct(client, cache, row, index);
        touchedProductIds.add(insertedId);
      }
    }

    const activeIds = Array.from(touchedProductIds);
    await client.query(
      `update catalog_products
       set is_active = false,
           updated_at = now()
       where not (id = any($1::bigint[]))
         and is_active = true`,
      [activeIds],
    );
    await client.query(
      `update wholesale_products
       set is_active = false,
           updated_at = now()
       where catalog_product_id is not null
         and not (catalog_product_id = any($1::bigint[]))
         and is_active = true`,
      [activeIds],
    );
    await client.query(
      `update wholesale_price_list_items items
       set visible = false,
           updated_at = now()
       from wholesale_products products
       where products.id = items.wholesale_product_id
         and products.catalog_product_id is not null
         and not (products.catalog_product_id = any($1::bigint[]))
         and items.visible = true`,
      [activeIds],
    );
    await client.query(`
      update catalog_categories categories
      set is_active = exists (
            select 1 from catalog_products products
            where products.category_id = categories.id and products.is_active = true
          ),
          updated_at = now()
    `);
    await client.query(`
      update catalog_subcategories subcategories
      set is_active = exists (
            select 1 from catalog_products products
            where products.subcategory_id = subcategories.id and products.is_active = true
          ),
          updated_at = now()
    `);
    await client.query(`
      update catalog_brands brands
      set is_active = exists (
            select 1 from catalog_products products
            where products.brand_id = brands.id and products.is_active = true
          ),
          updated_at = now()
    `);
    await client.query(`
      update wholesale_categories categories
      set is_active = exists (
            select 1 from wholesale_products products
            where products.category_id = categories.id and products.is_active = true
          ),
          updated_at = now()
    `);
  });

  const stats = await getCatalogAdminStats();
  return {
    ...stats,
    importedProducts: normalizedRows.length,
    syncedWholesaleProducts: normalizedRows.length,
  };
}
