import { AdminRequestError, ADMIN_UPLOAD_TIMEOUT_MS, runWithRequestTimeout } from '@/features/admin/shared/adminRequest';
import { SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES, SUPPORT_SHARED_JSON_MAX_BYTES } from '@/shared/lib/supportSharedRoutePlannerLimits';

export const MAX_SHARED_JSON_BYTES = SUPPORT_SHARED_JSON_MAX_BYTES;
export const MAX_SHARED_JSON_GZIP_BYTES = SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES;

export function validateSharedJsonFile(file: Pick<File, 'name' | 'size'>) {
  if (!/\.json(?:\.gz)?$/i.test(file.name) || file.size === 0) {
    throw new Error('Выберите непустой JSON-снимок компоновщика (.json или .json.gz).');
  }
  if (file.size > MAX_SHARED_JSON_BYTES) {
    const size = (file.size / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    throw new Error(`Размер файла — ${size} МиБ (${file.size.toLocaleString('ru-RU')} байт). Допустимо до ${MAX_SHARED_JSON_BYTES / (1024 * 1024)} МиБ. Файл не отправлен; действующие данные не изменены.`);
  }
}

type SharedJsonPreparationOptions = { signal?: AbortSignal; timeoutMs?: number; onProgress?: (percent: number) => void };

function preparationError(error: unknown): never {
  if (error instanceof AdminRequestError) throw new Error(error.code === 'cancelled'
    ? 'Подготовка JSON прервана. Файл не отправлен.'
    : 'Подготовка JSON заняла слишком много времени. Файл не отправлен. Попробуйте подготовить его заново.');
  throw error;
}

/** A File is immutable: inspect only its signature, then send the same archive without a memory-sized copy. */
async function prepareExistingSharedGzip(file: File, options: SharedJsonPreparationOptions): Promise<Blob> {
  if (typeof file.slice !== 'function') {
    throw new Error('Этот браузер не поддерживает безопасную загрузку JSON.gz. Откройте страницу в актуальной версии Chrome, Firefox или Safari.');
  }
  try {
    return await runWithRequestTimeout(async (signal) => {
      const signature = new Uint8Array(await file.slice(0, 3).arrayBuffer());
      signal.throwIfAborted();
      if (signature.length !== 3 || signature[0] !== 0x1f || signature[1] !== 0x8b || signature[2] !== 8) {
        throw new Error('Файл .json.gz не является архивом gzip. Выберите исходный .json или корректный .json.gz. Файл не отправлен; действующие данные не изменены.');
      }
      options.onProgress?.(100);
      signal.throwIfAborted();
      // Complete gzip integrity, JSON structure and expanded-size checks stay on
      // the server before publication. Do not decompress or gzip again here.
      return file.slice(0, file.size, 'application/gzip');
    }, { signal: options.signal, timeoutMs: options.timeoutMs ?? ADMIN_UPLOAD_TIMEOUT_MS, mutation: false });
  } catch (error) { return preparationError(error); }
}

/** Own the file reader so stopping does not depend on gzip/pipe cancellation. */
function openSharedJsonSource(file: File, signal: AbortSignal, onError: (error: unknown) => void) {
  const reader = file.stream().getReader();
  let stopped = false;
  const stop = (reason?: unknown) => {
    if (stopped) return;
    stopped = true;
    // Initiate cancellation immediately; a broken cancel callback must not keep
    // the UI waiting or replace the original size/timeout error. cancel() settles
    // pending reads synchronously, so the lock can also be released immediately.
    void reader.cancel(reason).catch(() => undefined);
    reader.releaseLock();
  };
  const abort = () => stop(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      if (stopped) return;
      try {
        const next = await reader.read();
        if (stopped) return;
        if (next.done) { stop(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) {
        if (!stopped) { onError(error); stop(error); controller.error(error); }
      }
    },
    cancel: stop,
  });
  return { stream, dispose() { signal.removeEventListener('abort', abort); stop(); } };
}

/** Compress JSON as a stream or pass an existing gzip archive through unchanged. */
export async function prepareSharedJsonUpload(file: File, options: SharedJsonPreparationOptions = {}): Promise<Blob> {
  validateSharedJsonFile(file);
  if (/\.json\.gz$/i.test(file.name)) return prepareExistingSharedGzip(file, options);
  if (typeof CompressionStream === 'undefined' || typeof file.stream !== 'function') {
    throw new Error('Этот браузер не поддерживает безопасную загрузку большого JSON. Откройте страницу в актуальной версии Chrome, Firefox или Safari.');
  }
  let streamFailure: { error: unknown } | undefined;
  const rememberFailure = (error: unknown) => { streamFailure ??= { error }; };
  let sourceBytes = 0;
  let previousPercent = -1;
  const sourceProgress = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      try {
        sourceBytes += chunk.byteLength;
        if (sourceBytes > MAX_SHARED_JSON_BYTES) throw new Error(`JSON превышает ${MAX_SHARED_JSON_BYTES / (1024 * 1024)} МиБ. Файл не отправлен; действующие данные не изменены.`);
        const percent = Math.min(100, Math.floor(sourceBytes * 100 / file.size));
        if (percent !== previousPercent) { previousPercent = percent; options.onProgress?.(percent); }
        controller.enqueue(chunk);
      } catch (error) { rememberFailure(error); throw error; }
    },
  });
  let compressedBytes = 0;
  const bounded = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      compressedBytes += chunk.byteLength;
      if (compressedBytes > MAX_SHARED_JSON_GZIP_BYTES) {
        const error = new Error(`После сжатия JSON превышает ${MAX_SHARED_JSON_GZIP_BYTES / (1024 * 1024)} МиБ. Файл не отправлен; действующие данные не изменены.`);
        rememberFailure(error);
        throw error;
      }
      controller.enqueue(chunk);
    },
  });
  try {
    return await runWithRequestTimeout(async (signal) => {
      const source = openSharedJsonSource(file, signal, rememberFailure);
      try {
        const compressed = source.stream.pipeThrough(sourceProgress, { signal }).pipeThrough(new CompressionStream('gzip'), { signal }).pipeThrough(bounded, { signal });
        return await new Response(compressed, { headers: { 'Content-Type': 'application/gzip' } }).blob();
      } catch (error) {
        // Chromium can replace a rejected body stream with "Failed to fetch".
        // Retain our specific limit/read failure for the inline upload message.
        throw streamFailure ? streamFailure.error : error;
      } finally {
        // Also stop directly on consumer/compression errors, even when a pipe
        // drops cancellation (reproduced with native gzip on Node 24.21).
        source.dispose();
      }
    }, { signal: options.signal, timeoutMs: options.timeoutMs ?? ADMIN_UPLOAD_TIMEOUT_MS, mutation: false });
  } catch (error) {
    return preparationError(error);
  }
}
