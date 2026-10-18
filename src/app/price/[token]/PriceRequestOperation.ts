import type { RubConversionRequest } from './PriceRequestForm.helpers';

export type PriceRequestBody = { items: Array<{ id: number; quantity: number }>; comment: string; rubConversion: RubConversionRequest | null };
export type PriceRequestOperation = { intent: string; body: PriceRequestBody & { operationId: string } };

/** Keep the original conversion snapshot after an uncertain network outcome; rate polling is not a new order. */
export function nextPriceRequestOperation(previous: PriceRequestOperation | null, body: PriceRequestBody, uuid: () => string): PriceRequestOperation {
  const intent = JSON.stringify({ items: [...body.items].sort((a, b) => a.id - b.id), comment: body.comment,
    conversionItems: [...(body.rubConversion?.itemIds ?? [])].sort((a, b) => a - b) });
  return previous?.intent === intent ? previous : { intent, body: { ...body, operationId: uuid() } };
}

function storageKey(token: string) { return `kts:price-request-operation:${encodeURIComponent(token)}`; }
type OperationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Only an opaque operation ID and SHA-256 intent digest persist; never customer comments/items/prices. */
export async function preparePriceRequestOperation(
  previous: PriceRequestOperation | null, body: PriceRequestBody, token: string,
  storage: OperationStorage | null,
): Promise<PriceRequestOperation> {
  const operation = nextPriceRequestOperation(previous, body, () => crypto.randomUUID());
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(operation.intent));
  const digest = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  try {
    const raw = storage?.getItem(storageKey(token));
    const stored = raw && raw.length < 256 ? JSON.parse(raw) : null;
    if (!previous && stored?.digest === digest && typeof stored.operationId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(stored.operationId)) {
      operation.body.operationId = stored.operationId;
    }
    storage?.setItem(storageKey(token), JSON.stringify({ digest, operationId: operation.body.operationId }));
  } catch { /* Storage-disabled browsers still retain the operation in memory during retries. */ }
  return operation;
}

export function confirmPriceRequestOperation(token: string, storage: OperationStorage | null) {
  try { storage?.removeItem(storageKey(token)); } catch { /* In-memory receipt remains confirmed. */ }
}
