import {
  TopDashboardDataStreamError,
  writeTopDashboardRequestToPendingFile,
} from '@/shared/lib/topDashboardDataStorage';
import {
  TOP_DASHBOARD_DATA_MAX_BYTES,
  TOP_DASHBOARD_DATA_MAX_MEGABYTES,
} from '@/shared/lib/topDashboardLimits';

import { parsePositiveId } from './routeUtils';

export const TOP_DASHBOARD_STREAM_UPLOAD_HEADER = 'x-kts-top-data-protocol';
export const TOP_DASHBOARD_STREAM_UPLOAD_VALUE = 'stream-v1';
export const TOP_DASHBOARD_STREAM_NAME_HEADER = 'x-kts-top-data-name';
export const TOP_DASHBOARD_STREAM_EXPECTED_VERSION_HEADER = 'x-kts-top-data-expected-version';
export const TOP_DASHBOARD_STREAM_HTML_VERSION_HEADER = 'x-kts-top-html-version';

export function isTopDashboardStreamUpload(request: Request) {
  return request.headers.get(TOP_DASHBOARD_STREAM_UPLOAD_HEADER) === TOP_DASHBOARD_STREAM_UPLOAD_VALUE;
}

export function readStreamOriginalName(request: Request) {
  const encoded = request.headers.get(TOP_DASHBOARD_STREAM_NAME_HEADER);
  if (!encoded || encoded.length > 2_048) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function readStreamExpectedActiveVersionId(request: Request) {
  const value = request.headers.get(TOP_DASHBOARD_STREAM_EXPECTED_VERSION_HEADER);
  if (value === 'none') return { value: null as number | null };
  const parsed = value ? parsePositiveId(value) : null;
  return parsed
    ? { value: parsed as number | null }
    : { error: 'Некорректная активная версия данных' };
}

export function readStreamExpectedHtmlVersionId(request: Request) {
  const value = request.headers.get(TOP_DASHBOARD_STREAM_HTML_VERSION_HEADER);
  return value ? parsePositiveId(value) : null;
}

export async function receiveTopDashboardDataStream(
  request: Request,
  sizeLabel: string,
  maxRequestBytes = TOP_DASHBOARD_DATA_MAX_BYTES,
) {
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length <= 0) {
      return { error: Response.json({ error: `${sizeLabel} пустой` }, { status: 400 }) };
    }
    if (length > maxRequestBytes) {
      return {
        error: Response.json(
          { error: `${sizeLabel} должен быть не больше ${TOP_DASHBOARD_DATA_MAX_MEGABYTES} МБ` },
          { status: 413 },
        ),
      };
    }
  }

  try {
    return {
      pending: await writeTopDashboardRequestToPendingFile(
        request,
        maxRequestBytes,
      ),
    };
  } catch (error) {
    if (error instanceof TopDashboardDataStreamError) {
      if (error.code === 'TOO_LARGE') {
        return {
          error: Response.json(
            { error: `${sizeLabel} должен быть не больше ${TOP_DASHBOARD_DATA_MAX_MEGABYTES} МБ` },
            { status: 413 },
          ),
        };
      }
      if (error.code === 'EMPTY') {
        return { error: Response.json({ error: `${sizeLabel} пустой` }, { status: 400 }) };
      }
    }
    console.error('Failed to stream TOP dashboard upload', error);
    return {
      error: Response.json({ error: `Не удалось прочитать ${sizeLabel.toLowerCase()}` }, { status: 500 }),
    };
  }
}
