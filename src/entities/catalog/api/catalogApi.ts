import { query } from '@/shared/lib/db';
import { ensureCatalogSchema } from './catalogDb';

export type Category = {
  slug: string;
  title: string;
  subtitle?: string;
  sortOrder?: number;
  icon?: string;
  image?: string;
};

export type Subcategory = { slug: string; title: string; sortOrder?: number };
export type Brand = { slug: string; title: string; popular?: boolean; logo?: string | null };

export type Product = {
  id: string;
  slug: string;
  title: string;
  brand?: string;
  brandTitle?: string | null;
  promo?: boolean;
  article?: string | null;
  category?: string | null;
  subcategory?: string | null;
};

export type BrandSubLite = { slug: string; title: string; category?: string };

type CategoryRow = {
  slug: string;
  title: string;
  subtitle: string | null;
  sort_order: number;
  icon_url: string | null;
  image_url: string | null;
};

type SubcategoryRow = {
  slug: string;
  title: string;
  sort_order: number;
};

type BrandRow = {
  slug: string;
  title: string;
  popular: boolean;
  logo_url: string | null;
};

type ProductRow = {
  id: string;
  slug: string;
  title: string;
  article: string | null;
  promo: boolean;
  brand_slug: string | null;
  brand_title: string | null;
  category_title: string | null;
  subcategory_title: string | null;
};

function mapCategory(row: CategoryRow): Category {
  return {
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle ?? undefined,
    sortOrder: row.sort_order,
    icon: row.icon_url ?? undefined,
    image: row.image_url ?? undefined,
  };
}

function mapSubcategory(row: SubcategoryRow): Subcategory {
  return {
    slug: row.slug,
    title: row.title,
    sortOrder: row.sort_order,
  };
}

function mapBrand(row: BrandRow): Brand {
  return {
    slug: row.slug,
    title: row.title,
    popular: row.popular,
    logo: row.logo_url,
  };
}

function mapProduct(row: ProductRow): Product {
  return {
    id: String(row.id),
    slug: row.slug,
    title: row.title,
    brand: row.brand_slug ?? undefined,
    brandTitle: row.brand_title,
    promo: row.promo,
    article: row.article,
    category: row.category_title,
    subcategory: row.subcategory_title,
  };
}

async function fetchProductsWhere(whereSql: string, params: unknown[]): Promise<Product[]> {
  await ensureCatalogSchema();
  const result = await query<ProductRow>(
    `select p.id::text as id,
            p.slug,
            p.title,
            p.article,
            p.promo,
            b.slug as brand_slug,
            b.title as brand_title,
            c.title as category_title,
            s.title as subcategory_title
     from catalog_products p
     left join catalog_brands b on b.id = p.brand_id and b.is_active = true
     left join catalog_categories c on c.id = p.category_id and c.is_active = true
     left join catalog_subcategories s on s.id = p.subcategory_id and s.is_active = true
     where p.is_active = true
       ${whereSql}
     order by p.title asc, p.id asc`,
    params,
  );
  return result.rows.map(mapProduct);
}

export async function fetchCategories(): Promise<Category[]> {
  await ensureCatalogSchema();
  const result = await query<CategoryRow>(
    `select slug, title, subtitle, sort_order, icon_url, image_url
     from catalog_categories
     where is_active = true
     order by sort_order asc, id asc`,
  );
  return result.rows.map(mapCategory);
}

export async function fetchSubcategories(categorySlug: string): Promise<Subcategory[]> {
  await ensureCatalogSchema();
  const result = await query<SubcategoryRow>(
    `select s.slug, s.title, coalesce(cs.sort_order, s.sort_order) as sort_order
     from catalog_subcategories s
     inner join catalog_category_subcategories cs on cs.subcategory_id = s.id
     inner join catalog_categories c on c.id = cs.category_id
     where s.is_active = true
       and c.is_active = true
       and lower(c.slug) = lower($1)
     order by coalesce(cs.sort_order, s.sort_order) asc, s.title asc, s.id asc`,
    [categorySlug],
  );
  return result.rows.map(mapSubcategory);
}

