'use client';

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

import {
  formatCatalogAmount,
  formatDiscountPercent,
  normalizeDiscountPercent,
  type PriceEditor,
  type PriceItem,
} from './AdminWholesaleModel';

type CatalogDiscountBase = {
  amount: number | null;
  groupKey: string;
};

type UseWholesaleEditorActionsOptions = {
  editor: PriceEditor;
  setEditor: Dispatch<SetStateAction<PriceEditor>>;
  catalogDiscountBaseByKey: Map<string, CatalogDiscountBase>;
  showStatus: (message: string) => void;
};

export function useWholesaleEditorActions({
  editor,
  setEditor,
  catalogDiscountBaseByKey,
  showStatus,
}: UseWholesaleEditorActionsOptions) {
  const [groupDiscounts, setGroupDiscounts] = useState<Record<string, string>>({});
  const [appliedGroupDiscounts, setAppliedGroupDiscounts] = useState<Record<string, string>>({});
  const [expandedPriceGroups, setExpandedPriceGroups] = useState<Record<string, boolean>>({});

  const updateItem = useCallback(
    (key: string, patch: Partial<PriceItem>) => {
      if ('customWholesalePrice' in patch) {
        const groupKey = catalogDiscountBaseByKey.get(key)?.groupKey;
        if (groupKey) {
          setAppliedGroupDiscounts((current) => {
            const next = { ...current };
            delete next[groupKey];
            return next;
          });
        }
      }
      setEditor((current) => ({
        ...current,
        items: current.items.map((item) =>
          `${item.productId}:${item.variantId ?? 'base'}` === key
            ? {
                ...item,
                ...patch,
                priceManuallyChanged:
                  'customWholesalePrice' in patch ? true : (patch.priceManuallyChanged ?? item.priceManuallyChanged),
              }
            : item,
        ),
      }));
    },
    [catalogDiscountBaseByKey, setEditor],
  );

  const setProductVisible = useCallback(
    (productId: number, visible: boolean) => {
      setEditor((current) => ({
        ...current,
        items: current.items.map((item) => (item.productId === productId ? { ...item, visible } : item)),
      }));
    },
    [setEditor],
  );

  const setPriceGroupVisible = useCallback(
    (groupKey: string, visible: boolean) => {
      setEditor((current) => ({
        ...current,
        items: current.items.map((item) => {
          const key = `${item.productId}:${item.variantId ?? 'base'}`;
          const base = catalogDiscountBaseByKey.get(key);
          return base?.groupKey === groupKey ? { ...item, visible } : item;
        }),
      }));
    },
    [catalogDiscountBaseByKey, setEditor],
  );

  const togglePriceGroupExpanded = useCallback((groupKey: string) => {
    setExpandedPriceGroups((current) => ({
      ...current,
      [groupKey]: !current[groupKey],
    }));
  }, []);

  const calculateDiscount = useCallback(
    (value: string, groupKey: string) => {
      const percent = normalizeDiscountPercent(value);
      if (percent === null) {
        showStatus('Введите процент скидки');
        return;
      }
      const changedCount = editor.items.filter((item) => {
        const key = `${item.productId}:${item.variantId ?? 'base'}`;
        const base = catalogDiscountBaseByKey.get(key);
        return Boolean(base && base.amount !== null && (!groupKey || base.groupKey === groupKey));
      }).length;
      setEditor((current) => ({
        ...current,
        items: current.items.map((item) => {
          const key = `${item.productId}:${item.variantId ?? 'base'}`;
          const base = catalogDiscountBaseByKey.get(key);
          if (!base || base.amount === null || (groupKey && base.groupKey !== groupKey)) return item;
          return {
            ...item,
            customWholesalePrice: formatCatalogAmount(base.amount * (1 - percent / 100)),
            priceManuallyChanged: false,
          };
        }),
      }));
      if (changedCount > 0) {
        setAppliedGroupDiscounts((current) => ({
          ...current,
          [groupKey]: formatDiscountPercent(percent),
        }));
      }
      showStatus(changedCount > 0 ? 'Цены рассчитаны' : 'В выбранной группе нет цен для расчёта');
    },
    [catalogDiscountBaseByKey, editor.items, setEditor, showStatus],
  );

  return {
    groupDiscounts,
    setGroupDiscounts,
    appliedGroupDiscounts,
    expandedPriceGroups,
    updateItem,
    setProductVisible,
    setPriceGroupVisible,
    togglePriceGroupExpanded,
    calculateDiscount,
  };
}
