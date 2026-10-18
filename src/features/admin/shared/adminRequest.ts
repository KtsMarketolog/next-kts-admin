/** Simple edits, uploads/imports, and large snapshots have different budgets. */
export const ADMIN_REQUEST_TIMEOUT_MS = 20_000;
export const ADMIN_UPLOAD_TIMEOUT_MS = 5 * 60_000;
export const ADMIN_SNAPSHOT_TIMEOUT_MS = 20 * 60_000;
export const ADMIN_UNKNOWN_OUTCOME = 'Ответ сервера не получен. Изменение могло сохраниться. Обновите данные и проверьте результат перед повторной попыткой.';

export type AdminRequestOptions = { timeoutMs?: number; mutation?: boolean };

export class AdminRequestError extends Error {
  readonly status = 0;
  constructor(message: string, readonly code: 'timeout' | 'cancelled' | 'network') {
    super(message);
    this.name = 'AdminRequestError';
  }
}

/** The race also releases UI locks when fetch/body reading ignores abort. No retries. */
export async function runWithRequestTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: AdminRequestOptions & { signal?: AbortSignal | null } = {},
): Promise<T> {
  if (options.signal?.aborted) throw new AdminRequestError('Запрос отменён до отправки.', 'cancelled');
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs) : ADMIN_REQUEST_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop!: (reason: 'timeout' | 'cancelled') => void;
  const interrupted = new Promise<never>((_, reject) => {
    stop = (reason) => {
      reject(new AdminRequestError(options.mutation ? ADMIN_UNKNOWN_OUTCOME : (
        reason === 'cancelled' ? 'Запрос отменён.' : 'Сервер не ответил вовремя. Повторите загрузку данных.'
      ), reason));
      controller.abort();
    };
    timer = setTimeout(() => stop('timeout'), timeoutMs);
  });
  const abort = () => stop('cancelled');
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([interrupted, work(controller.signal)]);
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Deadline covers headers AND body, including error bodies. Return a buffered
 * Response so existing status/error handling remains intact; not for SSE or
 * unbounded streams. Uploaded files are never read into JS memory here.
 */
export async function adminRequest(url: string, init: RequestInit = {}, options: AdminRequestOptions = {}): Promise<Response> {
  const mutation = options.mutation ?? !['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase());
  try {
    return await runWithRequestTimeout(async (signal) => {
      const response = await fetch(url, { cache: 'no-store', ...init, signal });
      const body = await response.arrayBuffer();
      const buffered = new Response([101, 204, 205, 304].includes(response.status) || init.method?.toUpperCase() === 'HEAD' ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      Object.defineProperties(buffered, {
        url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
      });
      return buffered;
    }, { ...options, mutation, signal: init.signal });
  } catch (error) {
    if (error instanceof AdminRequestError) throw error;
    throw new AdminRequestError(mutation ? ADMIN_UNKNOWN_OUTCOME : 'Не удалось получить ответ сервера. Повторите загрузку данных.', 'network');
  }
}
