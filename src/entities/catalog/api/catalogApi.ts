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
  model?: string | null;
  category?: string | null;
  subcategory?: string | null;
  stock: number;
  isExpected: boolean;
  stockUpdatedAt: string | null;
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
  model: string | null;
  promo: boolean;
  brand_slug: string | null;
  brand_title: string | null;
  category_title: string | null;
  subcategory_title: string | null;
  stock: number | string | null;
  is_expected: boolean | null;
  stock_updated_at: string | null;
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
    model: row.model,
    category: row.category_title,
    subcategory: row.subcategory_title,
    stock: Number(row.stock ?? 0),
    isExpected: Boolean(row.is_expected),
    stockUpdatedAt: row.stock_updated_at,
  };
}

async function fetchProductsWhere(whereSql: string, params: unknown[]): Promise<Product[]> {
  await ensureCatalogSchema();
  const result = await query<ProductRow>(
    `select p.id::text as id,
            p.slug,
            p.title,
            p.article,
            p.model,
            p.promo,
            b.slug as brand_slug,
            b.title as brand_title,
            c.title as category_title,
            s.title as subcategory_title,
            p.stock,
            p.is_expected,
            p.stock_updated_at::text
     from catalog_products p
     inner join catalog_categories c on c.id = p.category_id and c.is_active = true and c.show_on_site = true
     left join catalog_brands b on b.id = p.brand_id and b.is_active = true
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
       and show_on_site = true
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
       and c.show_on_site = true
       and lower(c.slug) = lower($1)
     order by coalesce(cs.sort_order, s.sort_order) asc, s.title asc, s.id asc`,
    [categorySlug],
  );
  return result.rows.map(mapSubcategory);
}

export async function fetchSubcategoryMeta(
  subSlug: string,
  categorySlug = '',
): Promise<{ subTitle: string | null; catTitle: string | null }> {
  await ensureCatalogSchema();
  const result = await query<{ sub_title: string | null; cat_title: string | null }>(
    `select s.title as sub_title, c.title as cat_title
     from catalog_subcategories s
     inner join catalog_category_subcategories cs on cs.subcategory_id = s.id
     inner join catalog_categories c on c.id = cs.category_id and c.is_active = true and c.show_on_site = true
     where s.is_active = true
       and lower(s.slug) = lower($1)
       and ($2 = '' or lower(c.slug) = lower($2))
     order by cs.sort_order asc nulls last, c.id asc
     limit 1`,
    [subSlug, categorySlug],
  );

  return {
    subTitle: result.rows[0]?.sub_title ?? null,
    catTitle: result.rows[0]?.cat_title ?? null,
  };
}

export async function fetchAllBrands(): Promise<Brand[]> {
  await ensureCatalogSchema();
  const result = await query<BrandRow>(
    `select distinct b.slug, b.title, b.popular, b.logo_url
     from catalog_brands b
     inner join catalog_products p on p.brand_id = b.id and p.is_active = true
     inner join catalog_categories c on c.id = p.category_id and c.is_active = true and c.show_on_site = true
     where b.is_active = true
     order by b.title asc, b.slug asc`,
  );
  return result.rows.map(mapBrand);
}

export async function fetchPopularBrands(): Promise<Brand[]> {
  await ensureCatalogSchema();
  const result = await query<BrandRow>(
    `select distinct b.slug, b.title, b.popular, b.logo_url
     from catalog_brands b
     inner join catalog_products p on p.brand_id = b.id and p.is_active = true
     inner join catalog_categories c on c.id = p.category_id and c.is_active = true and c.show_on_site = true
     where b.is_active = true
       and b.popular = true
     order by b.title asc, b.slug asc`,
  );
  return result.rows.map(mapBrand);
}

export async function fetchBrandsBySubcategory(subSlug: string): Promise<Brand[]> {
  await ensureCatalogSchema();
  const result = await query<BrandRow>(
    `select distinct b.slug, b.title, b.popular, b.logo_url
     from catalog_products p
     inner join catalog_brands b on b.id = p.brand_id and b.is_active = true
     inner join catalog_subcategories s on s.id = p.subcategory_id and s.is_active = true
     inner join catalog_categories c on c.id = p.category_id and c.is_active = true and c.show_on_site = true
     where p.is_active = true
       and lower(s.slug) = lower($1)
     order by b.title asc, b.slug asc`,
    [subSlug],
  );
  return result.rows.map(mapBrand);
}

export async function fetchProductsBySubcategory(subSlug: string): Promise<Product[]> {
  return fetchProductsWhere('and lower(s.slug) = lower($1)', [subSlug]);
}

export async function fetchProductsByCategorySubcategory(categorySlug: string, subSlug: string): Promise<Product[]> {
  return fetchProductsWhere('and lower(c.slug) = lower($1) and lower(s.slug) = lower($2)', [categorySlug, subSlug]);
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

export async function fetchProductsByCategorySubcategoryBrand(
  categorySlug: string,
  subSlug: string,
  brandSlug: string,
): Promise<Product[]> {
  return fetchProductsWhere(
    'and lower(c.slug) = lower($1) and lower(s.slug) = lower($2) and lower(b.slug) = lower($3)',
    [categorySlug, subSlug, brandSlug],
  );
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
     from catalog_products p
     inner join catalog_brands b on b.id = p.brand_id and b.is_active = true
     inner join catalog_subcategories s on s.id = p.subcategory_id and s.is_active = true
     inner join catalog_categories c on c.id = p.category_id and c.is_active = true and c.show_on_site = true
     where p.is_active = true
       and lower(b.slug) = lower($1)
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
    `select p.title, p.slug
     from catalog_products p
     inner join catalog_categories c on c.id = p.category_id and c.is_active = true and c.show_on_site = true
     where p.is_active = true
       and (
         p.title ilike '%' || $1 || '%'
         or p.article ilike '%' || $1 || '%'
         or p.model ilike '%' || $1 || '%'
       )
     order by p.title asc, p.id asc
     limit 8`,
    [q],
  );
  return result.rows;
}
