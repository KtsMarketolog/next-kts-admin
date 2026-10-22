import {
  createAnalogCatalogIndex, findCatalogSearchProducts,
  type AnalogCatalogIdentity, type AnalogCatalogIndex,
} from '@/shared/lib/analogCatalogMatching';
import { query } from './client';

export type AnalogCatalogProduct = AnalogCatalogIdentity & {
  stock: number; stockVolzhsk: number; stockMoscow: number; unit: string; isExpected: boolean;
};

type ProductRow = {
  id: string; title: string; sku: string; model: string | null; brand_title: string;
  stock: string | null; stock_volzhsk: string | null; stock_moscow: string | null;
  unit: string | null; is_expected: boolean | null;
};

/** One consistent read for input resolution and all stocks. Zero stock stays in
 * the assortment; no prices, SQL regex cross joins or per-result queries. */
export async function getActiveAnalogCatalog(): Promise<AnalogCatalogIndex<AnalogCatalogProduct>> {
  const result = await query<ProductRow>(
    `select id::text, title, sku, model, brand_title,
            stock::text, stock_volzhsk::text, stock_moscow::text, unit, is_expected
     from wholesale_products
     where is_active = true
     order by id asc`,
  );
  return createAnalogCatalogIndex(result.rows.map((row) => ({
    id: Number(row.id), title: row.title, sku: row.sku, model: row.model ?? '', brand: row.brand_title,
    stock: Number(row.stock ?? 0), stockVolzhsk: Number(row.stock_volzhsk ?? 0), stockMoscow: Number(row.stock_moscow ?? 0),
    unit: row.unit?.trim() || 'шт.', isExpected: row.is_expected === true,
  })));
}

export function findAnalogCatalogProducts(searchTerm: string, catalog: AnalogCatalogIndex<AnalogCatalogProduct>) {
  return findCatalogSearchProducts(searchTerm, catalog);
}
