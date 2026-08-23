import { createHash } from 'crypto';

const MAX_TOP_DASHBOARD_BYTES = 5 * 1024 * 1024;
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
    return { error: errorResponse('HTML-файл должен быть не больше 5 МБ', 413) };
  }

  const formData = await request.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) return { error: errorResponse('Выберите HTML-файл') };
  if (file.size <= 0) return { error: errorResponse('HTML-файл пустой') };
  if (file.size > MAX_TOP_DASHBOARD_BYTES) {
    return { error: errorResponse('HTML-файл должен быть не больше 5 МБ', 413) };
  }
  if (!/\.html?$/i.test(file.name)) {
    return { error: errorResponse('Загрузите файл с расширением .html или .htm') };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length <= 0) return { error: errorResponse('HTML-файл пустой') };
  if (bytes.length > MAX_TOP_DASHBOARD_BYTES) {
    return { error: errorResponse('HTML-файл должен быть не больше 5 МБ', 413) };
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

  return {
    upload: {
      originalName: normalizeOriginalName(file.name),
      htmlContent,
      fileSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
}
