import { Readable } from 'node:stream';

import {
  getTopDashboardActor,
  isTopDashboardManagementSession,
  requireTopDashboardManagementSession,
  requireTopDashboardSession,
} from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import {
  createAndActivateTopDashboardBlockDataVersion,
  getActiveTopDashboardBlockDataContent,
  getPublishedTopDashboardBlockOverview,
  getTopDashboardBlockOverview,
  getTopDashboardBlockVersionContent,
  TopDashboardActiveHtmlRequiredError,
  TopDashboardBlockDataStateConflictError,
  TopDashboardBlockNotFoundError,
  TopDashboardDataCompatibilityError,
  TopDashboardStateConflictError,
} from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';
import {
  deleteTopDashboardDataFiles,
  openTopDashboardDataFile,
  type PendingTopDashboardDataFile,
} from '@/shared/lib/topDashboardDataStorage';
import {
  detectTopDashboardDataContract,
  getTopDashboardBlockDataFrameVersionId,
  isTopDashboardBlockDataMutationFrameRequest,
} from '@/shared/lib/topDashboardContentSecurity';
import { acquireDistributedTopDashboardDataUploadSlot } from '@/shared/lib/topDashboardUploadConcurrency';

import {
  readTopDashboardDataStreamUpload,
  readTopDashboardDataUpload,
} from '../../dataUpload';
import {
  isTopDashboardDirectSingleFileUpload,
  isTopDashboardDirectSingleFileUploadPayload,
  isTopDashboardMultiFileUpload,
  readTopDashboardMultiFileDataStreamUpload,
  readTopDashboardMultiFileDataUpload,
} from '../../multiFileDataUpload';
import { parsePositiveId } from '../../routeUtils';
import { isTopDashboardStreamUpload } from '../../streamDataUpload';

export const runtime = 'nodejs';

type Context = {
  params: Promise<{ blockId: string }>;
};

function dataContentType(originalName: string, snapshotFormat: string) {
  if (snapshotFormat === 'multi-file-v1') return 'application/octet-stream';
  return /\.gz$/i.test(originalName) ? 'application/gzip' : 'application/json; charset=utf-8';
}

function fallbackDownloadName(originalName: string, snapshotFormat: string) {
  if (snapshotFormat === 'multi-file-v1') return 'dashboard-files.ktsmf';
  return /\.gz$/i.test(originalName) ? 'dashboard-data.json.gz' : 'dashboard-data.json';
}

