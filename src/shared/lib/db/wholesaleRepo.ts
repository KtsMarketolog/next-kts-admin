import { query } from './client';
import { ensureSiteSchema } from './schema';
import { resolveWholesaleStockDisplayMode, type WholesaleStockDisplayMode } from '../wholesaleStockDisplay';

export type PublicWholesaleVariant = {
  priceItemId: number;
  id: number | null;
  title: string;
  retailPrice: string | null;
  wholesalePrice: string | null;
  priceEur: string | null;
  priceRub: string | null;
  priceCny: string | null;
  priceUsd: string | null;
};

export type PublicWholesaleProduct = {
  id: number;
  title: string;
  sku: string;
  description: string;
  priceGroup: string;
  priceGroupImageUrl: string | null;
  imageUrl: string | null;
  stock: number;
  unit: string | null;
  isExpected: boolean;
  stockDisplayMode: WholesaleStockDisplayMode;
  stockUpdatedAt: string | null;
  variants: PublicWholesaleVariant[];
};

export type PublicWholesaleCategory = {
  id: number;
  title: string;
  products: PublicWholesaleProduct[];
};

export type PublicWholesalePriceList = {
  id: number;
  title: string;
  token: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
  managerEmail: string;
  managerPhone: string;
  supportManagerId: number | null;
  supportManagerName: string;
  supportManagerEmail: string;
  supportManagerPhone: string;
  validUntil: string | null;
  updatedAt: string;
  showRetailPrices: boolean;
  showStock: boolean;
  showStockText: boolean;
  categories: PublicWholesaleCategory[];
};

type PriceListRow = {
  id: string;
  title: string;
  token: string;
  client_name: string;
  manager_id: string | null;
  manager_name: string | null;
  manager_email: string | null;
  manager_phone: string | null;
  support_manager_id: string | null;
  support_manager_name: string | null;
  support_manager_email: string | null;
  support_manager_phone: string | null;
  valid_until: string | null;
  updated_at: string;
  show_retail_prices: boolean;
  show_stock: boolean;
  show_stock_text: boolean;
};

type PriceItemRow = {
  item_id: string;
  category_id: string | null;
  category_title: string | null;
  product_id: string;
  product_title: string;
  sku: string;
  series_description: string;
  price_group: string | null;
  price_group_image_url: string | null;
  image_url: string | null;
  stock: string | null;
  unit: string | null;
  is_expected: boolean | null;
  group_show_stock_numbers: boolean | null;
  group_show_stock_text: boolean | null;
  stock_updated_at: string | null;
  variant_id: string | null;
  variant_title: string | null;
  retail_price: string | null;
  wholesale_price: string | null;
  price_eur: string | null;
  price_rub: string | null;
  price_cny: string | null;
  price_usd: string | null;
};

export type PublicWholesaleRequestItem = {
  id: number;
  productTitle: string;
  sku: string;
  variantTitle: string;
  wholesalePrice: string | null;
  priceEur: string | null;
  priceRub: string | null;
  priceCny: string | null;
  priceUsd: string | null;
};

