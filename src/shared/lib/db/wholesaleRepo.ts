import { query } from './client';
import { ensureSiteSchema } from './schema';

export type PublicWholesaleVariant = {
  priceItemId: number;
  id: number | null;
  title: string;
  retailPrice: string | null;
  wholesalePrice: string | null;
};

export type PublicWholesaleProduct = {
  id: number;
  title: string;
  sku: string;
  description: string;
  imageUrl: string | null;
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
  validUntil: string | null;
  updatedAt: string;
  showRetailPrices: boolean;
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
  valid_until: string | null;
  updated_at: string;
  show_retail_prices: boolean;
};

type PriceItemRow = {
  item_id: string;
  category_id: string | null;
  category_title: string | null;
  product_id: string;
  product_title: string;
  sku: string;
  series_description: string;
  image_url: string | null;
  variant_id: string | null;
  variant_title: string | null;
  retail_price: string | null;
  wholesale_price: string | null;
};

export type PublicWholesaleRequestItem = {
  id: number;
  productTitle: string;
  sku: string;
  variantTitle: string;
  wholesalePrice: string | null;
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
       pl.valid_until::text,
       pl.updated_at::text,
       pl.show_retail_prices
     from wholesale_price_lists pl
     left join wholesale_managers m on m.id = pl.manager_id
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
       img.image_url,
       v.id::text as variant_id,
       coalesce(i.snapshot_variant_title, v.title, '') as variant_title,
       coalesce(v.retail_price, p.retail_price)::text as retail_price,
       coalesce(i.custom_wholesale_price, v.wholesale_price, p.wholesale_price)::text as wholesale_price
     from wholesale_price_lists pl
     join wholesale_price_list_items i on i.price_list_id = pl.id
     join wholesale_products p on p.id = i.wholesale_product_id
     left join wholesale_categories c on c.id = p.category_id
     left join wholesale_product_variants v on v.id = i.wholesale_variant_id and v.product_id = p.id
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
        imageUrl: row.image_url,
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
    validUntil: priceListRow.valid_until,
    updatedAt: priceListRow.updated_at,
    showRetailPrices: priceListRow.show_retail_prices,
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
  }>(
    `select
       i.id::text,
       coalesce(i.snapshot_product_title, p.title) as product_title,
       coalesce(i.snapshot_product_sku, p.sku) as sku,
       coalesce(i.snapshot_variant_title, v.title, '') as variant_title,
       coalesce(i.custom_wholesale_price, v.wholesale_price, p.wholesale_price)::text as wholesale_price
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
  }));
}
