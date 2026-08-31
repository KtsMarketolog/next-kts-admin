import { cache } from 'react';
import { unstable_cache } from 'next/cache';

import { query } from '@/shared/lib/db';
import { ensureCatalogSchema } from './catalogDb';
import { PUBLIC_CATALOG_CACHE_TAG } from './catalogRevalidation';

export const CATALOG_PAGE_SIZE = 36;

export type CatalogCategorySeoData = {
  slug: string;
  title: string;
  subtitle: string | null;
  image: string | null;
  productCount: number;
};

export type CatalogSubcategorySeoData = {
  categorySlug: string;
  categoryTitle: string;
  categoryImage: string | null;
  subcategorySlug: string;
  subcategoryTitle: string;
  productCount: number;
};

export type CatalogBrandSeoData = {
  slug: string;
  title: string;
  logo: string | null;
  productCount: number;
};

export type CatalogSubcategoryBrandSeoData = CatalogSubcategorySeoData & {
  brandSlug: string;
  brandTitle: string;
  brandLogo: string | null;
};

type CategorySeoRow = {
  slug: string;
  title: string;
  subtitle: string | null;
  image_url: string | null;
  product_count: string;
};

type SubcategorySeoRow = {
  category_slug: string;
  category_title: string;
  category_image_url: string | null;
  subcategory_slug: string;
  subcategory_title: string;
  product_count: string;
};

type BrandSeoRow = {
  slug: string;
  title: string;
  logo_url: string | null;
  product_count: string;
};

type SubcategoryBrandSeoRow = SubcategorySeoRow & {
  brand_slug: string;
  brand_title: string;
  brand_logo_url: string | null;
};

async function loadPublicCategorySeoData(slug: string): Promise<CatalogCategorySeoData | null> {
  await ensureCatalogSchema();
  const result = await query<CategorySeoRow>(
    `select c.slug,
            c.title,
            c.subtitle,
            c.image_url,
            (
              select count(*)::text
              from catalog_products p
              where p.category_id = c.id
                and p.is_active = true
            ) as product_count
     from catalog_categories c
     where c.is_active = true
       and c.show_on_site = true
       and lower(c.slug) = lower($1)
     limit 1`,
    [slug],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    image: row.image_url,
    productCount: Number(row.product_count),
  };
}

async function loadPublicSubcategorySeoData(
  categorySlug: string,
  subcategorySlug: string,
): Promise<CatalogSubcategorySeoData | null> {
  await ensureCatalogSchema();
  const result = await query<SubcategorySeoRow>(
    `select c.slug as category_slug,
            c.title as category_title,
            c.image_url as category_image_url,
            s.slug as subcategory_slug,
            s.title as subcategory_title,
            (
              select count(*)::text
              from catalog_products p
              where p.category_id = c.id
                and p.subcategory_id = s.id
                and p.is_active = true
            ) as product_count
     from catalog_categories c
     inner join catalog_category_subcategories cs on cs.category_id = c.id
     inner join catalog_subcategories s on s.id = cs.subcategory_id
     where c.is_active = true
       and c.show_on_site = true
       and s.is_active = true
       and lower(c.slug) = lower($1)
       and lower(s.slug) = lower($2)
     limit 1`,
    [categorySlug, subcategorySlug],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    categorySlug: row.category_slug,
    categoryTitle: row.category_title,
    categoryImage: row.category_image_url,
    subcategorySlug: row.subcategory_slug,
    subcategoryTitle: row.subcategory_title,
    productCount: Number(row.product_count),
  };
}

async function loadPublicBrandSeoData(slug: string): Promise<CatalogBrandSeoData | null> {
  await ensureCatalogSchema();
  const result = await query<BrandSeoRow>(
    `select b.slug,
            b.title,
            b.logo_url,
            (count(p.id) filter (where c.id is not null))::text as product_count
     from catalog_brands b
     left join catalog_products p
       on p.brand_id = b.id
      and p.is_active = true
     left join catalog_categories c
       on c.id = p.category_id
      and c.is_active = true
      and c.show_on_site = true
     where b.is_active = true
       and lower(b.slug) = lower($1)
     group by b.id, b.slug, b.title, b.logo_url
     limit 1`,
    [slug],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    slug: row.slug,
    title: row.title,
    logo: row.logo_url,
    productCount: Number(row.product_count),
  };
}

