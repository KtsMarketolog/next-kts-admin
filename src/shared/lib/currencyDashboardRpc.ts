export const CURRENCY_RPC_CHANNEL = 'kts-currency-v1';
export const CURRENCY_RPC_MAX_BYTES = 2 * 1024 * 1024;
const methods = ['snapshot:get', 'snapshot:save', 'snapshot:rollback', 'source', 'baselines:get'] as const;
export type CurrencyRpcMethod = typeof methods[number];
export type CurrencyRpcRequest = { method: CurrencyRpcMethod; params: Record<string, unknown> };

export class CurrencyRequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function parseCurrencyRpcRequest(input: unknown): CurrencyRpcRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CurrencyRequestError('Некорректный запрос');
  const value = input as Record<string, unknown>;
  if (!methods.includes(value.method as CurrencyRpcMethod)) throw new CurrencyRequestError('Неизвестное действие');
  const params = value.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new CurrencyRequestError('Некорректные параметры');
  const result = { method: value.method as CurrencyRpcMethod, params: params as Record<string, unknown> };
  if (result.method === 'snapshot:save' || result.method === 'snapshot:rollback') {
    if (!Number.isSafeInteger(result.params.expectedRevision) || Number(result.params.expectedRevision) < 0) {
      throw new CurrencyRequestError('Сначала загрузите текущую версию снимка');
    }
  }
  return result;
}

/** Streaming bound also applies when Content-Length is absent or inaccurate. */
export async function readCurrencyRpcRequest(request: Request): Promise<CurrencyRpcRequest> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new CurrencyRequestError('Ожидается JSON', 415);
  }
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > CURRENCY_RPC_MAX_BYTES)) {
    throw new CurrencyRequestError('Снимок больше 2 МБ', 413);
  }
  if (!request.body) throw new CurrencyRequestError('Пустой запрос');
  const reader = request.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > CURRENCY_RPC_MAX_BYTES) throw new CurrencyRequestError('Снимок больше 2 МБ', 413);
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return parseCurrencyRpcRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch (error) {
    if (error instanceof CurrencyRequestError) throw error;
    throw new CurrencyRequestError('Не удалось прочитать JSON');
  }
}
