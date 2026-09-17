import { createHash } from 'crypto';

import type {
  TopDashboardProfile,
  TopDashboardSnapshotFormat,
} from '@/shared/lib/db';
import {
  TOP_DASHBOARD_DATA_MULTIPART_MAX_BYTES,
  TOP_DASHBOARD_DATA_MULTIPART_MAX_MEGABYTES,
  TOP_DASHBOARD_DATA_MULTIPART_OVERHEAD_BYTES,
  TOP_DASHBOARD_DATA_STORED_MAX_BYTES,
} from '@/shared/lib/topDashboardLimits';
import type { PendingTopDashboardDataFile } from '@/shared/lib/topDashboardDataStorage';
import {
  inspectTopDashboardMultiFileSnapshot,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS,
  type TopDashboardMultiFileSnapshotTarget,
  type TopDashboardMultiFileSnapshotTargetSummary,
} from '@/shared/lib/topDashboardMultiFileSnapshot';
import type { TopDashboardUploadTarget } from '@/shared/lib/topDashboardUploadTargets';
import { inspectTopDashboardMultiFileSnapshotFile } from '@/shared/lib/topDashboardMultiFileSnapshotFile';

import { parsePositiveId } from './routeUtils';
import {
  readStreamExpectedActiveVersionId,
  readStreamExpectedHtmlVersionId,
  receiveTopDashboardDataStream,
} from './streamDataUpload';

export const TOP_DASHBOARD_MULTI_FILE_UPLOAD_HEADER = 'x-kts-top-dashboard-multi-file';
export const TOP_DASHBOARD_DIRECT_SINGLE_FILE_UPLOAD_HEADER =
  'x-kts-top-dashboard-direct-single-file';
export const TOP_DASHBOARD_DIRECT_FILES_UPLOAD_HEADER = 'x-kts-top-dashboard-direct-files';

