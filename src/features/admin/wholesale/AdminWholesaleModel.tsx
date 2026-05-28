'use client';

import styles from '@/app/admin/admin.module.scss';
import { readWholesaleManagerPasswords as readManagerPasswords } from '@/shared/lib/adminPasswordStorage';
import type { WholesalePriceWorkflowStatus } from '@/shared/lib/wholesalePriceWorkflowStatus';

export type Manager = {
  id: number;
  name: string;
  login: string;
  email: string;
  phone: string;
  role: 'manager' | 'support_manager';
  supportManagerId: number | null;
  supportManagerName: string;
  isActive: boolean;
  priceListCount: number;
  password?: string;
  displayPassword: string;
};

export type ManagerRole = Manager['role'];

export type ClientCompanyOption = {
  id: number;
  title: string;
  isActive: boolean;
};

export type ManagerDraft = {
  name: string;
  login: string;
  email: string;
  phone: string;
  supportManagerId: number | null;
  password: string;
  isActive: boolean;
};

export const MANAGER_ROLE_TABS: Array<{ value: ManagerRole; label: string }> = [
  { value: 'manager', label: 'Менеджер по развитию' },
  { value: 'support_manager', label: 'Менеджер по сопровождению' },
];

const MANAGER_ROLE_TAB_STORAGE_KEY = 'kts-admin-wholesale-manager-role-tab';

export function isManagerRole(value: string | null): value is ManagerRole {
  return value === 'manager' || value === 'support_manager';
}

export function readManagerRoleTab(): ManagerRole {
  if (typeof window === 'undefined') return 'manager';
  const value = window.localStorage.getItem(MANAGER_ROLE_TAB_STORAGE_KEY);
  return isManagerRole(value) ? value : 'manager';
}

export function saveManagerRoleTab(tab: ManagerRole) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(MANAGER_ROLE_TAB_STORAGE_KEY, tab);
}

export type PriceList = {
  id: number;
  title: string;
  clientCompanyId: number | null;
  clientName: string;
  token: string;
  validUntil: string | null;
  workflowStatus: WholesalePriceWorkflowStatus;
  workflowStatusLabel: string;
  showRetailPrices: boolean;
  showStock: boolean;
  showStockText: boolean;
  isActive: boolean;
  managerId: number | null;
  managerName: string | null;
  itemCount: number;
  priceGroupCount: number;
  createdAt: string;
  updatedAt: string;
  lastChangedAt: string | null;
  lastChangedTitle: string | null;
  lastChangedByName: string | null;
};

export type CatalogVariant = {
  id: number | null;
  title: string;
  retailPrice: string | null;
  wholesalePrice: string | null;
};

export type CatalogProduct = {
  id: number;
  title: string;
  sku: string;
  description: string;
  imageUrl: string | null;
  priceGroup: string;
  priceGroupImageUrl: string | null;
  priceEur: string | null;
  priceRub: string | null;
  priceCny: string | null;
  generalDiscount: string | null;
  manualDiscount: string | null;
  manualDiscountRop: string | null;
  stock: number;
  unit: string | null;
  isExpected: boolean;
  stockUpdatedAt: string | null;
  variants: CatalogVariant[];
};

export type CatalogCategory = {
  id: number;
  title: string;
  products: CatalogProduct[];
};

export type PriceItem = {
  productId: number;
  variantId: number | null;
  customWholesalePrice: string | null;
  visible: boolean;
  sortOrder: number;
};

export type PriceGroupStockSetting = {
  priceGroup: string;
  showStock: boolean;
  showStockText: boolean;
};

export type PriceEditor = {
  id?: number;
  title: string;
  clientCompanyId: number | null;
  clientName: string;
  token: string;
  validUntil: string;
  comment: string;
  workflowStatus: WholesalePriceWorkflowStatus;
  showRetailPrices: boolean;
  showStock: boolean;
  showStockText: boolean;
  isActive: boolean;
  managerId: number | null;
  supportManagerId: number | null;
  items: PriceItem[];
  priceGroupStockSettings: Record<string, PriceGroupStockSetting>;
};

export type AdminWholesaleGatewayProps = {
  canManageWholesale?: boolean;
  onBack: () => void;
};

export type CurrentManager = {
  id: number;
  name: string;
  login: string;
  email: string;
  phone: string;
};

export const emptyManager: ManagerDraft = {
  name: '',
  login: '',
  email: '',
  phone: '',
  supportManagerId: null,
  password: '',
  isActive: true,
};

export function attachManagerPasswords(managers: Manager[]) {
  const passwords = readManagerPasswords();
  return managers.map((manager) => ({
    ...manager,
    displayPassword: manager.displayPassword || passwords[String(manager.id)] || '',
  }));
}

export const NO_PRICE_GROUP_TITLE = 'Без ценовой группы';

export function makeToken() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function getDefaultPriceTitle() {
  return `Прайс от ${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow' }).format(new Date())}`;
}

export function stockLabel(product: CatalogProduct) {
  const unit = product.unit?.trim() || 'шт.';
  if (product.stock > 0) return `${product.stock} ${unit}`;
  return product.isExpected ? 'Ожидается поступление' : 'Под заказ';
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

export function priceGroupKey(title: string) {
  return (title || NO_PRICE_GROUP_TITLE).toLowerCase();
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

export function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ru-RU');
}

export async function readApiError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
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

export function getTextareaRows(value: string) {
  const visualRows = value.split(/\r\n|\r|\n/).reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 120)), 0);
  return Math.max(2, visualRows + 1);
}

export function getInitialCustomWholesalePrice(row: CatalogRow, item?: PriceItem) {
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

export function renderWholesaleEditorSkeleton() {
  return (
    <div className={styles.editorSkeleton} aria-busy="true">
      <div className={styles.skeletonEditorGrid}>
        {Array.from({ length: 6 }, (_, index) => (
          <div className={styles.skeletonField} key={index}>
            <span className={styles.skeletonLabelLine} />
            <span className={styles.skeletonInputLine} />
          </div>
        ))}
        <div className={`${styles.skeletonField} ${styles.wholesaleWide}`}>
          <span className={styles.skeletonLabelLine} />
          <span className={styles.skeletonTextareaLine} />
        </div>
      </div>

      <div className={styles.skeletonOptions}>
        <span />
        <span />
        <span />
      </div>

      <div className={styles.skeletonSearchBlock}>
        <span />
        <span />
        <span />
      </div>

      {Array.from({ length: 2 }, (_, groupIndex) => (
        <div className={styles.skeletonPriceGroup} key={groupIndex}>
          <div className={styles.skeletonGroupHeader}>
            <span className={styles.skeletonImage} />
            <span className={styles.skeletonTitleLine} />
            <span className={styles.skeletonWideLine} />
          </div>
          {Array.from({ length: 3 }, (_, productIndex) => (
            <div className={styles.skeletonProductCard} key={productIndex}>
              <div>
                <span className={styles.skeletonTitleLine} />
                <span className={styles.skeletonShortLine} />
                <span className={styles.skeletonShortLine} />
              </div>
              <div className={styles.skeletonVariantGrid}>
                <span />
                <span />
                <span />
                <span />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

