import { AdminRequestError, ADMIN_UPLOAD_TIMEOUT_MS, runWithRequestTimeout } from '@/features/admin/shared/adminRequest';
import { SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES, SUPPORT_SHARED_JSON_MAX_BYTES } from '@/shared/lib/supportSharedRoutePlannerLimits';

export const MAX_SHARED_JSON_BYTES = SUPPORT_SHARED_JSON_MAX_BYTES;
export const MAX_SHARED_JSON_GZIP_BYTES = SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES;

export function validateSharedJsonFile(file: Pick<File, 'name' | 'size'>) {
  if (!/\.json$/i.test(file.name) || file.size === 0) {
    throw new Error('Выберите непустой JSON-снимок компоновщика (.json).');
  }
  if (file.size > MAX_SHARED_JSON_BYTES) {
    const size = (file.size / (1024 * 1024)).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
    throw new Error(`Размер файла — ${size} МиБ (${file.size.toLocaleString('ru-RU')} байт). Допустимо до ${MAX_SHARED_JSON_BYTES / (1024 * 1024)} МиБ. Файл не отправлен; действующие данные не изменены.`);
  }
}

/** Compress the file as a stream; never read the large JSON into a JS string. */
export async function prepareSharedJsonUpload(file: File, options: { signal?: AbortSignal; timeoutMs?: number; onProgress?: (percent: number) => void } = {}): Promise<Blob> {
  validateSharedJsonFile(file);
  if (typeof CompressionStream === 'undefined' || typeof file.stream !== 'function') {
    throw new Error('Этот браузер не поддерживает безопасную загрузку большого JSON. Откройте страницу в актуальной версии Chrome, Firefox или Safari.');
  }
  let sourceBytes = 0;
  let previousPercent = -1;
  const sourceProgress = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      sourceBytes += chunk.byteLength;
      if (sourceBytes > MAX_SHARED_JSON_BYTES) throw new Error(`JSON превышает ${MAX_SHARED_JSON_BYTES / (1024 * 1024)} МиБ. Файл не отправлен; действующие данные не изменены.`);
      const percent = Math.min(100, Math.floor(sourceBytes * 100 / file.size));
      if (percent !== previousPercent) { previousPercent = percent; options.onProgress?.(percent); }
      controller.enqueue(chunk);
    },
  });
  let compressedBytes = 0;
  const bounded = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      compressedBytes += chunk.byteLength;
      if (compressedBytes > MAX_SHARED_JSON_GZIP_BYTES) {
        throw new Error(`После сжатия JSON превышает ${MAX_SHARED_JSON_GZIP_BYTES / (1024 * 1024)} МиБ. Файл не отправлен; действующие данные не изменены.`);
      }
      controller.enqueue(chunk);
    },
  });
  try {
    return await runWithRequestTimeout(async (signal) => {
      const compressed = file.stream().pipeThrough(sourceProgress, { signal }).pipeThrough(new CompressionStream('gzip'), { signal }).pipeThrough(bounded, { signal });
      return new Response(compressed, { headers: { 'Content-Type': 'application/gzip' } }).blob();
    }, { signal: options.signal, timeoutMs: options.timeoutMs ?? ADMIN_UPLOAD_TIMEOUT_MS, mutation: false });
  } catch (error) {
    if (error instanceof AdminRequestError) throw new Error(error.code === 'cancelled'
      ? 'Подготовка JSON прервана. Файл не отправлен.'
      : 'Подготовка JSON заняла слишком много времени. Файл не отправлен. Попробуйте подготовить его заново.');
    throw error;
  }
}
