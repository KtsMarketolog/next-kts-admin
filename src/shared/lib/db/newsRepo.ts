import type { NewsItem } from '@/entities/site/model/defaultNews';

import { query } from './client';
import { ensureSiteSchema } from './schema';

type NewsRow = {
  id: string | number;
  date_label: string;
  title: string;
  image_url: string;
  link_url: string;
  sort_order: number;
  is_active: boolean;
};

function mapNewsItem(row: NewsRow): NewsItem {
  return {
    id: Number(row.id),
    date: row.date_label,
    title: row.title,
    imageUrl: row.image_url,
    linkUrl: row.link_url,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

export async function getNewsItems({ activeOnly = false } = {}) {
  await ensureSiteSchema();
  const result = await query<NewsRow>(
    `select id, date_label, title, image_url, link_url, sort_order, is_active
     from news_items
     ${activeOnly ? 'where is_active = true' : ''}
     order by sort_order asc, id asc`,
  );
  return result.rows.map(mapNewsItem);
}

export async function createNewsItem(item: Omit<NewsItem, 'id'>) {
  await ensureSiteSchema();
  const result = await query<{ id: string }>(
    `insert into news_items (date_label, title, image_url, link_url, sort_order, is_active)
     values ($1, $2, $3, $4, $5, $6)
     returning id`,
    [item.date, item.title, item.imageUrl, item.linkUrl, item.sortOrder, item.isActive],
  );
  return Number(result.rows[0].id);
}

export async function updateNewsItem(id: number, item: Partial<Omit<NewsItem, 'id'>>) {
  await ensureSiteSchema();
  await query(
    `update news_items
     set date_label = coalesce($2, date_label),
         title = coalesce($3, title),
         image_url = coalesce($4, image_url),
         link_url = coalesce($5, link_url),
         sort_order = coalesce($6, sort_order),
         is_active = coalesce($7, is_active),
         updated_at = now()
     where id = $1`,
    [
      id,
      item.date ?? null,
      item.title ?? null,
      item.imageUrl ?? null,
      item.linkUrl ?? null,
      item.sortOrder ?? null,
      item.isActive ?? null,
    ],
  );
}

export async function deleteNewsItem(id: number) {
  await ensureSiteSchema();
  await query(`delete from news_items where id = $1`, [id]);
}
