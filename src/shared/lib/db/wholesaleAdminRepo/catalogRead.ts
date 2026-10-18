import { query } from '../client';
import { ensureSiteSchema } from '../schema';
import type { WholesaleCatalogProduct, WholesaleCatalogCategory } from './types';

export async function getWholesaleCatalog() {
  await ensureSiteSchema();
  const result = await query<{
    category_id: string | null;
    category_title: string | null;
    product_id: string;
    product_title: string;
    sku: string;
    model: string | null;
    series_description: string;
    image_url: string | null;
    price_group: string | null;
    price_group_image_url: string | null;
    price_eur: string | null;
    price_rub: string | null;
    price_cny: string | null;
    general_discount: string | null;
    manual_discount: string | null;
    manual_discount_rop: string | null;
    stock: string | null;
    unit: string | null;
    is_expected: boolean | null;
    stock_updated_at: string | null;
    variant_id: string | null;
    variant_title: string | null;
    retail_price: string | null;
    wholesale_price: string | null;
  }>(`
    select
      c.id::text as category_id,
      coalesce(c.title, 'Без категории') as category_title,
      p.id::text as product_id,
      p.title as product_title,
      p.sku,
      p.model,
      p.series_description,
      img.image_url,
      p.price_group,
      pgi.image_url as price_group_image_url,
      p.price_eur::text,
      p.price_rub::text,
      p.price_cny::text,
      p.general_discount::text,
      p.manual_discount::text,
      p.manual_discount_rop::text,
      p.stock::text,
      p.unit,
      p.is_expected,
      p.stock_updated_at::text,
      v.id::text as variant_id,
      v.title as variant_title,
      coalesce(v.retail_price, p.retail_price)::text as retail_price,
      coalesce(v.wholesale_price, p.wholesale_price)::text as wholesale_price
    from wholesale_products p
    left join wholesale_categories c on c.id = p.category_id
    left join wholesale_product_variants v on v.product_id = p.id and v.is_active = true
    left join price_group_images pgi on pgi.price_group = coalesce(nullif(trim(p.price_group), ''), 'Без ценовой группы')
    left join lateral (
      select image_url
      from wholesale_product_images
      where product_id = p.id and is_active = true
      order by sort_order asc, id asc
      limit 1
    ) img on true
    where p.is_active = true
    order by c.sort_order asc nulls last, c.id asc nulls last, p.sort_order asc, p.id asc, v.sort_order asc nulls last, v.id asc nulls last
  `);

  const categories = new Map<number, WholesaleCatalogCategory>();
  const products = new Map<string, WholesaleCatalogProduct>();

  for (const row of result.rows) {
    const categoryId = Number(row.category_id ?? 0);
    const normalizedCategoryId = Number.isFinite(categoryId) && categoryId > 0 ? categoryId : 0;
    let category = categories.get(normalizedCategoryId);
    if (!category) {
      category = { id: normalizedCategoryId, title: row.category_title || 'Без категории', products: [] };
      categories.set(normalizedCategoryId, category);
    }

    const productId = Number(row.product_id);
    const productKey = `${normalizedCategoryId}:${productId}`;
    let product = products.get(productKey);
    if (!product) {
      product = {
        id: productId,
        title: row.product_title,
        sku: row.sku,
        model: row.model ?? '',
        description: row.series_description,
        imageUrl: row.image_url,
        priceGroup: row.price_group ?? '',
        priceGroupImageUrl: row.price_group_image_url,
        priceEur: row.price_eur,
        priceRub: row.price_rub,
        priceCny: row.price_cny,
        generalDiscount: row.general_discount,
        manualDiscount: row.manual_discount,
        manualDiscountRop: row.manual_discount_rop,
        stock: Number(row.stock ?? 0),
        unit: row.unit,
        isExpected: Boolean(row.is_expected),
        stockUpdatedAt: row.stock_updated_at,
        variants: [],
      };
      products.set(productKey, product);
      category.products.push(product);
    }

    product.variants.push({
      id: row.variant_id ? Number(row.variant_id) : null,
      title: row.variant_title || 'Цена',
      retailPrice: row.retail_price,
      wholesalePrice: row.wholesale_price,
    });
  }

  return Array.from(categories.values());
}
