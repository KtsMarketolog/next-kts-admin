import {
  matchAnalogCatalogProducts, type AnalogCatalogIndex, type AnalogCatalogCandidate,
} from '@/shared/lib/analogCatalogMatching';
import type { AnalogCatalogProduct } from './analogCatalogRepo';

export type AnalogStockMatch = {
  productId: number;
  title: string;
  sku: string;
  model: string;
  brand: string;
  stock: number;
  stockVolzhsk: number;
  stockMoscow: number;
  unit: string;
  isExpected: boolean;
  matchedBy: 'model' | 'sku' | 'title';
  matchKind: 'exact' | 'normalized-span';
};

export function getAnalogStockMatches(
  candidates: readonly (AnalogCatalogCandidate & { id: string; catalogAliases?: readonly string[] })[],
  catalog: AnalogCatalogIndex<AnalogCatalogProduct>,
): Map<string, AnalogStockMatch[]> {
  return new Map(candidates.map((candidate) => [candidate.id,
    matchAnalogCatalogProducts({ ...candidate, aliases: candidate.catalogAliases ?? candidate.aliases }, catalog).map(({ product, matchedBy, matchKind }) => ({
      productId: product.id, title: product.title, sku: product.sku, model: product.model, brand: product.brand,
      stock: product.stock, stockVolzhsk: product.stockVolzhsk, stockMoscow: product.stockMoscow,
      unit: product.unit, isExpected: product.isExpected, matchedBy, matchKind,
    })),
  ]));
}
