import { createHash } from 'crypto';

import type {
  TopDashboardProfile,
  TopDashboardSnapshotFormat,
} from '@/shared/lib/db';
import {
  TOP_DASHBOARD_DATA_MAX_BYTES,
  TOP_DASHBOARD_DATA_MAX_MEGABYTES,
  TOP_DASHBOARD_DATA_MULTIPART_OVERHEAD_BYTES,
} from '@/shared/lib/topDashboardLimits';
import { validateTopDashboardMultiFileSnapshot } from '@/shared/lib/topDashboardMultiFileSnapshot';

import { parsePositiveId } from './routeUtils';

export const TOP_DASHBOARD_MULTI_FILE_UPLOAD_HEADER = 'x-kts-top-dashboard-multi-file';

export type TopDashboardMultiFileDataUpload = {
  expectedActiveVersionId: number | null;
  expectedActiveHtmlVersionId: number;
  upload: {
    originalName: string;
    content: Buffer;
    fileSize: number;
    uncompressedSize: number;
    sha256: string;
    snapshotFormat: Extract<TopDashboardSnapshotFormat, 'multi-file-v1'>;
    dashboardProfile: Extract<TopDashboardProfile, 'generic'>;
    boundHtmlVersionId: number;
  };
};

type UploadResult =
  | { parsed: TopDashboardMultiFileDataUpload; error?: never }
  | { parsed?: never; error: Response };

function errorResponse(error: string, status = 400) {
  return Response.json(
    { error },
    {
      status,
      headers: {
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
      },
    },
  );
}

function contentLengthTooLarge(request: Request) {
  const value = request.headers.get('content-length');
  if (!value) return false;
  const length = Number(value);
  return Number.isFinite(length)
    && length > TOP_DASHBOARD_DATA_MAX_BYTES + TOP_DASHBOARD_DATA_MULTIPART_OVERHEAD_BYTES;
}

function parseNullableVersion(value: FormDataEntryValue | null) {
  if (value === null || value === '') return { value: null as number | null };
  if (typeof value !== 'string') return { error: 'Некорректная активная версия данных' };
  const id = parsePositiveId(value);
  return id
    ? { value: id as number | null }
    : { error: 'Некорректная активная версия данных' };
}

function parseRequiredVersion(value: FormDataEntryValue | null) {
  if (typeof value !== 'string') return null;
  return parsePositiveId(value);
}

export function isTopDashboardMultiFileUpload(request: Request) {
  return request.headers.get(TOP_DASHBOARD_MULTI_FILE_UPLOAD_HEADER) === '1';
}

/**
 * Reads the opaque multi-file envelope created by the trusted frame. The
 * embedded dashboard never talks to this endpoint directly. Individual files
 * remain byte-for-byte unchanged and are deliberately not parsed or unzipped.
 */
export async function readTopDashboardMultiFileDataUpload(
  request: Request,
): Promise<UploadResult> {
  if (contentLengthTooLarge(request)) {
    return {
      error: errorResponse(
        `Общий размер выбранных файлов должен быть не больше ${TOP_DASHBOARD_DATA_MAX_MEGABYTES} МБ`,
        413,
      ),
    };
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return { error: errorResponse('Не удалось прочитать выбранные файлы') };
  }

  const expectedActive = parseNullableVersion(formData.get('expectedActiveVersionId'));
  if (typeof expectedActive.error === 'string') {
    return { error: errorResponse(expectedActive.error) };
  }

  const expectedActiveHtmlVersionId = parseRequiredVersion(
    formData.get('expectedActiveHtmlVersionId'),
  );
  if (!expectedActiveHtmlVersionId) {
    return { error: errorResponse('Некорректная активная версия HTML') };
  }

  const file = formData.get('file');
  if (!(file instanceof File)) return { error: errorResponse('Выберите файлы данных') };
  if (file.size <= 0) return { error: errorResponse('Набор файлов пустой') };
  if (file.size > TOP_DASHBOARD_DATA_MAX_BYTES) {
    return {
      error: errorResponse(
        `Общий размер выбранных файлов должен быть не больше ${TOP_DASHBOARD_DATA_MAX_MEGABYTES} МБ`,
        413,
      ),
    };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length !== file.size || bytes.length <= 0) {
    return { error: errorResponse('Набор файлов повреждён') };
  }
  const validation = validateTopDashboardMultiFileSnapshot(bytes);
  if (!validation.ok) {
    return { error: errorResponse(`Набор файлов повреждён: ${validation.error}`) };
  }

  return {
    parsed: {
      expectedActiveVersionId: expectedActive.value,
      expectedActiveHtmlVersionId,
      upload: {
        originalName: 'dashboard-files.ktsmf',
        content: bytes,
        fileSize: bytes.length,
        uncompressedSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        snapshotFormat: 'multi-file-v1',
        dashboardProfile: 'generic',
        boundHtmlVersionId: expectedActiveHtmlVersionId,
      },
    },
  };
}
