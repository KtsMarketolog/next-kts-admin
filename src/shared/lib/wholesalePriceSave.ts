import type { WholesalePriceListItemInput } from './db/wholesaleAdminRepo/types';
import { normalizeWholesaleDiscountPercent, normalizeWholesalePrice } from './wholesaleSecurity';

// Bound memory, not catalogue size. Oversized requests fail before any writes;
// an accepted request is never silently shortened to a fixed number of items.
export const MAX_WHOLESALE_PRICE_BODY_BYTES = 16 * 1024 * 1024;

export class WholesalePriceSaveValidationError extends Error {
  constructor(message: string, public readonly status: 400 | 413 = 400) {
    super(message);
    this.name = 'WholesalePriceSaveValidationError';
  }
}

function tooLarge(): never {
  throw new WholesalePriceSaveValidationError('Прайс слишком большой для одного запроса. Изменения не сохранены.', 413);
}

export async function readWholesalePriceSaveBody(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_WHOLESALE_PRICE_BODY_BYTES) {
    tooLarge();
  }
  if (!request.body) throw new WholesalePriceSaveValidationError('Не переданы данные прайса');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let pending: Buffer | null = null;
  let pendingSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WHOLESALE_PRICE_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        tooLarge();
      }
      // Coalesce small network chunks: a byte cap alone would still allow
      // millions of tiny retained Uint8Arrays and their allocation overhead.
      for (let offset = 0; offset < value.byteLength;) {
        pending ??= Buffer.allocUnsafe(64 * 1024);
        const copied = Math.min(pending.byteLength - pendingSize, value.byteLength - offset);
        pending.set(value.subarray(offset, offset + copied), pendingSize);
        pendingSize += copied;
        offset += copied;
        if (pendingSize === pending.byteLength) {
          chunks.push(pending);
          pending = null;
          pendingSize = 0;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (pending) chunks.push(pending.subarray(0, pendingSize));
  try {
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid object');
    return body as Record<string, unknown>;
  } catch {
    throw new WholesalePriceSaveValidationError('Некорректные данные прайса. Изменения не сохранены.');
  }
}

function positiveId(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function optionalAmount(value: unknown, discount = false) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return null;
  const amount = discount ? normalizeWholesaleDiscountPercent(value) : normalizeWholesalePrice(value);
  if (amount === null) {
    throw new WholesalePriceSaveValidationError(discount ? 'Некорректная скидка в позиции прайса' : 'Некорректная цена в позиции прайса');
  }
  return amount;
}

export function parseWholesalePriceItems(items: unknown): WholesalePriceListItemInput[] {
  if (!Array.isArray(items)) throw new WholesalePriceSaveValidationError('Не передан список позиций прайса');
  const keys = new Set<string>();
  return items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new WholesalePriceSaveValidationError('Некорректная позиция прайса');
    }
    const source = item as Record<string, unknown>;
    const productId = positiveId(source.productId);
    const variantId = source.variantId === null || source.variantId === undefined ? null : positiveId(source.variantId);
    if (productId === null || (source.variantId !== null && source.variantId !== undefined && variantId === null)) {
      throw new WholesalePriceSaveValidationError('Некорректный товар или вариант в прайсе');
    }
    const key = `${productId}:${variantId ?? 'base'}`;
    if (keys.has(key)) throw new WholesalePriceSaveValidationError('В прайсе есть повторяющиеся позиции. Обновите страницу.');
    keys.add(key);
    if (typeof source.visible !== 'boolean'
      || (source.priceManuallyChanged !== undefined && typeof source.priceManuallyChanged !== 'boolean')) {
      throw new WholesalePriceSaveValidationError('Некорректные настройки позиции прайса');
    }
    const sortOrder = source.sortOrder === undefined ? index + 1 : Number(source.sortOrder);
    if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 2147483647
      || (source.sortOrder !== undefined && typeof source.sortOrder !== 'number' && typeof source.sortOrder !== 'string')) {
      throw new WholesalePriceSaveValidationError('Некорректный порядок позиций прайса');
    }
    return {
      productId,
      variantId,
      customWholesalePrice: optionalAmount(source.customWholesalePrice),
      discountPercent: optionalAmount(source.discountPercent, true),
      priceManuallyChanged: source.priceManuallyChanged === true,
      visible: source.visible,
      sortOrder,
    };
  });
}
