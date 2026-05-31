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
  stockByLocation?: {
    volzhsk?: number | null;
    moscow?: number | null;
  };
}) {
  if (input.mode === 'hidden') return '';
  if (input.stock > 0) {
    const unit = input.unit?.trim() || 'шт.';
    const locationStock = [
      { amount: Number(input.stockByLocation?.volzhsk ?? 0), label: 'Волжске' },
      { amount: Number(input.stockByLocation?.moscow ?? 0), label: 'Москве' },
    ].filter((item) => Number.isFinite(item.amount) && item.amount > 0);
    const locationTotal = locationStock.reduce((sum, item) => sum + item.amount, 0);
    const exactLocationBreakdown = locationStock.length > 0 && locationTotal === input.stock;
    const locationText =
      locationStock.length === 1
        ? `в ${locationStock[0].label}`
        : locationStock.length > 1
          ? `в ${locationStock.map((item) => item.label).join(' и ')}`
          : '';

    if (input.mode === 'text') return locationText ? `В наличии ${locationText}` : 'В наличии';
    if (exactLocationBreakdown) {
      return `В наличии: ${locationStock.map((item) => `${item.amount} ${unit} в ${item.label}`).join(', ')}`;
    }
    if (locationText) return `В наличии: ${input.stock} ${unit} ${locationText}`;
    return `В наличии: ${input.stock} ${unit}`;
  }
  return input.isExpected ? 'Ожидается поступление' : 'Под заказ';
}

export function hasVisibleWholesaleStock(mode: WholesaleStockDisplayMode) {
  return mode !== 'hidden';
}
