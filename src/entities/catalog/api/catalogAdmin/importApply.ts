import { ensureSiteSchema } from '@/shared/lib/db';
import { withCatalogStockWrite } from '@/shared/lib/db/catalogStockWrite';
import { ensureCatalogSchema } from '../catalogDb';
import { assertUniqueCatalogArticles } from '../catalogImportValidation';
import { createCache } from './entityWrites';
import { normalizeInput } from './productInput';
import { assertUnambiguousCatalogImportMatches, catalogProductImportKey, getExistingCatalogProducts } from './importMatching';
import { insertCatalogProduct, updateCatalogProductFromImport } from './productRowWrites';
import { getCatalogAdminStats } from './stats';
import type { CatalogProductInput, CatalogImportResult } from './types';

export async function replaceCatalogFromRows(rows: CatalogProductInput[]): Promise<CatalogImportResult> {
  // Preserve Excel row metadata and reject the entire file before any schema or data work.
  assertUniqueCatalogArticles(rows);
  const normalizedRows = rows.map(normalizeInput).filter((row) => row.article);
  if (normalizedRows.length === 0) throw new Error('В файле нет товаров с заполненным артикулом');
  await ensureCatalogSchema();
  await ensureSiteSchema();

  await withCatalogStockWrite(async (client) => {
    const cache = createCache();
    const existingProducts = await getExistingCatalogProducts(client);
    assertUnambiguousCatalogImportMatches(normalizedRows, existingProducts);
    const touchedProductIds = new Set<number>();

    for (const [index, row] of normalizedRows.entries()) {
      const key = catalogProductImportKey(row);
      const existingBucket = existingProducts.get(key);
      const existingProduct = existingBucket?.shift();

      if (existingProduct) {
        await updateCatalogProductFromImport(client, cache, existingProduct.id, row, index);
        touchedProductIds.add(existingProduct.id);
      } else {
        const insertedId = await insertCatalogProduct(client, cache, row, index);
        touchedProductIds.add(insertedId);
      }
    }

    const activeIds = Array.from(touchedProductIds);
    await client.query(
      `update catalog_products
       set is_active = false,
           updated_at = now()
       where not (id = any($1::bigint[]))
         and is_active = true`,
      [activeIds],
    );
    await client.query(
      `update wholesale_products
       set is_active = false,
           updated_at = now()
       where catalog_product_id is not null
         and not (catalog_product_id = any($1::bigint[]))
         and is_active = true`,
      [activeIds],
    );
    // Editors lock the parent before its positions. Use the same order here
    // before the child-change revision trigger touches affected price lists.
    await client.query(
      `select price.id
       from wholesale_price_lists price
       where exists (
         select 1 from wholesale_price_list_items items
         join wholesale_products products on products.id = items.wholesale_product_id
         where items.price_list_id = price.id
           and products.catalog_product_id is not null
           and not (products.catalog_product_id = any($1::bigint[]))
           and items.visible = true
       )
       order by price.id for update of price`,
      [activeIds],
    );
    await client.query(
      `update wholesale_price_list_items items
       set visible = false,
           updated_at = now()
       from wholesale_products products
       where products.id = items.wholesale_product_id
         and products.catalog_product_id is not null
         and not (products.catalog_product_id = any($1::bigint[]))
         and items.visible = true`,
      [activeIds],
    );
    await client.query(`
      update catalog_categories categories
      set is_active = exists (
            select 1 from catalog_products products
            where products.category_id = categories.id and products.is_active = true
          ),
          updated_at = now()
    `);
    await client.query(`
      update catalog_subcategories subcategories
      set is_active = exists (
            select 1 from catalog_products products
            where products.subcategory_id = subcategories.id and products.is_active = true
          ),
          updated_at = now()
    `);
    await client.query(`
      update catalog_brands brands
      set is_active = exists (
            select 1 from catalog_products products
            where products.brand_id = brands.id and products.is_active = true
          ),
          updated_at = now()
    `);
    await client.query(`
      update wholesale_categories categories
      set is_active = exists (
            select 1 from wholesale_products products
            where products.category_id = categories.id and products.is_active = true
          ),
          updated_at = now()
    `);
  }, 'import');

  const stats = await getCatalogAdminStats();
  return {
    ...stats,
    importedProducts: normalizedRows.length,
    syncedWholesaleProducts: normalizedRows.length,
  };
}
