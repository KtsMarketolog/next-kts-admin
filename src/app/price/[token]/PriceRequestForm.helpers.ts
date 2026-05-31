import type { PublicWholesaleCategory } from '@/shared/lib/db';
import { formatWholesaleStockLabel } from '@/shared/lib/wholesaleStockDisplay';

export const CURRENCY_CODES = ['EUR', 'CNY'] as const;

export type CurrencyCode = (typeof CURRENCY_CODES)[number];
export type DisplayCurrencyCode = CurrencyCode | 'RUB';
export type ExchangeRates = {
  date: string | null;
  rates: Record<CurrencyCode, number>;
  sourceUrl: string;
};
export type ExchangeRateStatus = 'idle' | 'loading' | 'ready' | 'error';
export type RubConversionRequest = {
  date: string | null;
  rates: Record<CurrencyCode, number>;
  itemIds: number[];
};

export const NO_PRICE_GROUP_TITLE = 'Без ценовой группы';

export function formatPrice(value: string | null) {
  if (!value) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(number);
}

export function hasPriceValue(value: string | null) {
  if (!value) return false;
  const number = Number(value.replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(number) ? number > 0 : value.trim().length > 0;
}

function parsePriceNumber(value: string | null) {
  if (!value) return null;
  const number = Number(value.replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function formatAmountList(values: Array<{ amount: number; currency: string }>) {
  if (values.length === 0) return '0';
  return values
    .map((value) => `${formatPrice(String(value.amount))}${value.currency ? ` ${value.currency}` : ''}`)
    .join(' / ');
}

export function formatRetryAfter(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'позже';
  if (seconds < 60) return `${Math.ceil(seconds)} сек.`;
  return `${Math.ceil(seconds / 60)} мин.`;
}

export type PublicPriceVariant = PublicWholesaleCategory['products'][number]['variants'][number];

export function getCurrencyPriceValues(variant: PublicPriceVariant): Array<{ value: string | null; currency: DisplayCurrencyCode }> {
  return [
    { value: variant.priceEur, currency: 'EUR' },
    { value: variant.priceRub, currency: 'RUB' },
    { value: variant.priceCny, currency: 'CNY' },
  ];
}

export function getVariantRequestPrices(variant: PublicPriceVariant) {
  const currencyPrices = getCurrencyPriceValues(variant)
    .map((price) => ({ amount: parsePriceNumber(price.value), currency: price.currency }))
    .filter((price): price is { amount: number; currency: DisplayCurrencyCode } => price.amount !== null);

  const fallbackPrice = parsePriceNumber(variant.wholesalePrice);
  return currencyPrices.length > 0
    ? currencyPrices
    : fallbackPrice
      ? [{ amount: fallbackPrice, currency: '' }]
      : [];
}

export function formatRubAmount(value: number) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(value));
}

export function getConvertedRubAmount(price: { value: string | null; currency: DisplayCurrencyCode }, exchangeRates: ExchangeRates | null) {
  if (!exchangeRates || price.currency === 'RUB') return null;
  const amount = parsePriceNumber(price.value);
  if (amount === null) return null;
  return amount * exchangeRates.rates[price.currency];
}

export function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function stockLabel(product: PublicWholesaleCategory['products'][number]) {
  return formatWholesaleStockLabel({
    stock: product.stock,
    unit: product.unit,
    isExpected: product.isExpected,
    mode: product.stockDisplayMode,
    stockByLocation: {
      volzhsk: product.stockVolzhsk,
      moscow: product.stockMoscow,
    },
  });
}

export function normalizeQuantityInput(value: string) {
  if (!value.trim()) return 0;
  const quantity = Number(value);
  if (!Number.isFinite(quantity)) return 0;
  return Math.max(0, Math.min(999, Math.floor(quantity)));
}

export function resizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

export function isExchangeRatesPayload(value: unknown): value is ExchangeRates {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Record<string, unknown>;
  const rates = payload.rates as Record<string, unknown> | undefined;
  return (
    Boolean(rates) &&
    CURRENCY_CODES.every((code) => {
      const rate = rates?.[code];
      return typeof rate === 'number' && Number.isFinite(rate);
    }) &&
    (typeof payload.date === 'string' || payload.date === null) &&
    typeof payload.sourceUrl === 'string'
  );
}

type PriceClientEventType =
  | 'public_price_product_opened'
  | 'public_price_request_started'
  | 'public_price_quantity_changed'
  | 'public_price_request_abandoned';

export function trackPriceEvent(token: string, eventType: PriceClientEventType, metadata: Record<string, unknown>, beacon = false) {
  const payload = JSON.stringify({ eventType, metadata });
  const url = `/api/price/${encodeURIComponent(token)}/event`;

  if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
    return;
  }

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: beacon,
  }).catch(() => {
    // Analytics must not block the public price request flow.
  });
}
