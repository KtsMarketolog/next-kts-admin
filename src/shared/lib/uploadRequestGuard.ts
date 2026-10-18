export const UPLOAD_REQUEST_IDLE_TIMEOUT_MS = 90_000;
export const UPLOAD_REQUEST_TOTAL_TIMEOUT_MS = 15 * 60_000;

export type UploadRequestErrorCode = 'TOO_LARGE' | 'IDLE_TIMEOUT' | 'TOTAL_TIMEOUT' | 'ABORTED';

const errorMessages: Record<UploadRequestErrorCode, string> = {
  TOO_LARGE: 'Размер загружаемого файла превышает допустимый предел.',
  IDLE_TIMEOUT: 'Передача файла слишком долго не продолжалась. Повторите загрузку.',
  TOTAL_TIMEOUT: 'Превышено время загрузки и проверки файла. Повторите загрузку.',
  ABORTED: 'Передача файла прервана. Повторите загрузку.',
};

export class UploadRequestError extends Error {
  readonly status: 400 | 408 | 413;

  constructor(readonly code: UploadRequestErrorCode) {
    super(errorMessages[code]);
    this.name = 'UploadRequestError';
    this.status = code === 'TOO_LARGE' ? 413 : code === 'ABORTED' ? 400 : 408;
  }
}

export type UploadRequestGuardOptions = {
  maxBytes: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
};

export type UploadRequestGuard = {
  request: Request;
  readonly error: UploadRequestError | null;
  assertActive(): void;
  dispose(): void;
};

/**
 * Bounds bytes before a body consumer (including formData) can accumulate them.
 * The total budget includes validation after EOF, until the caller disposes it.
 * This never releases a database/concurrency lock: callers must await their work
 * and cleanup before releasing the slot in their own finally block.
 */
export function createUploadRequestGuard(
  originalRequest: Request,
  options: UploadRequestGuardOptions,
): UploadRequestGuard {
  const idleTimeoutMs = options.idleTimeoutMs ?? UPLOAD_REQUEST_IDLE_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? UPLOAD_REQUEST_TOTAL_TIMEOUT_MS;
  for (const value of [options.maxBytes, idleTimeoutMs, totalTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError('Upload byte and time limits must be positive safe integers.');
    }
  }

  const startedAt = performance.now();
  const abortController = new AbortController();
  const reader = originalRequest.body?.getReader() ?? null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let failure: UploadRequestError | null = null;
  let disposed = false;
  let bodyEnded = false;
  let sourceEnded = false;
  let sourceCancelled = false;
  let receivedBytes = 0;

  function clearIdleTimer() {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  function clearTimers() {
    clearIdleTimer();
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    totalTimer = undefined;
  }

  function cancelSource(reason?: unknown) {
    if (!reader || sourceEnded || sourceCancelled) return;
    sourceCancelled = true;
    // A hostile/disconnected source may never finish cancel(). Do not let that
    // hold the consumer, temporary-file cleanup, or the shared upload slot.
    void reader.cancel(reason).catch(() => undefined);
  }

  function fail(error: UploadRequestError) {
    if (failure || disposed) return;
    failure = error;
    clearTimers();
    if (!bodyEnded && controller) {
      bodyEnded = true;
      controller.error(error);
    }
    abortController.abort(error);
    cancelSource(error);
  }

  function assertActive() {
    // Also enforce the deadline synchronously when a busy event loop delayed
    // its timer, particularly immediately before committing a validated file.
    if (!disposed && !failure && performance.now() - startedAt >= totalTimeoutMs) {
      fail(new UploadRequestError('TOTAL_TIMEOUT'));
    }
    if (failure) throw failure;
  }

  function onOriginalAbort() {
    fail(new UploadRequestError('ABORTED'));
  }

  const body = reader
    ? new ReadableStream<Uint8Array>(
        {
          start(streamController) {
            controller = streamController;
          },
          async pull(streamController) {
            if (disposed || bodyEnded) return;
            try {
              assertActive();
              idleTimer = setTimeout(() => fail(new UploadRequestError('IDLE_TIMEOUT')), idleTimeoutMs);
              let result = await reader.read();
              // Empty chunks are not transfer progress. Keep the same idle
              // timer and yield so an empty-chunk loop cannot starve it.
              while (!result.done && !result.value.byteLength && !disposed && !bodyEnded) {
                assertActive();
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                if (disposed || bodyEnded) return;
                result = await reader.read();
              }
              clearIdleTimer();
              if (disposed || bodyEnded) return;
              assertActive();
              if (result.done) {
                sourceEnded = true;
                bodyEnded = true;
                streamController.close();
                reader.releaseLock();
                return;
              }
              receivedBytes += result.value.byteLength;
              if (receivedBytes > options.maxBytes) {
                fail(new UploadRequestError('TOO_LARGE'));
                return;
              }
              streamController.enqueue(result.value);
            } catch {
              clearIdleTimer();
              if (!disposed && !bodyEnded) fail(new UploadRequestError('ABORTED'));
            }
          },
          cancel(reason) {
            bodyEnded = true;
            clearIdleTimer();
            cancelSource(reason);
          },
        },
        // Do not prefetch an extra request chunk while validation is applying
        // backpressure; idle measures waiting for input, not consumer CPU work.
        { highWaterMark: 0 },
      )
    : null;

  originalRequest.signal.addEventListener('abort', onOriginalAbort, { once: true });
  totalTimer = setTimeout(() => fail(new UploadRequestError('TOTAL_TIMEOUT')), totalTimeoutMs);
  if (originalRequest.signal.aborted) onOriginalAbort();

  let request: Request;
  try {
    request = new Request(originalRequest, {
      body,
      signal: abortController.signal,
      ...(body ? { duplex: 'half' } : {}),
    } as RequestInit);
  } catch (error) {
    clearTimers();
    originalRequest.signal.removeEventListener('abort', onOriginalAbort);
    cancelSource(error);
    throw error;
  }

  return {
    request,
    get error() {
      return failure;
    },
    assertActive,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimers();
      originalRequest.signal.removeEventListener('abort', onOriginalAbort);
      if (!bodyEnded && controller) {
        bodyEnded = true;
        controller.close();
      }
      cancelSource();
    },
  };
}
