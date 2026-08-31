import type { MetadataRoute } from "next";

import { query } from "@/shared/lib/db";

import { canonicalUrl } from "./siteUrl";

export type CatalogSitemapData = {
  categories: Array<{ slug: string; imageUrl: string | null }>;
  subcategories: Array<{ categorySlug: string; slug: string }>;
  brands: Array<{ slug: string; logoUrl: string | null }>;
  hasActivePromoProducts: boolean;
};

type CategoryRow = { slug: string; image_url: string | null };
type SubcategoryRow = { category_slug: string; slug: string };
type BrandRow = { slug: string; logo_url: string | null };

export const EMPTY_CATALOG_SITEMAP_DATA: CatalogSitemapData = {
  categories: [],
  subcategories: [],
  brands: [],
  hasActivePromoProducts: false,
};

export async function loadCatalogSitemapData(): Promise<CatalogSitemapData> {
  const [categories, subcategories, brands, promo] = await Promise.all([
    query<CategoryRow>(
      `select distinct c.slug, c.image_url
       from catalog_categories c
       inner join catalog_products p
         on p.category_id = c.id and p.is_active = true
       where c.is_active = true
         and c.show_on_site = true
       order by c.slug asc`,
    ),
    query<SubcategoryRow>(
      `select distinct c.slug as category_slug, s.slug
       from catalog_category_subcategories cs
       inner join catalog_categories c
         on c.id = cs.category_id and c.is_active = true and c.show_on_site = true
       inner join catalog_subcategories s
         on s.id = cs.subcategory_id and s.is_active = true
       inner join catalog_products p
         on p.category_id = c.id
        and p.subcategory_id = s.id
        and p.is_active = true
       order by c.slug asc, s.slug asc`,
    ),
    query<BrandRow>(
      `select distinct b.slug, b.logo_url
       from catalog_products p
       inner join catalog_categories c
         on c.id = p.category_id and c.is_active = true and c.show_on_site = true
       inner join catalog_brands b
         on b.id = p.brand_id and b.is_active = true
       where p.is_active = true
       order by b.slug asc`,
    ),
    query<{ exists: boolean }>(
      `select exists (
         select 1
         from catalog_products p
         inner join catalog_categories c
           on c.id = p.category_id and c.is_active = true and c.show_on_site = true
         where p.is_active = true and p.promo = true
       ) as exists`,
    ),
  ]);

  return {
    categories: categories.rows.map((row) => ({
      slug: row.slug,
      imageUrl: row.image_url,
    })),
    subcategories: subcategories.rows.map((row) => ({
      categorySlug: row.category_slug,
      slug: row.slug,
    })),
    brands: brands.rows.map((row) => ({
      slug: row.slug,
      logoUrl: row.logo_url,
    })),
    hasActivePromoProducts: Boolean(promo.rows[0]?.exists),
  };
}

function absoluteImageUrl(imageUrl: string | null): string[] | undefined {
  const value = imageUrl?.trim();
  if (!value) return undefined;

  if (/^https?:\/\//i.test(value)) {
    return [value.replace(/^http:\/\//i, "https://")];
  }

  return [canonicalUrl(value.startsWith("/") ? value : `/${value}`)];
}

function segment(value: string): string {
  return encodeURIComponent(value.trim());
}

function deduplicateEntries(
  entries: MetadataRoute.Sitemap,
): MetadataRoute.Sitemap {
  const unique = new Map<string, MetadataRoute.Sitemap[number]>();

  for (const entry of entries) {
    const key = new URL(entry.url).href.toLowerCase();
    if (!unique.has(key)) unique.set(key, entry);
  }

  return [...unique.values()];
}

export function buildSitemap(
  data: CatalogSitemapData,
): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [
    { url: canonicalUrl("/"), changeFrequency: "weekly", priority: 1 },
    { url: canonicalUrl("/catalog"), changeFrequency: "daily", priority: 0.9 },
    { url: canonicalUrl("/catalog/brands"), changeFrequency: "daily", priority: 0.8 },
    { url: canonicalUrl("/about"), changeFrequency: "monthly", priority: 0.6 },
    { url: canonicalUrl("/contacts"), changeFrequency: "monthly", priority: 0.6 },
    { url: canonicalUrl("/klimatika"), changeFrequency: "monthly", priority: 0.6 },
  ];

  for (const category of data.categories) {
    if (!category.slug.trim()) continue;
    entries.push({
      url: canonicalUrl(`/catalog/${segment(category.slug)}`),
      changeFrequency: "daily",
      priority: 0.8,
      images: absoluteImageUrl(category.imageUrl),
    });
  }

  for (const subcategory of data.subcategories) {
    if (!subcategory.categorySlug.trim() || !subcategory.slug.trim()) continue;
    entries.push({
      url: canonicalUrl(
        `/catalog/${segment(subcategory.categorySlug)}/${segment(subcategory.slug)}`,
      ),
      changeFrequency: "daily",
      priority: 0.7,
    });
  }

  for (const brand of data.brands) {
    if (!brand.slug.trim()) continue;
    entries.push({
      url: canonicalUrl(`/catalog/brands/${segment(brand.slug)}`),
      changeFrequency: "daily",
      priority: 0.7,
      images: absoluteImageUrl(brand.logoUrl),
    });
  }

  if (data.hasActivePromoProducts) {
    entries.push({
      url: canonicalUrl("/catalog/promo"),
      changeFrequency: "daily",
      priority: 0.8,
    });
  }

  return deduplicateEntries(entries);
}