export type TopDashboardMultiFileDataUpload = {
  expectedActiveVersionId: number | null;
  expectedActiveHtmlVersionId: number;
  targetCount: number;
  fileCount: number;
  targets: TopDashboardMultiFileSnapshotTargetSummary[];
  upload: {
    originalName: string;
    content: Buffer | null;
    storagePath: string | null;
    pendingFile?: PendingTopDashboardDataFile;
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
    && length > TOP_DASHBOARD_DATA_MULTIPART_MAX_BYTES
      + TOP_DASHBOARD_DATA_MULTIPART_OVERHEAD_BYTES;
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

export function isTopDashboardDirectSingleFileUpload(request: Request) {
  return request.headers.get(TOP_DASHBOARD_DIRECT_SINGLE_FILE_UPLOAD_HEADER) === '1';
}

export function isTopDashboardDirectFilesUpload(request: Request) {
  return request.headers.get(TOP_DASHBOARD_DIRECT_FILES_UPLOAD_HEADER) === '1';
}

export function isTopDashboardDirectFilesUploadPayload(
  upload: Pick<TopDashboardMultiFileDataUpload, 'targetCount' | 'fileCount' | 'targets'>,
  expectedTargets: readonly TopDashboardUploadTarget[],
) {
  if (
    !Number.isInteger(upload.targetCount)
    || upload.targetCount < 1
    || upload.targetCount > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS
    || upload.targetCount !== upload.targets.length
    || !Number.isInteger(upload.fileCount)
    || upload.fileCount < 1
    || upload.fileCount > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES
  ) return false;
  const seen = new Set<number>();
  let fileCount = 0;
  for (const actual of upload.targets) {
    const expected = expectedTargets.find((entry) => entry.target.index === actual.target.index);
    if (
      !expected
      || seen.has(actual.target.index)
      || actual.target.id !== expected.target.id
      || actual.target.name !== expected.target.name
      || !Number.isInteger(actual.fileCount)
      || actual.fileCount < 1
      || actual.fileCount > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET
      || (!expected.multiple && !expected.directory && actual.fileCount !== 1)
    ) return false;
    seen.add(actual.target.index);
    fileCount += actual.fileCount;
  }
  return fileCount === upload.fileCount;
}

export function isTopDashboardDirectSingleFileUploadPayload(
  upload: Pick<TopDashboardMultiFileDataUpload, 'targetCount' | 'fileCount' | 'targets'>,
  expectedTarget: TopDashboardMultiFileSnapshotTarget | null,
) {
  if (
    !expectedTarget
    || upload.targetCount !== 1
    || upload.fileCount !== 1
    || upload.targets.length !== 1
    || upload.targets[0]!.fileCount !== 1
  ) {
    return false;
  }
  const actualTarget = upload.targets[0]!.target;
  return actualTarget.index === expectedTarget.index
    && actualTarget.id === (expectedTarget.id ?? null)
    && actualTarget.name === (expectedTarget.name ?? null);
}

/**
 * Reads the opaque envelope created by the trusted frame or the management
 * page's direct uploader. The embedded dashboard never talks to
 * this endpoint directly. Individual files remain byte-for-byte unchanged and
 * are deliberately not parsed or unzipped.
 */
export async function readTopDashboardMultiFileDataUpload(
  request: Request,
): Promise<UploadResult> {
  if (contentLengthTooLarge(request)) {
    return {
      error: errorResponse(
        `Общий размер выбранных файлов в этом режиме должен быть не больше ${TOP_DASHBOARD_DATA_MULTIPART_MAX_MEGABYTES} МБ`,
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
  if (file.size > TOP_DASHBOARD_DATA_MULTIPART_MAX_BYTES) {
    return {
      error: errorResponse(
        `Общий размер выбранных файлов в этом режиме должен быть не больше ${TOP_DASHBOARD_DATA_MULTIPART_MAX_MEGABYTES} МБ`,
        413,
      ),
    };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length !== file.size || bytes.length <= 0) {
    return { error: errorResponse('Набор файлов повреждён') };
  }
  const validation = inspectTopDashboardMultiFileSnapshot(bytes);
  if (!validation.ok) {
    return { error: errorResponse(`Набор файлов повреждён: ${validation.error}`) };
  }

  return {
    parsed: {
      expectedActiveVersionId: expectedActive.value,
      expectedActiveHtmlVersionId,
      targetCount: validation.targetCount,
      fileCount: validation.fileCount,
      targets: validation.targets,
      upload: {
        originalName: 'dashboard-files.ktsmf',
        content: bytes,
        storagePath: null,
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

export async function readTopDashboardMultiFileDataStreamUpload(
  request: Request,
): Promise<UploadResult> {
  const expectedActive = readStreamExpectedActiveVersionId(request);
  if (typeof expectedActive.error === 'string') {
    return { error: errorResponse(expectedActive.error) };
  }
  const expectedActiveHtmlVersionId = readStreamExpectedHtmlVersionId(request);
  if (!expectedActiveHtmlVersionId) {
    return { error: errorResponse('Некорректная активная версия HTML') };
  }

  const received = await receiveTopDashboardDataStream(
    request,
    'Набор файлов',
    TOP_DASHBOARD_DATA_STORED_MAX_BYTES,
  );
  if (received.error) return { error: received.error };
  const pending = received.pending;
  let validation: Awaited<ReturnType<typeof inspectTopDashboardMultiFileSnapshotFile>>;
  try {
    validation = await inspectTopDashboardMultiFileSnapshotFile(
      pending.temporaryPath,
      pending.fileSize,
    );
  } catch (error) {
    // The route receives ownership only after this parser returns. Clean up an
    // unexpected inspection failure here as well as a malformed envelope.
    await pending.discard().catch((discardError) => {
      console.error('Failed to discard uninspected TOP dashboard data', discardError);
    });
    throw error;
  }
  if (!validation.ok) {
    await pending.discard();
    return { error: errorResponse(`Набор файлов повреждён: ${validation.error}`) };
  }

  return {
    parsed: {
      expectedActiveVersionId: expectedActive.value,
      expectedActiveHtmlVersionId,
      targetCount: validation.targetCount,
      fileCount: validation.fileCount,
      targets: validation.targets,
      upload: {
        originalName: 'dashboard-files.ktsmf',
        content: null,
        storagePath: null,
        pendingFile: pending,
        fileSize: pending.fileSize,
        uncompressedSize: pending.fileSize,
        sha256: pending.sha256,
        snapshotFormat: 'multi-file-v1',
        dashboardProfile: 'generic',
        boundHtmlVersionId: expectedActiveHtmlVersionId,
      },
    },
  };
}
