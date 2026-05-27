export type WholesaleStockDisplayMode = 'hidden' | 'number' | 'text';

export function resolveWholesaleStockDisplayMode(input: {
  globalShowNumbers: boolean;
  globalShowText: boolean;
  groupShowNumbers?: boolean | null;
  groupShowText?: boolean | null;
}): WholesaleStockDisplayMode {
  if (input.groupShowText === true) return 'text';
  if (input.groupShowNumbers === true) return 'number';
  if (input.globalShowText) return 'text';
  if (input.globalShowNumbers) return 'number';
  return 'hidden';
}

export function formatWholesaleStockLabel(input: {
  stock: number;
  unit?: string | null;
  isExpected: boolean;
  mode: WholesaleStockDisplayMode;
}) {
  if (input.mode === 'hidden') return '';
  if (input.stock > 0) {
    if (input.mode === 'text') return 'В наличии';
    const unit = input.unit?.trim() || 'шт.';
    return `В наличии: ${input.stock} ${unit}`;
  }
  return input.isExpected ? 'Ожидается поступление' : 'Под заказ';
}

export function hasVisibleWholesaleStock(mode: WholesaleStockDisplayMode) {
  return mode !== 'hidden';
}
