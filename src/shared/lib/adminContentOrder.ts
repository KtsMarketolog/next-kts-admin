export type AdminContentOrderKind = 'slides' | 'news' | 'group-companies' | 'brand-categories';
export type AdminContentOrderItem = { id: number; sortOrder: number };

export const MAX_ADMIN_CONTENT_ORDER_ITEMS = 10_000;
export const MAX_ADMIN_CONTENT_ORDER_BODY_BYTES = 1024 * 1024;

export class AdminContentOrderValidationError extends Error {
  constructor(message: string, public readonly status: 400 | 413 | 408 = 400) {
    super(message);
    this.name = 'AdminContentOrderValidationError';
  }
}

function invalid(): never {
  throw new AdminContentOrderValidationError('Некорректный порядок элементов. Изменения не сохранены.');
}

/** The order endpoint intentionally cannot carry titles, images or other content. */
export function parseAdminContentOrder(body: unknown): AdminContentOrderItem[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  const source = body as Record<string, unknown>;
  if (Object.keys(source).length !== 1 || !Object.hasOwn(source, 'items') || !Array.isArray(source.items)) invalid();
  const entries = source.items;
  if (entries.length > MAX_ADMIN_CONTENT_ORDER_ITEMS) {
    throw new AdminContentOrderValidationError('Слишком много элементов для одной перестановки. Изменения не сохранены.', 413);
  }
  const ids = new Set<number>();
  const positions = new Set<number>();
  const items = entries.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid();
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'id') || !Object.hasOwn(entry, 'sortOrder')) invalid();
    const { id, sortOrder } = entry;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || ids.has(id)) invalid();
    if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder)
      || sortOrder < 1 || sortOrder > entries.length || positions.has(sortOrder)) invalid();
    ids.add(id);
    positions.add(sortOrder);
    return { id, sortOrder };
  });
  return items.sort((left, right) => left.sortOrder - right.sortOrder);
}

/** Bound the request while reading, including chunked bodies with no Content-Length. */
export async function readAdminContentOrderBody(request: Request): Promise<AdminContentOrderItem[]> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_ADMIN_CONTENT_ORDER_BODY_BYTES)) {
    throw new AdminContentOrderValidationError('Запрос перестановки слишком большой. Изменения не сохранены.', 413);
  }
  if (!request.body) invalid();
  const reader = request.body.getReader();
  // One fixed buffer also bounds allocation overhead for millions of tiny chunks.
  const bytes = new Uint8Array(MAX_ADMIN_CONTENT_ORDER_BODY_BYTES);
  let size = 0;
  let stopped: AdminContentOrderValidationError | null = null;
  const stop = (error: AdminContentOrderValidationError) => {
    stopped ??= error;
    // Cancelling closes pending reads even if the underlying source's cancellation
    // promise is slow. Do not attach one Promise.race reaction per network chunk.
    void reader.cancel().catch(() => {});
  };
  const abort = () => stop(new AdminContentOrderValidationError('Запрос прерван. Порядок не изменён.', 408));
  request.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new AdminContentOrderValidationError('Не удалось получить запрос вовремя. Порядок не изменён.', 408)), 10_000);
  try {
    if (request.signal.aborted) abort();
    while (true) {
      if (stopped) throw stopped;
      const { done, value } = await reader.read();
      if (stopped) throw stopped;
      if (done) break;
      if (size + value.byteLength > bytes.byteLength) {
        throw new AdminContentOrderValidationError('Запрос перестановки слишком большой. Изменения не сохранены.', 413);
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof AdminContentOrderValidationError) throw error;
    throw new AdminContentOrderValidationError('Не удалось прочитать запрос. Порядок не изменён.');
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } catch {
    invalid();
  }
  return parseAdminContentOrder(body);
}
