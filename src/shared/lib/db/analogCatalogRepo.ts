import { normalizeAnalogTerm, type AnalogCatalogProductInput } from '@/shared/lib/analogs';

import { query } from './client';

export type AnalogCatalogProduct = AnalogCatalogProductInput & {
  id: number;
};

type ProductRow = {
  id: string;
  title: string;
  sku: string;
  model: string;
};

export async function findAnalogCatalogProducts(searchTerm: string): Promise<AnalogCatalogProduct[]> {
  const normalizedTerm = normalizeAnalogTerm(searchTerm);
  if (normalizedTerm.length < 2) return [];

  const result = await query<ProductRow>(
    `select id::text, title, sku, model
     from wholesale_products
     where is_active = true
       and (
         regexp_replace(replace(lower(coalesce(sku, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') = $1
         or regexp_replace(replace(lower(coalesce(model, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') = $1
         or regexp_replace(replace(lower(coalesce(title, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') = $1
         or (
           length($1) >= 4
           and regexp_replace(replace(lower(coalesce(title, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') like '%' || $1 || '%'
         )
       )
     order by
       case
         when regexp_replace(replace(lower(coalesce(sku, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') = $1 then 0
         when regexp_replace(replace(lower(coalesce(model, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') = $1 then 1
         when regexp_replace(replace(lower(coalesce(title, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') = $1 then 2
         else 3
       end,
       id asc
     limit 20`,
    [normalizedTerm],
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    title: row.title,
    sku: row.sku,
    model: row.model,
  }));
}
