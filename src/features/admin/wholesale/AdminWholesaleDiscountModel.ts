import type { CatalogProduct, PriceItem } from './AdminWholesaleTypes';
import type { CatalogGroup, CatalogRow } from './AdminWholesaleCatalogModel';

export function parseCatalogAmount(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, '').replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function formatCatalogAmount(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export function normalizeDiscountPercent(value: string) {
  if (!value.trim()) return null;
  const percent = Number(value.replace(',', '.'));
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
}

export function parseDiscountLimit(value: string | null | undefined) {
  if (!value?.trim()) return null;
  const percent = Number(value.replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
}

export function formatDiscountPercent(value: number) {
  const rounded = Math.round(value * 100) / 100;
  const formatted = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return formatted.replace('.', ',');
}

export function getProductDiscountLimit(product: CatalogProduct) {
  const generalDiscount = parseDiscountLimit(product.generalDiscount);
  const manualDiscountRop = parseDiscountLimit(product.manualDiscountRop);
  const manualDiscount = parseDiscountLimit(product.manualDiscount);

  if (manualDiscountRop !== null) return Math.min(100, (generalDiscount ?? 0) + manualDiscountRop);
  if (manualDiscount !== null) return Math.min(100, (generalDiscount ?? 0) + manualDiscount);
  return generalDiscount;
}

export function getGroupDiscountLimit(group: CatalogGroup) {
  let limit: number | null = null;
  for (const product of group.products) {
    const productLimit = getProductDiscountLimit(product);
    if (productLimit === null) continue;
    limit = limit === null ? productLimit : Math.min(limit, productLimit);
  }
  return limit;
}

export function getDiscountBaseAmount(row: CatalogRow) {
  return (
    parseCatalogAmount(row.product.priceRub) ??
    parseCatalogAmount(row.variant.retailPrice) ??
    parseCatalogAmount(row.variant.wholesalePrice) ??
    parseCatalogAmount(row.product.priceEur) ??
    parseCatalogAmount(row.product.priceCny)
  );
}

export function getSavedGroupDiscountPercent(
  group: CatalogGroup,
  itemByKey: Map<string, PriceItem>,
  catalogDiscountBaseByKey: Map<string, { amount: number | null; groupKey: string }>,
) {
  const discounts: number[] = [];

  for (const product of group.products) {
    for (const variant of product.variants) {
      const key = `${product.id}:${variant.id ?? 'base'}`;
      const priceItem = itemByKey.get(key);
      if (!priceItem?.visible) continue;

      const base = catalogDiscountBaseByKey.get(key)?.amount;
      const custom = parseCatalogAmount(priceItem.customWholesalePrice);
      if (!base || custom === null) continue;

      const discount = (1 - custom / base) * 100;
      if (discount < -0.05 || discount > 100) return null;
      discounts.push(discount <= 0.05 ? 0 : discount);
    }
  }

  if (discounts.length === 0) return null;
  const first = discounts[0];
  if (discounts.some((discount) => Math.abs(discount - first) > 0.15)) return null;

  return formatDiscountPercent(first);
}
