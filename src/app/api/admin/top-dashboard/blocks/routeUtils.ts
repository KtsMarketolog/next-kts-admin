import { createHash } from 'crypto';
import { TOP_DASHBOARD_HTML_MAX_BYTES, TOP_DASHBOARD_HTML_MAX_MEGABYTES } from '@/shared/lib/topDashboardLimits';
import { isProfitabilityHtmlCandidate, isSupportedProfitabilityHtml } from '@/shared/lib/dashboardProfitabilityHtml';

const MAX_TOP_DASHBOARD_BYTES = TOP_DASHBOARD_HTML_MAX_BYTES;
const HTML_LIMIT_MESSAGE = `HTML-файл должен быть не больше ${TOP_DASHBOARD_HTML_MAX_MEGABYTES} МБ`;
const MAX_MULTIPART_OVERHEAD_BYTES = 256 * 1024;
const HTML_DOCUMENT_MARKER = /(?:<!doctype\s+html(?:\s|>)|<html(?:\s|>))/i;

export function parsePositiveId(value: string) {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export function errorResponse(error: string, status = 400) {
  return Response.json({ error }, { status });
}

function normalizeOriginalName(value: string) {
  return value
    .replace(/[\\/:*?"<>|\r\n\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220) || 'dashboard.html';
}

function contentLengthTooLarge(request: Request) {
  const value = request.headers.get('content-length');
  if (!value) return false;
  const length = Number(value);
  return Number.isFinite(length) && length > MAX_TOP_DASHBOARD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES;
}

type UploadedHtml = {
  originalName: string;
  htmlContent: string;
  fileSize: number;
  sha256: string;
};

export async function readTopDashboardHtmlUpload(
  request: Request,
): Promise<{ upload: UploadedHtml; error?: never } | { upload?: never; error: Response }> {
  if (contentLengthTooLarge(request)) {
    return { error: errorResponse(HTML_LIMIT_MESSAGE, 413) };
  }

  // Content-Length is optional and cannot be trusted to bound a multipart body.
  if (!request.body) return { error: errorResponse('Выберите HTML-файл') };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('upload-timeout')), 60_000); });
  let formData: FormData;
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_TOP_DASHBOARD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES || chunks.length >= 65536) {
        return { error: errorResponse(HTML_LIMIT_MESSAGE, 413) };
      }
      chunks.push(part.value);
    }
    formData = await new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers.get('content-type') || '' } }).formData();
  } catch { return { error: errorResponse('Не удалось прочитать HTML-файл. Повторите загрузку') }; }
  finally { clearTimeout(timeout); void reader.cancel().catch(() => {}); reader.releaseLock(); }
  const file = formData.get('file');
  if (!(file instanceof File)) return { error: errorResponse('Выберите HTML-файл') };
  if (file.size <= 0) return { error: errorResponse('HTML-файл пустой') };
  if (file.size > MAX_TOP_DASHBOARD_BYTES) {
    return { error: errorResponse(HTML_LIMIT_MESSAGE, 413) };
  }
  if (!/\.html?$/i.test(file.name)) {
    return { error: errorResponse('Загрузите файл с расширением .html или .htm') };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length <= 0) return { error: errorResponse('HTML-файл пустой') };
  if (bytes.length > MAX_TOP_DASHBOARD_BYTES) {
    return { error: errorResponse(HTML_LIMIT_MESSAGE, 413) };
  }
  if (bytes.includes(0)) {
    return { error: errorResponse('HTML-файл содержит недопустимые нулевые байты') };
  }

  let htmlContent = '';
  try {
    htmlContent = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { error: errorResponse('HTML-файл должен быть сохранен в кодировке UTF-8') };
  }
  if (!HTML_DOCUMENT_MARKER.test(htmlContent)) {
    return { error: errorResponse('В файле не найден полноценный HTML-документ') };
  }
  if (isProfitabilityHtmlCandidate(htmlContent) && !isSupportedProfitabilityHtml(htmlContent)) {
    return { error: errorResponse('Для этой версии «Рентабельности счетов» ещё не подключён журнал детализации. Нужна адаптация авторского HTML; выгруженную из сайта копию используйте только локально.') };
  }

  return {
    upload: {
      originalName: normalizeOriginalName(file.name),
      htmlContent,
      fileSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}
