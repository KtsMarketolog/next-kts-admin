import { normalizeAnalogTerm } from '@/shared/lib/analogs';

import { query } from './client';

export type AnalogStockMatch = {
  modelKey: string;
  productId: number;
  title: string;
  sku: string;
  model: string;
  stock: number;
  stockVolzhsk: number;
  stockMoscow: number;
  unit: string;
  isExpected: boolean;
};

type StockRow = {
  id: string;
  title: string;
  sku: string;
  model: string | null;
  stock: string | null;
  stock_volzhsk: string | null;
  stock_moscow: string | null;
  unit: string | null;
  is_expected: boolean | null;
};

export async function getAnalogStockMatches(models: string[]): Promise<AnalogStockMatch[]> {
  const modelKeys = Array.from(new Set(models.map(normalizeAnalogTerm).filter((value) => value.length >= 2))).slice(0, 80);
  if (modelKeys.length === 0) return [];

  const result = await query<StockRow>(
    `select
       id::text,
       title,
       sku,
       model,
       stock::text,
       stock_volzhsk::text,
       stock_moscow::text,
       unit,
       is_expected
     from wholesale_products
     where is_active = true
       and (
         regexp_replace(replace(lower(coalesce(model, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') = any($1::text[])
         or regexp_replace(replace(lower(coalesce(sku, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') = any($1::text[])
         or regexp_replace(replace(lower(coalesce(title, '')), 'ё', 'е'), '[^a-zа-я0-9]+', '', 'g') = any($1::text[])
       )
     order by stock desc, id asc`,
    [modelKeys],
  );

  return result.rows.flatMap((row) => {
    const keys = [row.model, row.sku, row.title].map((value) => normalizeAnalogTerm(value ?? ''));
    const modelKey = keys.find((key) => modelKeys.includes(key));
    if (!modelKey) return [];
    return [
      {
        modelKey,
        productId: Number(row.id),
        title: row.title,
        sku: row.sku,
        model: row.model ?? '',
        stock: Number(row.stock ?? 0),
        stockVolzhsk: Number(row.stock_volzhsk ?? 0),
        stockMoscow: Number(row.stock_moscow ?? 0),
        unit: row.unit?.trim() || 'шт.',
        isExpected: row.is_expected === true,
      },
    ];
  });
}
