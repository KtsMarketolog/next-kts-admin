import type { PoolClient } from 'pg';

import { ensureSiteSchema } from '@/shared/lib/db';
import { query, withTransaction } from '@/shared/lib/db/client';

import { ensureCatalogSchema } from './catalogDb';

export type CatalogProductInput = {
  title: string;
  article?: string | null;
  brand?: string | null;
  category?: string | null;
  subcategory?: string | null;
  priceGroup?: string | null;
  priceEur?: string | number | null;
  priceRub?: string | number | null;
  priceCny?: string | number | null;
  stock?: string | number | null;
  isExpected?: boolean | null;
  isActive?: boolean;
};

export type CatalogAdminProduct = {
  id: number;
  title: string;
  article: string;
  brand: string;
  category: string;
  subcategory: string;
  priceGroup: string;
  priceEur: string;
  priceRub: string;
  priceCny: string;
  stock: number;
  isExpected: boolean;
  stockUpdatedAt: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CatalogAdminStats = {
  products: number;
  activeProducts: number;
  categories: number;
  subcategories: number;
  brands: number;
};

export type CatalogAdminProductFilters = {
  search?: string | null;
  category?: string | null;
  subcategory?: string | null;
  brand?: string | null;
  active?: 'all' | 'active' | 'inactive' | null;
  limit?: number | null;
};

export type CatalogAdminFilterOptions = {
  categories: string[];
  subcategories: string[];
  brands: string[];
};

export type CatalogImportResult = CatalogAdminStats & {
  importedProducts: number;
  syncedWholesaleProducts: number;
};

type NormalizedCatalogProductInput = {
  title: string;
  article: string;
  brand: string;
  category: string;
  subcategory: string;
  priceGroup: string;
  priceEur: string | null;
  priceRub: string | null;
  priceCny: string | null;
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

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

function normalizeText(value: unknown, maxLength = 240) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : '';
}

export function normalizeCatalogPrice(value: unknown) {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .trim()
    .replace(/\s+/g, '')
    .replace(',', '.')
    .replace(/[^\d.]/g, '');
  if (!text) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999999999) return null;
  return text;
}

function normalizeStockValue(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().replace(/\s+/g, '');
  if (!/^\d+$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 999999999) return null;
  return amount;
}

function slugify(value: string, fallback: string) {
  const transliterated = value
    .toLowerCase()
    .split('')
    .map((char) => CYRILLIC_TO_LATIN[char] ?? char)
    .join('');
  const slug = transliterated
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 76);
  return slug || fallback;
}

async function uniqueSlug(client: PoolClient, table: 'catalog_categories' | 'catalog_subcategories' | 'catalog_brands' | 'catalog_products', base: string, exceptId?: number) {
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`;
    const candidate = `${base.slice(0, 76 - suffix.length)}${suffix}`;
    const existing = exceptId
      ? await client.query(`select id from ${table} where slug = $1 and id <> $2 limit 1`, [candidate, exceptId])
      : await client.query(`select id from ${table} where slug = $1 limit 1`, [candidate]);
    if (existing.rowCount === 0) return candidate;
  }
  return `${base.slice(0, 60)}-${Date.now().toString(36)}`;
}

function cacheKey(value: string) {
  return value.trim().toLowerCase();
}

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
    normalizeCatalogPrice(input.priceEur),
    normalizeCatalogPrice(input.priceRub),
    normalizeCatalogPrice(input.priceCny),
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
           price_eur = $9,
           price_rub = $10,
           price_cny = $11,
           stock = coalesce($12, stock),
           is_expected = coalesce($13, is_expected),
           stock_updated_at = case
             when $12::integer is not null and wholesale_products.stock is distinct from $12 then now()
             when $13::boolean is not null and wholesale_products.is_expected is distinct from $13 then now()
             else wholesale_products.stock_updated_at
           end,
           sort_order = $14,
           is_active = $15,
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
       price_eur,
       price_rub,
       price_cny,
       stock,
       is_expected,
       stock_updated_at,
       sort_order,
       is_active
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12, 0), coalesce($13, false), null, $14, $15)`,
    values,
  );
}

