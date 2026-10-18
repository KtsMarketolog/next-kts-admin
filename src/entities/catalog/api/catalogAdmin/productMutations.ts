import { ensureSiteSchema } from '@/shared/lib/db';
import { withCatalogStockWrite } from '@/shared/lib/db/catalogStockWrite';
import { ensureCatalogSchema } from '../catalogDb';
import { slugify, uniqueSlug } from './helpers';
import { ensureCategory, ensureSubcategory, ensureBrand, linkCatalogEntities, createCache } from './entityWrites';
import { normalizeInput } from './productInput';
import { insertCatalogProduct } from './productRowWrites';
import { syncWholesaleProduct } from './wholesaleSync';
import { getCatalogAdminProductById } from './productQueries';
import type { CatalogProductInput } from './types';

export async function createCatalogAdminProduct(input: CatalogProductInput) {
  const normalized = normalizeInput(input);
  if (!normalized.article) throw new Error('Артикул товара обязателен');
  await ensureCatalogSchema();
  await ensureSiteSchema();

  const id = await withCatalogStockWrite(async (client) => {
    const count = await client.query<{ count: string }>('select count(*)::text as count from catalog_products');
    return insertCatalogProduct(client, createCache(), normalized, Number(count.rows[0]?.count ?? 0));
  });
  return getCatalogAdminProductById(id);
}

export async function updateCatalogAdminProduct(id: number, input: CatalogProductInput) {
  const normalizedId = Number(id);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) throw new Error('Некорректный товар');
  const normalized = normalizeInput(input);
  if (!normalized.article) throw new Error('Артикул товара обязателен');
  await ensureCatalogSchema();
  await ensureSiteSchema();

  await withCatalogStockWrite(async (client) => {
    const existing = await client.query<{ id: string; sort_order: string }>(
      `select id::text, coalesce((
         select sort_order::text from wholesale_products where catalog_product_id = $1 limit 1
       ), '0') as sort_order
       from catalog_products
       where id = $1
       limit 1`,
      [normalizedId],
    );
    if (!existing.rows[0]) throw new Error('Товар не найден');

    const cache = createCache();
    const categoryId = await ensureCategory(client, cache, normalized.category, 0);
    const subcategoryId = await ensureSubcategory(client, cache, normalized.subcategory, 0);
    const brandId = await ensureBrand(client, cache, normalized.brand);
    await linkCatalogEntities(client, categoryId, subcategoryId, brandId, 0);

    const slug = await uniqueSlug(client, 'catalog_products', slugify(normalized.title, `product-${normalizedId}`), normalizedId);
    await client.query(
      `update catalog_products
       set slug = $2,
           title = $3,
           article = $4,
           model = $5,
           price_group = $6,
           unit = coalesce($7, unit),
           price_eur = $8,
           price_rub = $9,
           price_cny = $10,
           price_usd = $11,
           general_discount = $12,
           manual_discount = $13,
           manual_discount_rop = $14,
           brand_id = $15,
           category_id = $16,
           subcategory_id = $17,
           stock = coalesce($18, stock),
           is_expected = coalesce($19, is_expected),
           stock_updated_at = case
             when $18::integer is not null and stock is distinct from $18 then now()
             when $19::boolean is not null and is_expected is distinct from $19 then now()
             else stock_updated_at
           end,
           is_active = $20,
           updated_at = now()
       where id = $1`,
      [
        normalizedId,
        slug,
        normalized.title,
        normalized.article,
        normalized.model,
        normalized.priceGroup,
        normalized.unit,
        normalized.priceEur,
        normalized.priceRub,
        normalized.priceCny,
        null,
        normalized.generalDiscount,
        normalized.manualDiscount,
        normalized.manualDiscountRop,
        brandId,
        categoryId,
        subcategoryId,
        normalized.stock,
        normalized.isExpected,
        normalized.isActive,
      ],
    );
    await syncWholesaleProduct(client, cache, normalizedId, normalized, Number(existing.rows[0].sort_order || 0));
  });

  return getCatalogAdminProductById(normalizedId);
}

export async function deleteCatalogAdminProduct(id: number) {
  await ensureCatalogSchema();
  await ensureSiteSchema();
  const normalizedId = Number(id);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) throw new Error('Некорректный товар');
  await withCatalogStockWrite(async (client) => {
    // Match imports/edits: catalog first, wholesale second. Keep wholesale
    // rows and price-list overrides; only the explicitly deleted catalog row
    // is removed, exactly as before.
    await client.query(`delete from catalog_products where id = $1`, [normalizedId]);
    await client.query(`update wholesale_products set is_active = false, updated_at = now() where catalog_product_id = $1`, [normalizedId]);
  });
}
