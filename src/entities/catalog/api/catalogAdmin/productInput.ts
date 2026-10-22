import { normalizeText, normalizeCatalogArticle, normalizeCatalogPriceFields, normalizeStockValue } from './helpers';
import type { CatalogProductInput } from './types';

export type NormalizedCatalogProductInput = {
  title: string;
  article: string;
  model: string;
  brand: string;
  category: string;
  subcategory: string;
  priceGroup: string;
  unit: string | null;
  priceEur: string | null;
  priceRub: string | null;
  priceCny: string | null;
  generalDiscount: string | null;
  manualDiscount: string | null;
  manualDiscountRop: string | null;
  stock: number | null;
  isExpected: boolean | null;
  isActive: boolean;
};

export function normalizeInput(input: CatalogProductInput): NormalizedCatalogProductInput {
  const article = normalizeCatalogArticle(input.article);
  const unit = normalizeText(input.unit, 80);
  return {
    title: normalizeText(input.title, 500) || article,
    article,
    model: normalizeText(input.model, 180),
    brand: normalizeText(input.brand, 180),
    category: normalizeText(input.category, 180),
    subcategory: normalizeText(input.subcategory, 180),
    priceGroup: normalizeText(input.priceGroup, 180),
    unit: unit || null,
    ...normalizeCatalogPriceFields(input),
    stock: normalizeStockValue(input.stock),
    isExpected: input.isExpected === null || input.isExpected === undefined ? null : Boolean(input.isExpected),
    isActive: input.isActive ?? true,
  };
}