export async function GET(request: Request, context: Context) {
  const { denied, session } = await requireTopDashboardSession();
  if (denied) return denied;

  const { blockId: rawBlockId } = await context.params;
  const blockId = parsePositiveId(rawBlockId);
  if (!blockId) return Response.json({ error: 'Некорректный блок' }, { status: 400 });
  const frameVersionId = getTopDashboardBlockDataFrameVersionId(request, blockId);
  if (!frameVersionId) {
    return Response.json(
      { error: 'Данные доступны только в защищённом просмотре' },
      { status: 403 },
    );
  }

  try {
    if (!isTopDashboardManagementSession(session)) {
      const publishedBlock = await getPublishedTopDashboardBlockOverview(blockId);
      if (!publishedBlock || publishedBlock.activeVersionId !== frameVersionId) {
        return Response.json({ error: 'Данные дашборда не найдены' }, { status: 404 });
      }
    }

    const snapshot = await getActiveTopDashboardBlockDataContent(blockId, frameVersionId);
    if (!snapshot) return Response.json({ error: 'Данные ещё не загружены' }, { status: 404 });

    const encodedOriginalName = encodeURIComponent(snapshot.originalName);
    const source = snapshot.storagePath
      ? await openTopDashboardDataFile(snapshot.storagePath, snapshot.fileSize)
      : snapshot.content
        ? Readable.from([snapshot.content])
        : null;
    if (!source) throw new Error('TOP dashboard data payload is unavailable');
    const body = Readable.toWeb(source) as ReadableStream<Uint8Array>;

    return new Response(body, {
      headers: {
        'Content-Type': dataContentType(snapshot.originalName, snapshot.snapshotFormat),
        'Content-Length': String(snapshot.fileSize),
        'Content-Disposition': `inline; filename="${fallbackDownloadName(snapshot.originalName, snapshot.snapshotFormat)}"; filename*=UTF-8''${encodedOriginalName}`,
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        'X-Top-Dashboard-Data-Version-Id': String(snapshot.id),
        'X-Top-Dashboard-Data-Original-Name': encodedOriginalName,
        'X-Top-Dashboard-Data-Sha256': snapshot.sha256,
        'X-Top-Dashboard-Data-Snapshot-Format': snapshot.snapshotFormat,
        ...(snapshot.dashboardProfile
          ? { 'X-Top-Dashboard-Data-Profile': snapshot.dashboardProfile }
          : {}),
        ...(snapshot.boundHtmlVersionId
          ? {
              'X-Top-Dashboard-Data-Bound-Html-Version-Id': String(
                snapshot.boundHtmlVersionId,
              ),
            }
          : {}),
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'X-DNS-Prefetch-Control': 'off',
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    if (error instanceof TopDashboardBlockNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error('Failed to read TOP dashboard data', error);
    return Response.json({ error: 'Не удалось открыть данные дашборда' }, { status: 500 });
  }
}

export async function PUT(request: Request, context: Context) {
  const { denied, session } = await requireTopDashboardManagementSession();
  if (denied) return denied;

  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const multiFileUpload = isTopDashboardMultiFileUpload(request);
  const directSingleFileUpload = isTopDashboardDirectSingleFileUpload(request);
  const streamUpload = isTopDashboardStreamUpload(request);
  if (directSingleFileUpload && (!multiFileUpload || !streamUpload)) {
    return Response.json(
      { error: 'Некорректный режим прямой загрузки файла' },
      { status: 400 },
    );
  }
  const limited = await enforceAdminActionRateLimit(
    session,
    multiFileUpload ? 'top_dashboard_multi_file_upload' : 'top_dashboard_data_upload',
    multiFileUpload ? 30 : 10,
    30 * 60 * 1000,
  );
  if (limited) return limited;

  const { blockId: rawBlockId } = await context.params;
  const blockId = parsePositiveId(rawBlockId);
  if (!blockId) return Response.json({ error: 'Некорректный блок' }, { status: 400 });

  const releaseUploadSlot = await acquireDistributedTopDashboardDataUploadSlot();
  if (!releaseUploadSlot) {
    return Response.json(
      { error: 'Уже выполняется другая загрузка данных. Дождитесь её завершения и повторите.' },
      {
        status: 409,
        headers: {
          'Cache-Control': 'private, no-store',
          'Retry-After': '5',
          'X-Robots-Tag': 'noindex, nofollow, noarchive',
        },
      },
    );
  }

  let pendingFile: PendingTopDashboardDataFile | undefined;
  try {
    const overview = await getTopDashboardBlockOverview(blockId);
    const expectedActiveHtmlVersionId = overview.activeVersionId;
    if (!expectedActiveHtmlVersionId) {
      return Response.json(
        { error: 'Сначала опубликуйте HTML-страницу, затем загрузите данные' },
        { status: 422 },
      );
    }
    const activeHtml = await getTopDashboardBlockVersionContent(
      blockId,
      expectedActiveHtmlVersionId,
    );
    if (!activeHtml) {
      return Response.json(
        { error: 'Активная HTML-страница уже изменилась. Обновите страницу и повторите.' },
        { status: 409 },
      );
    }
    const contract = detectTopDashboardDataContract(activeHtml.htmlContent);
    const expectedHtmlSnapshotFormat = contract.snapshotFormat;
    const expectedHtmlProfile = contract.profile;
    if (contract.mode === 'disabled' || !expectedHtmlSnapshotFormat || !expectedHtmlProfile) {
      return Response.json(
        { error: 'Для опубликованной HTML-страницы не удалось определить подходящий тип данных' },
        { status: 422 },
      );
    }

    if (multiFileUpload && contract.mode !== 'generic') {
      return Response.json(
        { error: 'Для этого HTML используется проверенный снимок данных, а не универсальные файлы' },
        { status: 422 },
      );
    }
    if (!multiFileUpload && contract.mode !== 'legacy') {
      return Response.json(
        { error: 'Для этого HTML используйте универсальную загрузку файла' },
        { status: 422 },
      );
    }
    if (directSingleFileUpload && !contract.directUploadTarget) {
      return Response.json(
        {
          error: 'Верхняя загрузка недоступна для структуры этого HTML. Выберите файлы внутри предпросмотра.',
        },
        { status: 422 },
      );
    }

    const parsed = multiFileUpload
      ? streamUpload
        ? await readTopDashboardMultiFileDataStreamUpload(request)
        : await readTopDashboardMultiFileDataUpload(request)
      : streamUpload
        ? await readTopDashboardDataStreamUpload(request)
        : await readTopDashboardDataUpload(request);
    if (parsed.error) return parsed.error;
    pendingFile = parsed.parsed.upload.pendingFile;

    if (multiFileUpload) {
      if (
        !('expectedActiveHtmlVersionId' in parsed.parsed)
        || parsed.parsed.expectedActiveHtmlVersionId !== expectedActiveHtmlVersionId
      ) {
        return Response.json(
          { error: 'Активная HTML-страница уже изменилась. Обновите страницу и повторите.' },
          { status: 409 },
        );
      }
      if (
        directSingleFileUpload
        && !isTopDashboardDirectSingleFileUploadPayload(
          parsed.parsed,
          contract.directUploadTarget,
        )
      ) {
        return Response.json(
          { error: 'Прямая универсальная загрузка содержит неверное поле или количество файлов' },
          { status: 400 },
        );
      }
      if (
        !directSingleFileUpload
        && !isTopDashboardBlockDataMutationFrameRequest(
          request,
          blockId,
          expectedActiveHtmlVersionId,
        )
      ) {
        return Response.json(
          { error: 'Активная HTML-страница уже изменилась. Обновите страницу и повторите.' },
          { status: 409 },
        );
      }
    }
    if (
      expectedHtmlSnapshotFormat !== parsed.parsed.upload.snapshotFormat
      || expectedHtmlProfile !== parsed.parsed.upload.dashboardProfile
    ) {
      return Response.json(
        { error: 'Этот файл данных не подходит для опубликованной HTML-страницы' },
        { status: 422 },
      );
    }

    if (pendingFile) {
      parsed.parsed.upload.storagePath = await pendingFile.commit();
    }
    const persistedUpload = { ...parsed.parsed.upload };
    delete persistedUpload.pendingFile;
    const actor = getTopDashboardActor(session);
    const result = await createAndActivateTopDashboardBlockDataVersion({
      blockId,
      expectedActiveVersionId: parsed.parsed.expectedActiveVersionId,
      expectedActiveHtmlVersionId,
      expectedHtmlSnapshotFormat,
      expectedHtmlProfile,
      ...persistedUpload,
      dashboardProfile: expectedHtmlProfile,
      boundHtmlVersionId: multiFileUpload ? expectedActiveHtmlVersionId : null,
      uploadedByAdminUserId: actor.adminUserId,
      uploadedByManagerId: actor.managerId,
    });
    pendingFile?.preserve();
    if (result.prunedStoragePaths.length > 0) {
      await deleteTopDashboardDataFiles(result.prunedStoragePaths).catch((error) => {
        console.error('Failed to remove pruned TOP dashboard data files', error);
      });
    }

    await recordSecurityEvent({
      eventType: 'top_dashboard_data_uploaded',
      ...actor,
      sessionId: session.sessionId,
      entityType: 'top_dashboard_block_data_version',
      entityId: `${blockId}:${result.version.id}`,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        blockId,
        versionId: result.version.id,
        previousVersionId: result.previousVersionId,
        originalName: result.version.originalName,
        fileSize: result.version.fileSize,
        uncompressedSize: result.version.uncompressedSize,
        sha256: result.version.sha256,
        snapshotFormat: result.version.snapshotFormat,
        dashboardProfile: result.version.dashboardProfile,
        boundHtmlVersionId: result.version.boundHtmlVersionId,
        prunedVersionIds: result.prunedVersionIds,
      },
    });

    return Response.json(
      {
        version: result.version,
        state: {
          activeVersionId: result.activeVersionId,
          previousVersionId: result.previousVersionId,
          updatedAt: result.updatedAt,
        },
      },
      {
        status: 201,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    );
  } catch (error) {
    if (error instanceof TopDashboardStateConflictError) {
      return Response.json(
        {
          error: 'Активная HTML-страница уже изменилась. Обновите страницу и повторите.',
          currentActiveHtmlVersionId: error.currentActiveVersionId,
        },
        { status: 409 },
      );
    }
    if (error instanceof TopDashboardBlockDataStateConflictError) {
      return Response.json(
        {
          error: error.message,
          currentActiveVersionId: error.currentActiveVersionId,
        },
        { status: 409 },
      );
    }
    if (error instanceof TopDashboardBlockNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (
      error instanceof TopDashboardActiveHtmlRequiredError
      || error instanceof TopDashboardDataCompatibilityError
    ) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    console.error('Failed to upload TOP dashboard data', error);
    return Response.json({ error: 'Не удалось сохранить данные дашборда' }, { status: 500 });
  } finally {
    await pendingFile?.discard().catch((error) => {
      console.error('Failed to discard temporary TOP dashboard data file', error);
    });
    await releaseUploadSlot();
  }
}