export async function getPublicWholesalePriceList(token: string): Promise<PublicWholesalePriceList | null> {
  await ensureSiteSchema();
  const normalizedToken = token.trim();
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(normalizedToken)) return null;

  const priceList = await query<PriceListRow>(
    `select
       pl.id::text,
       pl.title,
       pl.token,
       pl.client_name,
       pl.manager_id::text,
       m.name as manager_name,
       m.email as manager_email,
       m.phone as manager_phone,
       support.id::text as support_manager_id,
       support.name as support_manager_name,
       support.email as support_manager_email,
       support.phone as support_manager_phone,
       pl.valid_until::text,
       pl.updated_at::text,
       pl.show_retail_prices,
       pl.show_stock,
       pl.show_stock_text
     from wholesale_price_lists pl
     left join wholesale_managers m on m.id = pl.manager_id
     left join wholesale_managers support on support.id = m.support_manager_id and support.role = 'support_manager' and support.is_active = true
     where pl.token = $1 and pl.is_active = true
     limit 1`,
    [normalizedToken],
  );

  const priceListRow = priceList.rows[0];
  if (!priceListRow) return null;

  const items = await query<PriceItemRow>(
    `select
       i.id::text as item_id,
       c.id::text as category_id,
       coalesce(i.snapshot_category_title, c.title, 'Без категории') as category_title,
       p.id::text as product_id,
       coalesce(i.snapshot_product_title, p.title) as product_title,
       coalesce(i.snapshot_product_sku, p.sku) as sku,
       coalesce(i.snapshot_product_description, p.series_description) as series_description,
       p.price_group,
       pgi.image_url as price_group_image_url,
       img.image_url,
       p.stock::text,
       p.unit,
       p.is_expected,
       gs.show_stock_numbers as group_show_stock_numbers,
       gs.show_stock_text as group_show_stock_text,
       p.stock_updated_at::text,
       v.id::text as variant_id,
       coalesce(i.snapshot_variant_title, v.title, '') as variant_title,
       coalesce(v.retail_price, p.retail_price)::text as retail_price,
       coalesce(i.custom_wholesale_price, v.wholesale_price, p.wholesale_price)::text as wholesale_price,
       p.price_eur::text as price_eur,
       p.price_rub::text as price_rub,
       p.price_cny::text as price_cny,
       p.price_usd::text as price_usd
     from wholesale_price_lists pl
     join wholesale_price_list_items i on i.price_list_id = pl.id
     join wholesale_products p on p.id = i.wholesale_product_id
     left join wholesale_categories c on c.id = p.category_id
     left join wholesale_product_variants v on v.id = i.wholesale_variant_id and v.product_id = p.id
     left join price_group_images pgi on pgi.price_group = coalesce(nullif(trim(p.price_group), ''), 'Без ценовой группы')
     left join wholesale_price_list_group_stock_settings gs
       on gs.price_list_id = pl.id
      and gs.price_group = coalesce(nullif(trim(p.price_group), ''), 'Без ценовой группы')
     left join lateral (
       select image_url
       from wholesale_product_images
       where product_id = p.id and is_active = true
       order by sort_order asc, id asc
       limit 1
     ) img on true
     where pl.token = $1
       and pl.is_active = true
       and i.visible = true
       and p.is_active = true
       and (v.id is null or v.is_active = true)
     order by c.sort_order asc nulls last, c.id asc nulls last, p.sort_order asc, p.id asc, i.sort_order asc, v.sort_order asc nulls last`,
    [normalizedToken],
  );

  const categoriesById = new Map<number, PublicWholesaleCategory>();
  const productKeyByCategory = new Map<string, PublicWholesaleProduct>();

  for (const row of items.rows) {
    const categoryId = Number(row.category_id ?? 0);
    const categoryKey = Number.isFinite(categoryId) && categoryId > 0 ? categoryId : 0;
    let category = categoriesById.get(categoryKey);
    if (!category) {
      category = {
        id: categoryKey,
        title: row.category_title || 'Без категории',
        products: [],
      };
      categoriesById.set(categoryKey, category);
    }

    const productId = Number(row.product_id);
    const productKey = `${categoryKey}:${productId}`;
    let product = productKeyByCategory.get(productKey);
    if (!product) {
      product = {
        id: productId,
        title: row.product_title,
        sku: row.sku,
        description: row.series_description,
        priceGroup: row.price_group ?? '',
        priceGroupImageUrl: row.price_group_image_url,
        imageUrl: row.image_url,
        stock: Number(row.stock ?? 0),
        unit: row.unit,
        isExpected: Boolean(row.is_expected),
        stockDisplayMode: resolveWholesaleStockDisplayMode({
          globalShowNumbers: priceListRow.show_stock !== false,
          globalShowText: priceListRow.show_stock_text === true,
          groupShowNumbers: row.group_show_stock_numbers,
          groupShowText: row.group_show_stock_text,
        }),
        stockUpdatedAt: row.stock_updated_at,
        variants: [],
      };
      category.products.push(product);
      productKeyByCategory.set(productKey, product);
    }

    product.variants.push({
      priceItemId: Number(row.item_id),
      id: row.variant_id ? Number(row.variant_id) : null,
      title: row.variant_title || 'Цена',
      retailPrice: row.retail_price,
      wholesalePrice: row.wholesale_price,
      priceEur: row.price_eur,
      priceRub: row.price_rub,
      priceCny: row.price_cny,
      priceUsd: row.price_usd,
    });
  }

  return {
    id: Number(priceListRow.id),
    title: priceListRow.title,
    token: priceListRow.token,
    clientName: priceListRow.client_name,
    managerId: priceListRow.manager_id ? Number(priceListRow.manager_id) : null,
    managerName: priceListRow.manager_name ?? '',
    managerEmail: priceListRow.manager_email ?? '',
    managerPhone: priceListRow.manager_phone ?? '',
    supportManagerId: priceListRow.support_manager_id ? Number(priceListRow.support_manager_id) : null,
    supportManagerName: priceListRow.support_manager_name ?? '',
    supportManagerEmail: priceListRow.support_manager_email ?? '',
    supportManagerPhone: priceListRow.support_manager_phone ?? '',
    validUntil: priceListRow.valid_until,
    updatedAt: priceListRow.updated_at,
    showRetailPrices: priceListRow.show_retail_prices,
    showStock: priceListRow.show_stock !== false,
    showStockText: priceListRow.show_stock_text === true,
    categories: Array.from(categoriesById.values()),
  };
}

export async function getPublicWholesaleRequestItems(token: string, itemIds: number[]) {
  await ensureSiteSchema();
  const normalizedToken = token.trim();
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(normalizedToken)) return [];
  if (itemIds.length === 0) return [];

  const result = await query<{
    id: string;
    product_title: string;
    sku: string;
    variant_title: string | null;
    wholesale_price: string | null;
    price_eur: string | null;
    price_rub: string | null;
    price_cny: string | null;
    price_usd: string | null;
  }>(
    `select
       i.id::text,
       coalesce(i.snapshot_product_title, p.title) as product_title,
       coalesce(i.snapshot_product_sku, p.sku) as sku,
       coalesce(i.snapshot_variant_title, v.title, '') as variant_title,
       coalesce(i.custom_wholesale_price, v.wholesale_price, p.wholesale_price)::text as wholesale_price,
       p.price_eur::text as price_eur,
       p.price_rub::text as price_rub,
       p.price_cny::text as price_cny,
       p.price_usd::text as price_usd
     from wholesale_price_lists pl
     join wholesale_price_list_items i on i.price_list_id = pl.id
     join wholesale_products p on p.id = i.wholesale_product_id
     left join wholesale_product_variants v on v.id = i.wholesale_variant_id and v.product_id = p.id
     where pl.token = $1
       and pl.is_active = true
       and i.visible = true
       and p.is_active = true
       and (v.id is null or v.is_active = true)
       and i.id = any($2::bigint[])
     order by i.sort_order asc, i.id asc`,
    [normalizedToken, itemIds],
  );

  return result.rows.map((row): PublicWholesaleRequestItem => ({
    id: Number(row.id),
    productTitle: row.product_title,
    sku: row.sku,
    variantTitle: row.variant_title || 'Цена',
    wholesalePrice: row.wholesale_price,
    priceEur: row.price_eur,
    priceRub: row.price_rub,
    priceCny: row.price_cny,
    priceUsd: row.price_usd,
  }));
}
