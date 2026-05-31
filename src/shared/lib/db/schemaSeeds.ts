import { DEFAULT_BRAND_CATEGORIES, DEFAULT_BRAND_ITEMS } from '@/entities/site/model/defaultBrands';
import { DEFAULT_GROUP_COMPANIES } from '@/entities/site/model/defaultGroupCompanies';
import { DEFAULT_HERO_SLIDES } from '@/entities/site/model/defaultSlides';
import { DEFAULT_NEWS } from '@/entities/site/model/defaultNews';

import { DEFAULT_ADDRESS, DEFAULT_EMAIL, DEFAULT_PHONE } from '../phone';
import { query } from './client';

export async function seedSiteSettings() {
  await query(
    `insert into site_settings (key, value)
     values ('phone', $1)
     on conflict (key) do nothing`,
    [DEFAULT_PHONE],
  );
  await query(
    `insert into site_settings (key, value)
     values ('email', $1), ('address', $2)
     on conflict (key) do nothing`,
    [DEFAULT_EMAIL, DEFAULT_ADDRESS],
  );
}

export async function seedHeroSlides() {
  const count = await query<{ count: string }>('select count(*)::text as count from hero_slides');
  if (Number(count.rows[0]?.count ?? 0) !== 0) return;

  for (const slide of DEFAULT_HERO_SLIDES) {
    await query(
      `insert into hero_slides (
         title, image_url, tablet_image_url, mobile_image_url,
         popup_image_url, popup_tablet_image_url, popup_mobile_image_url, popup_title, popup_text,
         link_url, sort_order, is_active
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        slide.title,
        slide.imageUrl,
        slide.tabletImageUrl,
        slide.mobileImageUrl,
        slide.popupImageUrl,
        slide.popupTabletImageUrl,
        slide.popupMobileImageUrl,
        slide.popupTitle,
        slide.popupText,
        slide.linkUrl,
        slide.sortOrder,
        slide.isActive,
      ],
    );
  }
}

export async function seedNewsItems() {
  const newsCount = await query<{ count: string }>('select count(*)::text as count from news_items');
  if (Number(newsCount.rows[0]?.count ?? 0) !== 0) return;

  for (const item of DEFAULT_NEWS) {
    await query(
      `insert into news_items (date_label, title, image_url, link_url, sort_order, is_active)
       values ($1, $2, $3, $4, $5, $6)`,
      [item.date, item.title, item.imageUrl, item.linkUrl, item.sortOrder, item.isActive],
    );
  }
}

export async function seedBrandPortfolio() {
  const brandCategoryCount = await query<{ count: string }>('select count(*)::text as count from brand_categories');
  if (Number(brandCategoryCount.rows[0]?.count ?? 0) === 0) {
    for (const category of DEFAULT_BRAND_CATEGORIES) {
      await query(
        `insert into brand_categories (key, title, sort_order, is_active)
         values ($1, $2, $3, $4)`,
        [category.key, category.title, category.sortOrder, category.isActive],
      );
    }
  }

  const brandItemCount = await query<{ count: string }>('select count(*)::text as count from brand_items');
  if (Number(brandItemCount.rows[0]?.count ?? 0) !== 0) return;

  const categories = await query<{ id: string; key: string }>('select id, key from brand_categories');
  const categoryIdByKey = new Map(categories.rows.map((row) => [row.key, Number(row.id)]));
  for (const item of DEFAULT_BRAND_ITEMS) {
    const categoryId = categoryIdByKey.get(item.categoryKey);
    if (!categoryId) continue;
    await query(
      `insert into brand_items (category_id, name, image_url, icon_key, sort_order, is_active)
       values ($1, $2, $3, $4, $5, $6)`,
      [categoryId, item.name, item.imageUrl, item.iconKey, item.sortOrder, item.isActive],
    );
  }
}

export async function seedGroupCompanies() {
  const groupCompanyCount = await query<{ count: string }>('select count(*)::text as count from group_companies');
  if (Number(groupCompanyCount.rows[0]?.count ?? 0) === 0) {
    for (const company of DEFAULT_GROUP_COMPANIES) {
      await query(
        `insert into group_companies (image_url, link_url, sort_order, is_active)
         values ($1, $2, $3, $4)`,
        [company.imageUrl, company.linkUrl, company.sortOrder, company.isActive],
      );
    }
  }
}