async function loadPublicSubcategoryBrandSeoData(
  categorySlug: string,
  subcategorySlug: string,
  brandSlug: string,
): Promise<CatalogSubcategoryBrandSeoData | null> {
  await ensureCatalogSchema();
  const result = await query<SubcategoryBrandSeoRow>(
    `select c.slug as category_slug,
            c.title as category_title,
            c.image_url as category_image_url,
            s.slug as subcategory_slug,
            s.title as subcategory_title,
            b.slug as brand_slug,
            b.title as brand_title,
            b.logo_url as brand_logo_url,
            (
              select count(*)::text
              from catalog_products p
              where p.category_id = c.id
                and p.subcategory_id = s.id
                and p.brand_id = b.id
                and p.is_active = true
            ) as product_count
     from catalog_categories c
     inner join catalog_category_subcategories cs on cs.category_id = c.id
     inner join catalog_subcategories s on s.id = cs.subcategory_id
     inner join catalog_brand_subcategories bs on bs.subcategory_id = s.id
     inner join catalog_brands b on b.id = bs.brand_id
     inner join catalog_brand_categories bc
       on bc.brand_id = b.id
      and bc.category_id = c.id
     where c.is_active = true
       and c.show_on_site = true
       and s.is_active = true
       and b.is_active = true
       and lower(c.slug) = lower($1)
       and lower(s.slug) = lower($2)
       and lower(b.slug) = lower($3)
     limit 1`,
    [categorySlug, subcategorySlug, brandSlug],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    categorySlug: row.category_slug,
    categoryTitle: row.category_title,
    categoryImage: row.category_image_url,
    subcategorySlug: row.subcategory_slug,
    subcategoryTitle: row.subcategory_title,
    brandSlug: row.brand_slug,
    brandTitle: row.brand_title,
    brandLogo: row.brand_logo_url,
    productCount: Number(row.product_count),
  };
}

async function loadPromoProductCount(): Promise<number> {
  await ensureCatalogSchema();
  const result = await query<{ product_count: string }>(
    `select count(*)::text as product_count
     from catalog_products p
     inner join catalog_categories c
       on c.id = p.category_id
      and c.is_active = true
      and c.show_on_site = true
     where p.is_active = true
       and p.promo = true`,
  );

  return Number(result.rows[0]?.product_count ?? 0);
}

const catalogSeoCacheOptions = {
  revalidate: 60,
  tags: [PUBLIC_CATALOG_CACHE_TAG],
};

const loadCachedPublicCategorySeoData = unstable_cache(
  loadPublicCategorySeoData,
  ['public-catalog-category-seo'],
  catalogSeoCacheOptions,
);
const loadCachedPublicSubcategorySeoData = unstable_cache(
  loadPublicSubcategorySeoData,
  ['public-catalog-subcategory-seo'],
  catalogSeoCacheOptions,
);
const loadCachedPublicBrandSeoData = unstable_cache(
  loadPublicBrandSeoData,
  ['public-catalog-brand-seo'],
  catalogSeoCacheOptions,
);
const loadCachedPublicSubcategoryBrandSeoData = unstable_cache(
  loadPublicSubcategoryBrandSeoData,
  ['public-catalog-subcategory-brand-seo'],
  catalogSeoCacheOptions,
);
const loadCachedPromoProductCount = unstable_cache(
  loadPromoProductCount,
  ['public-catalog-promo-count'],
  catalogSeoCacheOptions,
);

export const getPublicCategorySeoData = cache(loadCachedPublicCategorySeoData);
export const getPublicSubcategorySeoData = cache(loadCachedPublicSubcategorySeoData);
export const getPublicBrandSeoData = cache(loadCachedPublicBrandSeoData);
export const getPublicSubcategoryBrandSeoData = cache(loadCachedPublicSubcategoryBrandSeoData);
export const getPromoProductCount = cache(loadCachedPromoProductCount);

export function normalizeCatalogRouteParam(value: string | undefined): string {
  const normalized = (value ?? '').trim();
  if (!normalized) return '';

  try {
    return decodeURIComponent(normalized).trim();
  } catch {
    return '';
  }
}

export function readCatalogPage(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^[1-9]\d*$/.test(raw)) return 1;

  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : 1;
}

export function hasUnsupportedCatalogQuery(
  searchParams: { [key: string]: string | string[] | undefined },
  allowPagination = true,
): boolean {
  const entries = Object.entries(searchParams);
  if (entries.some(([key]) => key !== 'page')) return true;

  const pageValue = searchParams.page;
  if (pageValue === undefined) return false;
  if (!allowPagination || Array.isArray(pageValue)) return true;

  return !/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(Number(pageValue));
}

export function getCatalogTotalPages(total: number, pageSize = CATALOG_PAGE_SIZE): number {
  if (total <= 0) return 1;
  return Math.ceil(total / pageSize);
}

export function catalogPagePath(basePath: string, page: number): string {
  return page > 1 ? `${basePath}?page=${page}` : basePath;
}

export function catalogRedirectPath(
  basePath: string,
  searchParams: { [key: string]: string | string[] | undefined },
): string {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      value.forEach((item) => query.append(key, item));
    } else if (value !== undefined) {
      query.set(key, value);
    }
  }

  const serialized = query.toString();
  return serialized ? `${basePath}?${serialized}` : basePath;
}
