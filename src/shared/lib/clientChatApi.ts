export class ClientChatRequestError extends Error {
  constructor(message: string, readonly status: 400 | 408 | 413 = 400) {
    super(message);
    this.name = 'ClientChatRequestError';
  }
}

export const CLIENT_CHAT_MAX_ACK_IDS = 100;
const MAX_READ_BODY_BYTES = 4096;

export function clientChatResponse(response: Response) {
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Vary', 'Cookie');
  return response;
}

export function parseClientChatId(value: string): number {
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ClientChatRequestError('Некорректный идентификатор сообщения или клиента');
  }
  return Number(value);
}

export function parseClientChatPage(url: string): { before?: number; after?: number; receiptIds?: number[] } {
  const params = new URL(url).searchParams;
  for (const key of ['before', 'after', 'receiptIds']) {
    if (params.getAll(key).length > 1) throw new ClientChatRequestError('Параметр истории указан несколько раз');
  }
  if (params.has('before') && params.has('after')) throw new ClientChatRequestError('Выберите одно направление загрузки истории');
  const before = params.has('before') ? parseClientChatId(params.get('before')!) : undefined;
  // Zero is the start-of-history cursor for a chat that was initially empty.
  const after = params.has('after') ? params.get('after') === '0' ? 0 : parseClientChatId(params.get('after')!) : undefined;
  const receiptValues = params.has('receiptIds') ? params.get('receiptIds')!.split(',') : undefined;
  if (receiptValues && receiptValues.length > CLIENT_CHAT_MAX_ACK_IDS) throw new ClientChatRequestError('Слишком много сообщений в запросе');
  const receiptIds = receiptValues ? [...new Set(receiptValues.map(parseClientChatId))] : undefined;
  return { ...(before ? { before } : {}), ...(after !== undefined ? { after } : {}), ...(receiptIds ? { receiptIds } : {}) };
}

export function parseClientChatReadBody(body: unknown): number[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ClientChatRequestError('Некорректное подтверждение прочтения');
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.messageIds)
    || record.messageIds.length < 1 || record.messageIds.length > CLIENT_CHAT_MAX_ACK_IDS
    || record.messageIds.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
    throw new ClientChatRequestError('Нужно передать от 1 до 100 идентификаторов показанных сообщений');
  }
  return [...new Set(record.messageIds as number[])];
}

/** Read acknowledgements contain IDs only; bound chunked bodies before parsing. */
export async function readClientChatAcknowledgement(request: Request): Promise<number[]> {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_READ_BODY_BYTES)) {
    throw new ClientChatRequestError('Подтверждение прочтения слишком большое', 413);
  }
  if (!request.body) throw new ClientChatRequestError('Нет подтверждения прочтения');
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_READ_BODY_BYTES);
  let size = 0;
  let stopped: ClientChatRequestError | undefined;
  const abort = () => {
    stopped ??= new ClientChatRequestError('Подтверждение прочтения прервано; повторите запрос', 408);
    void reader.cancel().catch(() => {});
  };
  const timer = setTimeout(abort, 10_000);
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    if (request.signal.aborted) abort();
    while (true) {
      if (stopped) throw stopped;
      const { done, value } = await reader.read();
      if (stopped) throw stopped;
      if (done) break;
      if (size + value.byteLength > bytes.byteLength) throw new ClientChatRequestError('Подтверждение прочтения слишком большое', 413);
      bytes.set(value, size);
      size += value.byteLength;
    }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))); }
    catch { throw new ClientChatRequestError('Некорректное подтверждение прочтения'); }
    return parseClientChatReadBody(body);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
