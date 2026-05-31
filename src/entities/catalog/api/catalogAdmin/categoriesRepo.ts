import { query } from '@/shared/lib/db/client';

import { ensureCatalogSchema } from '../catalogDb';
import { normalizeText } from './helpers';
import type { CatalogAdminCategory } from './types';
function mapAdminCategory(row: {
  id: string;
  title: string;
  slug: string;
  icon_url: string | null;
  product_count: string;
  is_active: boolean;
  show_on_site: boolean | null;
}): CatalogAdminCategory {
  return {
    id: Number(row.id),
    title: row.title,
    slug: row.slug,
    iconUrl: row.icon_url ?? '',
    productCount: Number(row.product_count ?? 0),
    isActive: row.is_active,
    showOnSite: row.show_on_site !== false,
  };
}

export async function getCatalogAdminCategories(): Promise<CatalogAdminCategory[]> {
  await ensureCatalogSchema();
  const result = await query<Parameters<typeof mapAdminCategory>[0]>(`
    select
      c.id::text,
      c.title,
      c.slug,
      c.icon_url,
      c.is_active,
      c.show_on_site,
      count(p.id)::text as product_count
    from catalog_categories c
    left join catalog_products p on p.category_id = c.id and p.is_active = true
    where c.is_active = true
    group by c.id
    order by c.sort_order asc, c.title asc, c.id asc
  `);
  return result.rows.map(mapAdminCategory);
}

export async function updateCatalogAdminCategory(
  id: number,
  input: { iconUrl?: string | null; showOnSite?: boolean | null },
): Promise<CatalogAdminCategory> {
  await ensureCatalogSchema();
  const normalizedId = Number(id);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) throw new Error('Некорректная категория');
  const hasIconUrl = Object.prototype.hasOwnProperty.call(input, 'iconUrl');
  const hasShowOnSite = typeof input.showOnSite === 'boolean';
  const normalizedIconUrl = hasIconUrl ? normalizeText(input.iconUrl, 1000) : '';

  const result = await query<Parameters<typeof mapAdminCategory>[0]>(
    `update catalog_categories
     set icon_url = case when $2 then nullif($3, '') else icon_url end,
         show_on_site = case when $4 then $5 else show_on_site end,
         updated_at = now()
     where id = $1
     returning
       id::text,
       title,
       slug,
       icon_url,
       is_active,
       show_on_site,
       (
         select count(*)::text
         from catalog_products p
         where p.category_id = catalog_categories.id
           and p.is_active = true
       ) as product_count`,
    [normalizedId, hasIconUrl, normalizedIconUrl, hasShowOnSite, hasShowOnSite ? input.showOnSite : null],
  );

  const row = result.rows[0];
  if (!row) throw new Error('Категория не найдена');
  return mapAdminCategory(row);
}

export async function updateCatalogAdminCategoryIcon(id: number, iconUrl: string | null): Promise<CatalogAdminCategory> {
  return updateCatalogAdminCategory(id, { iconUrl });
}
