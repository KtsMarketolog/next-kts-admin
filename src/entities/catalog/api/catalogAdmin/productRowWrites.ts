import type { PoolClient } from 'pg';
import { slugify, uniqueSlug } from './helpers';
import { ensureCategory, ensureSubcategory, ensureBrand, linkCatalogEntities, type EntityCache } from './entityWrites';
import type { NormalizedCatalogProductInput } from './productInput';
import { syncWholesaleProduct } from './wholesaleSync';

export async function insertCatalogProduct(client: PoolClient, cache: EntityCache, input: NormalizedCatalogProductInput, sortOrder: number) {
  const categoryId = await ensureCategory(client, cache, input.category, sortOrder);
  const subcategoryId = await ensureSubcategory(client, cache, input.subcategory, sortOrder);
  const brandId = await ensureBrand(client, cache, input.brand);
  await linkCatalogEntities(client, categoryId, subcategoryId, brandId, sortOrder);

  const slug = await uniqueSlug(client, 'catalog_products', slugify(input.title, `product-${sortOrder + 1}`));
  const inserted = await client.query<{ id: string }>(
    `insert into catalog_products (
       document_id,
       slug,
       title,
       article,
       model,
       price_group,
       unit,
       price_eur,
       price_rub,
       price_cny,
       price_usd,
       general_discount,
       manual_discount,
       manual_discount_rop,
       stock,
       is_expected,
       stock_updated_at,
       promo,
       brand_id,
       category_id,
       subcategory_id,
       is_active
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, case when $17 = true then now() else null end, false, $18, $19, $20, $21)
     returning id::text`,
    [
      `excel:${sortOrder + 1}`,
      slug,
      input.title,
      input.article,
      input.model,
      input.priceGroup,
      input.unit,
      input.priceEur,
      input.priceRub,
      input.priceCny,
      null,
      input.generalDiscount,
      input.manualDiscount,
      input.manualDiscountRop,
      input.stock ?? 0,
      input.isExpected ?? false,
      input.stock !== null || input.isExpected !== null,
      brandId,
      categoryId,
      subcategoryId,
      input.isActive,
    ],
  );
  const id = Number(inserted.rows[0]?.id);
  await syncWholesaleProduct(client, cache, id, input, sortOrder);
  return id;
}

export async function updateCatalogProductFromImport(
  client: PoolClient,
  cache: EntityCache,
  id: number,
  input: NormalizedCatalogProductInput,
  sortOrder: number,
) {
  const categoryId = await ensureCategory(client, cache, input.category, sortOrder);
  const subcategoryId = await ensureSubcategory(client, cache, input.subcategory, sortOrder);
  const brandId = await ensureBrand(client, cache, input.brand);
  await linkCatalogEntities(client, categoryId, subcategoryId, brandId, sortOrder);

  const slug = await uniqueSlug(client, 'catalog_products', slugify(input.title, `product-${id}`), id);
  await client.query(
    `update catalog_products
     set document_id = $2,
         slug = $3,
         title = $4,
         article = $5,
         model = $6,
         price_group = $7,
         unit = coalesce($8, unit),
         price_eur = $9,
         price_rub = $10,
         price_cny = $11,
         price_usd = $12,
         general_discount = $13,
         manual_discount = $14,
         manual_discount_rop = $15,
         brand_id = $16,
         category_id = $17,
         subcategory_id = $18,
         stock = coalesce($19, stock),
         is_expected = coalesce($20, is_expected),
         stock_updated_at = case
           when $19::integer is not null and stock is distinct from $19 then now()
           when $20::boolean is not null and is_expected is distinct from $20 then now()
           else stock_updated_at
         end,
         is_active = $21,
         updated_at = now()
     where id = $1`,
    [
      id,
      `excel:${sortOrder + 1}`,
      slug,
      input.title,
      input.article,
      input.model,
      input.priceGroup,
      input.unit,
      input.priceEur,
      input.priceRub,
      input.priceCny,
      null,
      input.generalDiscount,
      input.manualDiscount,
      input.manualDiscountRop,
      brandId,
      categoryId,
      subcategoryId,
      input.stock,
      input.isExpected,
      input.isActive,
    ],
  );
  await syncWholesaleProduct(client, cache, id, input, sortOrder);
}
