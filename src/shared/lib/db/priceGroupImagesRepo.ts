import { query } from './client';
import { ensureSiteSchema } from './schema';

const NO_PRICE_GROUP_TITLE = 'Без ценовой группы';

export type PriceGroupImage = {
  title: string;
  imageUrl: string;
  productCount: number;
};

function normalizePriceGroupTitle(value: string) {
  return value.trim() || NO_PRICE_GROUP_TITLE;
}

export async function getPriceGroupsWithImages(): Promise<PriceGroupImage[]> {
  await ensureSiteSchema();
  const result = await query<{
    title: string;
    image_url: string | null;
    product_count: string;
  }>(
    `select
       coalesce(nullif(trim(p.price_group), ''), $1) as title,
       coalesce(pgi.image_url, '') as image_url,
       count(distinct p.id)::text as product_count
     from wholesale_products p
     left join price_group_images pgi on pgi.price_group = coalesce(nullif(trim(p.price_group), ''), $1)
     where p.is_active = true
     group by coalesce(nullif(trim(p.price_group), ''), $1), pgi.image_url
     order by lower(coalesce(nullif(trim(p.price_group), ''), $1)) asc`,
    [NO_PRICE_GROUP_TITLE],
  );

  return result.rows.map((row) => ({
    title: row.title,
    imageUrl: row.image_url ?? '',
    productCount: Number(row.product_count),
  }));
}

export async function updatePriceGroupImage(title: string, imageUrl: string) {
  await ensureSiteSchema();
  await query(
    `insert into price_group_images (price_group, image_url)
     values ($1, $2)
     on conflict (price_group) do update
     set image_url = excluded.image_url,
         updated_at = now()`,
    [normalizePriceGroupTitle(title), imageUrl.trim()],
  );
}
