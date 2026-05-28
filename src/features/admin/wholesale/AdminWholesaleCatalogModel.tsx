import type { CatalogCategory, CatalogProduct, PriceList } from './AdminWholesaleTypes';

export const NO_PRICE_GROUP_TITLE = 'Без ценовой группы';

export function stockLabel(product: CatalogProduct) {
  const unit = product.unit?.trim() || 'шт.';
  if (product.stock > 0) return `${product.stock} ${unit}`;
  return product.isExpected ? 'Ожидается поступление' : 'Под заказ';
}

export function priceGroupKey(title: string) {
  return (title || NO_PRICE_GROUP_TITLE).toLowerCase();
}

export function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ru-RU');
}

export function renderLastPriceChange(item: PriceList) {
  if (!item.lastChangedAt) return '—';

  return (
    <>
      {formatDate(item.lastChangedAt)}
      {item.lastChangedByName ? (
        <>
          <br />
          <span>{item.lastChangedByName}</span>
        </>
      ) : null}
    </>
  );
}

export function flatCatalogItems(categories: CatalogCategory[]) {
  return categories.flatMap((category) =>
    category.products.flatMap((product) =>
      product.variants.map((variant) => ({
        category,
        product,
        variant,
        key: `${product.id}:${variant.id ?? 'base'}`,
      })),
    ),
  );
}

export type CatalogRow = ReturnType<typeof flatCatalogItems>[number];

export type CatalogGroup = {
  id: string;
  title: string;
  imageUrl: string | null;
  products: CatalogProduct[];
};

export function groupCatalogRowsByPriceGroup(rows: CatalogRow[]) {
  const groups = new Map<string, CatalogGroup>();
  const products = new Map<string, CatalogProduct>();

  for (const row of rows) {
    const groupTitle = row.product.priceGroup || NO_PRICE_GROUP_TITLE;
    const groupKey = groupTitle.toLowerCase();
    let group = groups.get(groupKey);
    if (!group) {
      group = { id: groupKey, title: groupTitle, imageUrl: row.product.priceGroupImageUrl || row.product.imageUrl, products: [] };
      groups.set(groupKey, group);
    }

    if (!group.imageUrl && (row.product.priceGroupImageUrl || row.product.imageUrl)) {
      group.imageUrl = row.product.priceGroupImageUrl || row.product.imageUrl;
    }

    const productKey = `${groupKey}:${row.product.id}`;
    let product = products.get(productKey);
    if (!product) {
      product = { ...row.product, variants: [] };
      products.set(productKey, product);
      group.products.push(product);
    }

    product.variants.push(row.variant);
  }

  return Array.from(groups.values());
}
