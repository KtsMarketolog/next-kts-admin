import { query } from '@/shared/lib/db/client';
import { ensureCatalogSchema } from '../catalogDb';
import type { CatalogAdminStats } from './types';

export async function getCatalogAdminStats(): Promise<CatalogAdminStats> {
  await ensureCatalogSchema();
  const result = await query<{
    products: string;
    active_products: string;
    categories: string;
    subcategories: string;
    brands: string;
  }>(`
    select
      (select count(*)::text from catalog_products) as products,
      (select count(*)::text from catalog_products where is_active = true) as active_products,
      (select count(*)::text from catalog_categories where is_active = true) as categories,
      (select count(*)::text from catalog_subcategories where is_active = true) as subcategories,
      (select count(*)::text from catalog_brands where is_active = true) as brands
  `);
  const row = result.rows[0];
  return {
    products: Number(row?.products ?? 0),
    activeProducts: Number(row?.active_products ?? 0),
    categories: Number(row?.categories ?? 0),
    subcategories: Number(row?.subcategories ?? 0),
    brands: Number(row?.brands ?? 0),
  };
}
