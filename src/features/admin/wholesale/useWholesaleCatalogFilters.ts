import { useDeferredValue, useMemo } from 'react';

import {
  NO_PRICE_GROUP_TITLE,
  flatCatalogItems,
  getDiscountBaseAmount,
  groupCatalogRowsByPriceGroup,
  type CatalogCategory,
} from './AdminWholesaleModel';

type UseWholesaleCatalogFiltersOptions = {
  catalog: CatalogCategory[];
  catalogQuery: string;
  catalogCategoryId: string;
  catalogPriceGroup: string;
};

export function useWholesaleCatalogFilters({
  catalog,
  catalogQuery,
  catalogCategoryId,
  catalogPriceGroup,
}: UseWholesaleCatalogFiltersOptions) {
  const deferredCatalogQuery = useDeferredValue(catalogQuery);
  const catalogRows = useMemo(() => flatCatalogItems(catalog), [catalog]);
  const catalogDiscountBaseByKey = useMemo(
    () =>
      new Map(
        catalogRows.map((row) => [
          row.key,
          {
            amount: getDiscountBaseAmount(row),
            groupKey: (row.product.priceGroup || NO_PRICE_GROUP_TITLE).toLowerCase(),
          },
        ]),
      ),
    [catalogRows],
  );
  const catalogPriceGroups = useMemo(() => {
    const groups = new Set<string>();
    for (const { product } of catalogRows) {
      if (product.priceGroup) groups.add(product.priceGroup);
    }
    return Array.from(groups).sort((first, second) => first.localeCompare(second, 'ru'));
  }, [catalogRows]);
  const filteredCatalogRows = useMemo(() => {
    const query = deferredCatalogQuery.trim().toLowerCase();
    return catalogRows.filter(({ category, product, variant }) => {
      if (catalogCategoryId !== 'all' && String(category.id) !== catalogCategoryId) return false;
      if (catalogPriceGroup !== 'all' && product.priceGroup !== catalogPriceGroup) return false;
      if (!query) return true;
      return [
        category.title,
        product.title,
        product.sku,
        product.description,
        product.priceGroup,
        product.priceEur,
        product.priceRub,
        product.priceCny,
        variant.title,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [catalogCategoryId, catalogPriceGroup, catalogRows, deferredCatalogQuery]);
  const sortedCatalogRows = useMemo(
    () =>
      [...filteredCatalogRows].sort((first, second) => {
        const firstGroup = first.product.priceGroup;
        const secondGroup = second.product.priceGroup;
        if (!firstGroup && secondGroup) return 1;
        if (firstGroup && !secondGroup) return -1;
        return (
          firstGroup.localeCompare(secondGroup, 'ru') ||
          first.category.title.localeCompare(second.category.title, 'ru') ||
          first.product.title.localeCompare(second.product.title, 'ru') ||
          first.variant.title.localeCompare(second.variant.title, 'ru')
        );
      }),
    [filteredCatalogRows],
  );
  const filteredCatalogGroups = useMemo(() => groupCatalogRowsByPriceGroup(sortedCatalogRows), [sortedCatalogRows]);

  return {
    catalogRows,
    catalogDiscountBaseByKey,
    catalogPriceGroups,
    filteredCatalogRows,
    filteredCatalogGroups,
  };
}
