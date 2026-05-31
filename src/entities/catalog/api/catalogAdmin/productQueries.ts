import { query } from '@/shared/lib/db/client';

import { ensureCatalogSchema } from '../catalogDb';
import { normalizeText } from './helpers';
import type {
  CatalogAdminFilterOptionFilters,
  CatalogAdminFilterOptions,
  CatalogAdminProduct,
  CatalogAdminProductFilters,
} from './types';
export async function getCatalogAdminFilterOptions(filters: CatalogAdminFilterOptionFilters = {}): Promise<CatalogAdminFilterOptions> {
  await ensureCatalogSchema();
  const normalizedCategory = normalizeText(filters.category, 180);
  const normalizedSubcategory = normalizeText(filters.subcategory, 180);
  const normalizedBrand = normalizeText(filters.brand, 180);
  const [categories, subcategories, brands] = await Promise.all([
    query<{ title: string }>(`
      select distinct c.title
      from catalog_categories c
      join catalog_products p on p.category_id = c.id
      left join catalog_subcategories s on s.id = p.subcategory_id
      left join catalog_brands b on b.id = p.brand_id
      where c.is_active = true
        and p.is_active = true
        and nullif(trim(c.title), '') is not null
        and ($1 = '' or coalesce(s.title, '') = $1)
        and ($2 = '' or coalesce(b.title, '') = $2)
      order by c.title
    `, [normalizedSubcategory, normalizedBrand]),
    query<{ title: string }>(`
      select distinct s.title
      from catalog_subcategories s
      join catalog_products p on p.subcategory_id = s.id
      left join catalog_categories c on c.id = p.category_id
      left join catalog_brands b on b.id = p.brand_id
      where s.is_active = true
        and p.is_active = true
        and nullif(trim(s.title), '') is not null
        and ($1 = '' or coalesce(c.title, '') = $1)
        and ($2 = '' or coalesce(b.title, '') = $2)
      order by s.title
    `, [normalizedCategory, normalizedBrand]),
    query<{ title: string }>(`
      select distinct b.title
      from catalog_brands b
      join catalog_products p on p.brand_id = b.id
      left join catalog_categories c on c.id = p.category_id
      left join catalog_subcategories s on s.id = p.subcategory_id
      where b.is_active = true
        and p.is_active = true
        and nullif(trim(b.title), '') is not null
        and ($1 = '' or coalesce(c.title, '') = $1)
        and ($2 = '' or coalesce(s.title, '') = $2)
      order by b.title
    `, [normalizedCategory, normalizedSubcategory]),
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
  unit: string | null;
  price_eur: string | null;
  price_rub: string | null;
  price_cny: string | null;
  general_discount: string | null;
  manual_discount: string | null;
  manual_discount_rop: string | null;
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
    unit: row.unit ?? '',
    priceEur: row.price_eur ?? '',
    priceRub: row.price_rub ?? '',
    priceCny: row.price_cny ?? '',
    generalDiscount: row.general_discount ?? '',
    manualDiscount: row.manual_discount ?? '',
    manualDiscountRop: row.manual_discount_rop ?? '',
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
            p.unit,
            p.price_eur::text,
            p.price_rub::text,
            p.price_cny::text,
            p.general_discount::text,
            p.manual_discount::text,
            p.manual_discount_rop::text,
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
            p.unit,
            p.price_eur::text,
            p.price_rub::text,
            p.price_cny::text,
            p.general_discount::text,
            p.manual_discount::text,
            p.manual_discount_rop::text,
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