function normalizeInput(input: CatalogProductInput): NormalizedCatalogProductInput {
  return {
    title: normalizeText(input.title, 500),
    article: normalizeText(input.article, 120),
    brand: normalizeText(input.brand, 180),
    category: normalizeText(input.category, 180),
    subcategory: normalizeText(input.subcategory, 180),
    priceGroup: normalizeText(input.priceGroup, 180),
    priceEur: normalizeCatalogPrice(input.priceEur),
    priceRub: normalizeCatalogPrice(input.priceRub),
    priceCny: normalizeCatalogPrice(input.priceCny),
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

function catalogProductImportKey(input: Pick<NormalizedCatalogProductInput, 'title'>) {
  return cacheKey(normalizeText(input.title, 500));
}

async function getExistingCatalogProducts(client: PoolClient) {
  const result = await client.query<{
    id: string;
    title: string;
    sort_order: string | null;
  }>(`
    select p.id::text,
           p.title,
           coalesce(wp.sort_order, 0)::text as sort_order
    from catalog_products p
    left join wholesale_products wp on wp.catalog_product_id = p.id
    order by p.is_active desc, p.updated_at desc, p.id asc
  `);

  const products = new Map<string, Array<{ id: number; sortOrder: number }>>();
  for (const row of result.rows) {
    const key = catalogProductImportKey({ title: row.title });
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
       price_eur,
       price_rub,
       price_cny,
       stock,
       is_expected,
       stock_updated_at,
       promo,
       brand_id,
       category_id,
       subcategory_id,
       is_active
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, case when $11 = true then now() else null end, false, $12, $13, $14, $15)
     returning id::text`,
    [
      `excel:${sortOrder + 1}`,
      slug,
      input.title,
      input.article,
      input.priceGroup,
      input.priceEur,
      input.priceRub,
      input.priceCny,
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
         price_eur = $7,
         price_rub = $8,
         price_cny = $9,
         brand_id = $10,
         category_id = $11,
         subcategory_id = $12,
         stock = coalesce($13, stock),
         is_expected = coalesce($14, is_expected),
         stock_updated_at = case
           when $13::integer is not null and stock is distinct from $13 then now()
           when $14::boolean is not null and is_expected is distinct from $14 then now()
           else stock_updated_at
         end,
         is_active = $15,
         updated_at = now()
     where id = $1`,
    [
      id,
      `excel:${sortOrder + 1}`,
      slug,
      input.title,
      input.article,
      input.priceGroup,
      input.priceEur,
      input.priceRub,
      input.priceCny,
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

export async function getCatalogAdminFilterOptions(): Promise<CatalogAdminFilterOptions> {
  await ensureCatalogSchema();
  const [categories, subcategories, brands] = await Promise.all([
    query<{ title: string }>(`
      select title
      from catalog_categories
      where is_active = true and nullif(trim(title), '') is not null
      order by title
    `),
    query<{ title: string }>(`
      select title
      from catalog_subcategories
      where is_active = true and nullif(trim(title), '') is not null
      order by title
    `),
    query<{ title: string }>(`
      select title
      from catalog_brands
      where is_active = true and nullif(trim(title), '') is not null
      order by title
    `),
  ]);

  return {
    categories: categories.rows.map((row) => row.title),
    subcategories: subcategories.rows.map((row) => row.title),
    brands: brands.rows.map((row) => row.title),
  };
}

function mapAdminProduct(row: {
  id: string;
  title: string;
  article: string | null;
  brand: string | null;
  category: string | null;
  subcategory: string | null;
  price_group: string | null;
  price_eur: string | null;
  price_rub: string | null;
  price_cny: string | null;
  stock: number | string | null;
  is_expected: boolean | null;
  stock_updated_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}): CatalogAdminProduct {
  return {
    id: Number(row.id),
    title: row.title,
    article: row.article ?? '',
    brand: row.brand ?? '',
    category: row.category ?? '',
    subcategory: row.subcategory ?? '',
    priceGroup: row.price_group ?? '',
    priceEur: row.price_eur ?? '',
    priceRub: row.price_rub ?? '',
    priceCny: row.price_cny ?? '',
    stock: Number(row.stock ?? 0),
    isExpected: Boolean(row.is_expected),
    stockUpdatedAt: row.stock_updated_at,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getCatalogAdminProducts(filters: CatalogAdminProductFilters = {}) {
  await ensureCatalogSchema();
  const normalizedSearch = normalizeText(filters.search, 120);
  const normalizedCategory = normalizeText(filters.category, 180);
  const normalizedSubcategory = normalizeText(filters.subcategory, 180);
  const normalizedBrand = normalizeText(filters.brand, 180);
  const normalizedActive = filters.active === 'active' || filters.active === 'inactive' ? filters.active : 'all';
  const normalizedLimit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
  const result = await query<Parameters<typeof mapAdminProduct>[0]>(
    `select p.id::text,
            p.title,
            p.article,
            b.title as brand,
            c.title as category,
            s.title as subcategory,
            p.price_group,
            p.price_eur::text,
            p.price_rub::text,
            p.price_cny::text,
            p.stock,
            p.is_expected,
            p.stock_updated_at::text,
            p.is_active,
            p.created_at::text,
            p.updated_at::text
     from catalog_products p
     left join catalog_brands b on b.id = p.brand_id
     left join catalog_categories c on c.id = p.category_id
     left join catalog_subcategories s on s.id = p.subcategory_id
     where (
          $1 = ''
          or p.title ilike '%' || $1 || '%'
          or coalesce(p.article, '') ilike '%' || $1 || '%'
          or coalesce(b.title, '') ilike '%' || $1 || '%'
          or coalesce(c.title, '') ilike '%' || $1 || '%'
          or coalesce(s.title, '') ilike '%' || $1 || '%'
        )
       and ($2 = '' or coalesce(c.title, '') = $2)
       and ($3 = '' or coalesce(s.title, '') = $3)
       and ($4 = '' or coalesce(b.title, '') = $4)
       and ($5 = 'all' or ($5 = 'active' and p.is_active = true) or ($5 = 'inactive' and p.is_active = false))
     order by p.updated_at desc, p.id desc
     limit $6`,
    [normalizedSearch, normalizedCategory, normalizedSubcategory, normalizedBrand, normalizedActive, normalizedLimit],
  );
  return result.rows.map(mapAdminProduct);
}

export async function getCatalogAdminProductById(id: number) {
  await ensureCatalogSchema();
  const result = await query<Parameters<typeof mapAdminProduct>[0]>(
    `select p.id::text,
            p.title,
            p.article,
            b.title as brand,
            c.title as category,
            s.title as subcategory,
            p.price_group,
            p.price_eur::text,
            p.price_rub::text,
            p.price_cny::text,
            p.stock,
            p.is_expected,
            p.stock_updated_at::text,
            p.is_active,
            p.created_at::text,
            p.updated_at::text
     from catalog_products p
     left join catalog_brands b on b.id = p.brand_id
     left join catalog_categories c on c.id = p.category_id
     left join catalog_subcategories s on s.id = p.subcategory_id
     where p.id = $1
     limit 1`,
    [id],
  );
  return result.rows[0] ? mapAdminProduct(result.rows[0]) : null;
}

export async function createCatalogAdminProduct(input: CatalogProductInput) {
  await ensureCatalogSchema();
  await ensureSiteSchema();
  const normalized = normalizeInput(input);
  if (!normalized.title) throw new Error('Название товара обязательно');

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
  if (!normalized.title) throw new Error('Название товара обязательно');

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
           price_eur = $6,
           price_rub = $7,
           price_cny = $8,
           brand_id = $9,
           category_id = $10,
           subcategory_id = $11,
           stock = coalesce($12, stock),
           is_expected = coalesce($13, is_expected),
           stock_updated_at = case
             when $12::integer is not null and stock is distinct from $12 then now()
             when $13::boolean is not null and is_expected is distinct from $13 then now()
             else stock_updated_at
           end,
           is_active = $14,
           updated_at = now()
       where id = $1`,
      [
        normalizedId,
        slug,
        normalized.title,
        normalized.article,
        normalized.priceGroup,
        normalized.priceEur,
        normalized.priceRub,
        normalized.priceCny,
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
  const normalizedRows = rows.map(normalizeInput).filter((row) => row.title);
  if (normalizedRows.length === 0) throw new Error('В файле нет товаров для импорта');

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
