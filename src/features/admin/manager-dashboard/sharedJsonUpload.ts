import { AdminRequestError, ADMIN_UPLOAD_TIMEOUT_MS, runWithRequestTimeout } from '@/features/admin/shared/adminRequest';

export const MAX_SHARED_JSON_BYTES = 100 * 1024 * 1024;
export const MAX_SHARED_JSON_GZIP_BYTES = 16 * 1024 * 1024;

/** Compress the file as a stream; never read the large JSON into a JS string. */
export async function prepareSharedJsonUpload(file: File, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<Blob> {
  if (!/\.json$/i.test(file.name) || file.size === 0 || file.size > MAX_SHARED_JSON_BYTES) {
    throw new Error('Выберите непустой JSON-снимок компоновщика размером до 100 МБ.');
  }
  if (typeof CompressionStream === 'undefined' || typeof file.stream !== 'function') {
    throw new Error('Этот браузер не поддерживает безопасную загрузку большого JSON. Откройте страницу в актуальной версии Chrome, Firefox или Safari.');
  }
  let compressedBytes = 0;
  const bounded = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      compressedBytes += chunk.byteLength;
      if (compressedBytes > MAX_SHARED_JSON_GZIP_BYTES) {
        throw new Error('После сжатия JSON превышает 16 МБ. Подготовьте меньший снимок компоновщика. Текущий файл не изменён.');
      }
      controller.enqueue(chunk);
    },
  });
  try {
    return await runWithRequestTimeout(async (signal) => {
      const compressed = file.stream().pipeThrough(new CompressionStream('gzip'), { signal }).pipeThrough(bounded, { signal });
      return new Response(compressed, { headers: { 'Content-Type': 'application/gzip' } }).blob();
    }, { signal: options.signal, timeoutMs: options.timeoutMs ?? ADMIN_UPLOAD_TIMEOUT_MS, mutation: false });
  } catch (error) {
    if (error instanceof AdminRequestError) throw new Error(error.code === 'cancelled'
      ? 'Подготовка JSON прервана. Файл не отправлен.'
      : 'Подготовка JSON заняла слишком много времени. Файл не отправлен. Попробуйте подготовить его заново.');
    throw error;
  }
}
