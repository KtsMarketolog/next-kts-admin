import type { CatalogCategory } from './AdminWholesaleTypes';
import type { PriceListPayload } from './AdminWholesaleGateway.helpers';
import { WHOLESALE_PRICE_WORKFLOW_STATUSES } from '@/shared/lib/wholesalePriceWorkflowStatus';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function id(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

const nullableText = (value: unknown) => value === null || typeof value === 'string';
const nullableId = (value: unknown) => value === null || id(value);

/** Never turn a failed/partial response into a successfully loaded empty catalogue. */
export function parseWholesaleEditorCatalog(payload: unknown): CatalogCategory[] {
  const invalid = () => new Error('Каталог получен не полностью или в неверном формате. Повторите загрузку.');
  if (!record(payload) || !Array.isArray(payload.categories)) throw invalid();
  const categoryIds = new Set<number>();
  const productIds = new Set<number>();
  for (const category of payload.categories) {
    if (!record(category) || typeof category.id !== 'number' || !Number.isSafeInteger(category.id) || category.id < 0
      || categoryIds.has(category.id) || typeof category.title !== 'string' || !Array.isArray(category.products)) throw invalid();
    categoryIds.add(category.id);
    for (const product of category.products) {
      if (!record(product) || !id(product.id) || productIds.has(product.id)
        || !['title', 'sku', 'model', 'description', 'priceGroup'].every((key) => typeof product[key] === 'string')
        || !['priceEur', 'priceRub', 'priceCny', 'generalDiscount', 'manualDiscount', 'manualDiscountRop'].every((key) => nullableText(product[key]))
        || !Array.isArray(product.variants) || !product.variants.length) throw invalid();
      productIds.add(product.id);
      const variantIds = new Set<number | null>();
      for (const variant of product.variants) {
        if (!record(variant) || !nullableId(variant.id) || variantIds.has(variant.id as number | null)
          || typeof variant.title !== 'string' || !nullableText(variant.wholesalePrice) || !nullableText(variant.retailPrice)) throw invalid();
        variantIds.add(variant.id as number | null);
      }
    }
  }
  return payload.categories as CatalogCategory[];
}

/** Detail responses must include the stored positions/settings, even when both are empty. */
export function parseWholesaleEditorPrice(payload: unknown, expectedId: number): PriceListPayload {
  const invalid = () => new Error('Данные прайса получены не полностью. Повторите загрузку.');
  if (!record(payload) || !record(payload.priceList)) throw invalid();
  const price = payload.priceList;
  if (price.id !== expectedId || !id(price.id)
    || !WHOLESALE_PRICE_WORKFLOW_STATUSES.some((status) => status.value === price.workflowStatus)
    || !['title', 'clientName', 'token', 'comment'].every((key) => typeof price[key] === 'string')
    || !nullableText(price.validUntil)
    || !['clientCompanyId', 'managerId', 'supportManagerId'].every((key) => nullableId(price[key]))
    || !['showRetailPrices', 'showStock', 'showStockText', 'isActive'].every((key) => typeof price[key] === 'boolean')
    || !Array.isArray(price.items) || !Array.isArray(price.priceGroupStockSettings)) throw invalid();
  const keys = new Set<string>();
  for (const item of price.items) {
    if (!record(item) || !id(item.productId) || !nullableId(item.variantId)
      || !nullableText(item.customWholesalePrice) || !nullableText(item.discountPercent)
      || typeof item.priceManuallyChanged !== 'boolean' || typeof item.visible !== 'boolean'
      || typeof item.sortOrder !== 'number' || !Number.isSafeInteger(item.sortOrder) || item.sortOrder < 0) throw invalid();
    const key = `${item.productId}:${item.variantId ?? 'base'}`;
    if (keys.has(key)) throw invalid();
    keys.add(key);
  }
  for (const setting of price.priceGroupStockSettings) {
    if (!record(setting) || typeof setting.priceGroup !== 'string' || !setting.priceGroup.trim()
      || typeof setting.showStock !== 'boolean' || typeof setting.showStockText !== 'boolean') throw invalid();
  }
  return price as PriceListPayload;
}

export function assertWholesaleEditorCompanies(payload: unknown): void {
  if (!record(payload) || !Array.isArray(payload.companies) || payload.companies.some((company) =>
    !record(company) || !id(company.id) || typeof company.title !== 'string' || !company.title.trim()
    || !nullableId(company.managerId) || !nullableId(company.supportManagerId) || typeof company.isActive !== 'boolean')) {
    throw new Error('Список клиентов получен не полностью. Повторите загрузку.');
  }
}

export async function readWholesaleEditorResponse(url: string, signal: AbortSignal, failure: string): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) throw new Error(failure);
  try {
    return await response.json();
  } catch {
    throw new Error(`${failure}: некорректный ответ сервера.`);
  }
}