export async function fetchSubcategoryMeta(
  subSlug: string,
): Promise<{ subTitle: string | null; catTitle: string | null }> {
  await ensureCatalogSchema();
  const result = await query<{ sub_title: string | null; cat_title: string | null }>(
    `select s.title as sub_title, c.title as cat_title
     from catalog_subcategories s
     left join catalog_category_subcategories cs on cs.subcategory_id = s.id
     left join catalog_categories c on c.id = cs.category_id and c.is_active = true
     where s.is_active = true
       and lower(s.slug) = lower($1)
     order by cs.sort_order asc nulls last, c.id asc
     limit 1`,
    [subSlug],
  );

  return {
    subTitle: result.rows[0]?.sub_title ?? null,
    catTitle: result.rows[0]?.cat_title ?? null,
  };
}

export async function fetchAllBrands(): Promise<Brand[]> {
  await ensureCatalogSchema();
  const result = await query<BrandRow>(
    `select slug, title, popular, logo_url
     from catalog_brands
     where is_active = true
     order by title asc, id asc`,
  );
  return result.rows.map(mapBrand);
}

export async function fetchPopularBrands(): Promise<Brand[]> {
  await ensureCatalogSchema();
  const result = await query<BrandRow>(
    `select slug, title, popular, logo_url
     from catalog_brands
     where is_active = true
       and popular = true
     order by title asc, id asc`,
  );
  return result.rows.map(mapBrand);
}

export async function fetchBrandsBySubcategory(subSlug: string): Promise<Brand[]> {
  await ensureCatalogSchema();
  const result = await query<BrandRow>(
    `select distinct b.slug, b.title, b.popular, b.logo_url
     from catalog_brands b
     inner join catalog_subcategories s on lower(s.slug) = lower($1) and s.is_active = true
     where b.is_active = true
       and (
         exists (
           select 1
           from catalog_brand_subcategories bs
           where bs.brand_id = b.id
             and bs.subcategory_id = s.id
         )
         or exists (
           select 1
           from catalog_products p
           where p.brand_id = b.id
             and p.subcategory_id = s.id
             and p.is_active = true
         )
       )
     order by b.title asc, b.slug asc`,
    [subSlug],
  );
  return result.rows.map(mapBrand);
}

export async function fetchProductsBySubcategory(subSlug: string): Promise<Product[]> {
  return fetchProductsWhere('and lower(s.slug) = lower($1)', [subSlug]);
}

export async function fetchProductsBySubcategoryBrand(
  subSlug: string,
  brandSlug: string,
): Promise<Product[]> {
  return fetchProductsWhere('and lower(s.slug) = lower($1) and lower(b.slug) = lower($2)', [
    subSlug,
    brandSlug,
  ]);
}

export async function fetchProductsByBrand(brandSlug: string): Promise<Product[]> {
  return fetchProductsWhere('and lower(b.slug) = lower($1)', [brandSlug]);
}

export async function fetchPromoProducts(): Promise<Product[]> {
  return fetchProductsWhere('and p.promo = true', []);
}

export async function fetchBrandSubcategories(brandSlug: string): Promise<BrandSubLite[]> {
  await ensureCatalogSchema();
  const result = await query<BrandSubLite>(
    `select distinct s.slug,
            s.title,
            c.slug as category
     from catalog_subcategories s
     inner join catalog_brands b on lower(b.slug) = lower($1) and b.is_active = true
     left join catalog_category_subcategories cs on cs.subcategory_id = s.id
     left join catalog_categories c on c.id = cs.category_id and c.is_active = true
     where s.is_active = true
       and (
         exists (
           select 1
           from catalog_brand_subcategories bs
           where bs.brand_id = b.id
             and bs.subcategory_id = s.id
         )
         or exists (
           select 1
           from catalog_products p
           where p.brand_id = b.id
             and p.subcategory_id = s.id
             and p.is_active = true
         )
       )
     order by s.title asc, s.slug asc`,
    [brandSlug],
  );
  return result.rows;
}

export async function searchProducts(queryText: string): Promise<Array<{ title: string; slug: string }>> {
  const q = queryText.trim();
  if (!q) return [];

  await ensureCatalogSchema();
  const result = await query<{ title: string; slug: string }>(
    `select title, slug
     from catalog_products
     where is_active = true
       and (
         title ilike '%' || $1 || '%'
         or article ilike '%' || $1 || '%'
       )
     order by title asc, id asc
     limit 8`,
    [q],
  );
  return result.rows;
}
