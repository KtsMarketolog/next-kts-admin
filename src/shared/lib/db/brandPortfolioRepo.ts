import type { BrandCategory, BrandItem } from '@/entities/site/model/defaultBrands';

import { query } from './client';
import { ensureSiteSchema } from './schema';

type BrandCategoryRow = {
  id: string | number;
  key: string;
  title: string;
  sort_order: number;
  is_active: boolean;
};

type BrandItemRow = {
  id: string | number;
  category_id: string | number;
  name: string;
  image_url: string;
  icon_key: string;
  sort_order: number;
  is_active: boolean;
};

function mapBrandCategory(row: BrandCategoryRow): BrandCategory {
  return {
    id: Number(row.id),
    key: row.key,
    title: row.title,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

function mapBrandItem(row: BrandItemRow): BrandItem {
  return {
    id: Number(row.id),
    categoryId: Number(row.category_id),
    name: row.name,
    imageUrl: row.image_url,
    iconKey: row.icon_key,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

export async function getBrandCategories({ activeOnly = false } = {}) {
  await ensureSiteSchema();
  const result = await query<BrandCategoryRow>(
    `select id, key, title, sort_order, is_active
     from brand_categories
     ${activeOnly ? 'where is_active = true' : ''}
     order by sort_order asc, id asc`,
  );
  return result.rows.map(mapBrandCategory);
}

export async function getBrandItems({ activeOnly = false } = {}) {
  await ensureSiteSchema();
  const result = await query<BrandItemRow>(
    `select id, category_id, name, image_url, icon_key, sort_order, is_active
     from brand_items
     ${activeOnly ? 'where is_active = true' : ''}
     order by category_id asc, sort_order asc, id asc`,
  );
  return result.rows.map(mapBrandItem);
}

export async function getBrandPortfolio({ activeOnly = false } = {}) {
  const [categories, brands] = await Promise.all([
    getBrandCategories({ activeOnly }),
    getBrandItems({ activeOnly }),
  ]);

  const activeCategoryIds = new Set(categories.map((category) => category.id));
  return {
    categories,
    brands: brands.filter((brand) => activeCategoryIds.has(brand.categoryId)),
  };
}

export async function createBrandCategory(category: Omit<BrandCategory, 'id'>) {
  await ensureSiteSchema();
  const result = await query<{ id: string }>(
    `insert into brand_categories (key, title, sort_order, is_active)
     values ($1, $2, $3, $4)
     returning id`,
    [category.key, category.title, category.sortOrder, category.isActive],
  );
  return Number(result.rows[0].id);
}

export async function updateBrandCategory(id: number, category: Partial<Omit<BrandCategory, 'id'>>) {
  await ensureSiteSchema();
  await query(
    `update brand_categories
     set key = coalesce($2, key),
         title = coalesce($3, title),
         sort_order = coalesce($4, sort_order),
         is_active = coalesce($5, is_active),
         updated_at = now()
     where id = $1`,
    [id, category.key ?? null, category.title ?? null, category.sortOrder ?? null, category.isActive ?? null],
  );
}

export async function deleteBrandCategory(id: number) {
  await ensureSiteSchema();
  await query(`delete from brand_categories where id = $1`, [id]);
}

export async function createBrandItem(item: Omit<BrandItem, 'id'>) {
  await ensureSiteSchema();
  const result = await query<{ id: string }>(
    `insert into brand_items (category_id, name, image_url, icon_key, sort_order, is_active)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [item.categoryId, item.name, item.imageUrl, item.iconKey, item.sortOrder, item.isActive],
  );
  return Number(result.rows[0].id);
}

export async function updateBrandItem(id: number, item: Partial<Omit<BrandItem, 'id'>>) {
  await ensureSiteSchema();
  await query(
    `update brand_items
     set category_id = coalesce($2, category_id),
         name = coalesce($3, name),
         image_url = coalesce($4, image_url),
         icon_key = coalesce($5, icon_key),
         sort_order = coalesce($6, sort_order),
         is_active = coalesce($7, is_active),
         updated_at = now()
     where id = $1`,
    [
      id,
      item.categoryId ?? null,
      item.name ?? null,
      item.imageUrl ?? null,
      item.iconKey ?? null,
      item.sortOrder ?? null,
      item.isActive ?? null,
    ],
  );
}

export async function deleteBrandItem(id: number) {
  await ensureSiteSchema();
  await query(`delete from brand_items where id = $1`, [id]);
}
