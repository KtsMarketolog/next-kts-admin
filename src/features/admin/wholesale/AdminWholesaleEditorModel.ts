import type { CatalogCategory, PriceEditor, PriceGroupStockSetting, PriceItem } from './AdminWholesaleTypes';
import { flatCatalogItems, priceGroupKey } from './AdminWholesaleCatalogModel';
import { formatCatalogAmount, getDiscountBaseAmount } from './AdminWholesaleDiscountModel';

export function makeToken() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function getDefaultPriceTitle() {
  return `Прайс от ${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow' }).format(new Date())}`;
}

export function emptyEditor(): PriceEditor {
  return {
    title: getDefaultPriceTitle(),
    clientCompanyId: null,
    clientName: '',
    token: makeToken(),
    validUntil: '',
    comment: '',
    workflowStatus: 'not_sent',
    showRetailPrices: false,
    showStock: true,
    showStockText: false,
    isActive: true,
    managerId: null,
    supportManagerId: null,
    items: [],
    priceGroupStockSettings: {},
  };
}

export function normalizePriceGroupStockSettings(settings: unknown): Record<string, PriceGroupStockSetting> {
  if (!Array.isArray(settings)) return {};
  return settings.reduce<Record<string, PriceGroupStockSetting>>((result, item) => {
    if (!item || typeof item !== 'object') return result;
    const source = item as Partial<PriceGroupStockSetting>;
    const priceGroup = typeof source.priceGroup === 'string' ? source.priceGroup.trim() : '';
    if (!priceGroup) return result;
    const showStock = source.showStock === true;
    const showStockText = source.showStockText === true;
    if (!showStock && !showStockText) return result;
    result[priceGroupKey(priceGroup)] = { priceGroup, showStock, showStockText };
    return result;
  }, {});
}

export function getTextareaRows(value: string) {
  const visualRows = value.split(/\r\n|\r|\n/).reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 120)), 0);
  return Math.max(2, visualRows + 1);
}

export function getInitialCustomWholesalePrice(row: ReturnType<typeof flatCatalogItems>[number], item?: PriceItem) {
  if (item?.customWholesalePrice?.trim()) return item.customWholesalePrice;
  const base = getDiscountBaseAmount(row);
  return base === null ? '' : formatCatalogAmount(base);
}

export function mergeEditorItems(categories: CatalogCategory[], items: PriceItem[]) {
  const current = new Map(items.map((item) => [`${item.productId}:${item.variantId ?? 'base'}`, item]));
  return flatCatalogItems(categories).map((row, index) => {
    const { product, variant } = row;
    const key = `${product.id}:${variant.id ?? 'base'}`;
    const currentItem = current.get(key);
    const customWholesalePrice = getInitialCustomWholesalePrice(row, currentItem);
    if (currentItem) return { ...currentItem, customWholesalePrice };

    return {
      productId: product.id,
      variantId: variant.id,
      customWholesalePrice,
      visible: false,
      sortOrder: index + 1,
    };
  });
}
