import { Readable } from 'node:stream';

import {
  assertSupportSharedJsonUploadTarget, getSupportSharedDashboardJsonSnapshot, importSupportSharedDashboardJson,
} from '@/shared/lib/db/supportSharedDashboardRepo';
import { PersonalDashboardError } from '@/shared/lib/managerDashboardDomain';
import { PERSONAL_PRIVATE_HEADERS, parsePersonalDashboardId } from '@/shared/lib/managerDashboardSecurity';
import { prepareSupportSharedRoutePlannerUpload, SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES } from '@/shared/lib/supportSharedRoutePlannerData';
import { deleteTopDashboardDataFiles, type PendingTopDashboardDataFile } from '@/shared/lib/topDashboardDataStorage';
import { acquireDistributedTopDashboardDataUploadSlot } from '@/shared/lib/topDashboardUploadConcurrency';
import { personalApiError, personalJson } from '../../_shared';
import { requireSharedAccess, sharedQuery } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requireSharedAccess();
    if (access.denied) return access.denied;
    if (access.mode !== 'view') return personalJson({error: 'JSON доступен только в кабинете сопровождения'}, 403);
    const query = sharedQuery(request, ['version', 'snapshot']);
    const version = parsePersonalDashboardId(query?.get('version') ?? null);
    const id = parsePersonalDashboardId(query?.get('snapshot') ?? null);
    if (!query || !version || (query.has('snapshot') && !id)) return personalJson({error: 'Некорректные параметры JSON'}, 400);
    const snapshot = await getSupportSharedDashboardJsonSnapshot(access.manager!.id, version, id ?? undefined);
    if (!snapshot) return personalJson({error: 'JSON не найден или недоступен'}, 404);
    return new Response(Readable.toWeb(snapshot.stream) as ReadableStream<Uint8Array>, {headers: {
      ...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(snapshot.fileSize), 'Content-Disposition': 'attachment; filename="support-route-planner.json"',
      'X-KTS-Shared-Version': String(snapshot.htmlVersionId), 'X-KTS-Shared-Snapshot': String(snapshot.id),
      'X-KTS-Shared-Filename': encodeURIComponent(snapshot.originalName), 'X-KTS-Shared-Sha256': snapshot.sha256,
      'X-Accel-Buffering': 'no', 'Referrer-Policy': 'no-referrer',
    }});
  } catch (error) { return personalApiError(error); }
}

export async function POST(request: Request) {
  let releaseSlot: (() => Promise<void>) | null = null;
  let pending: PendingTopDashboardDataFile | undefined;
  let databaseAttempted = false;
  try {
    const access = await requireSharedAccess(request, true);
    if (access.denied) return access.denied;
    if (!sharedQuery(request, [])) return personalJson({error: 'Некорректные параметры'}, 400);
    const htmlVersionId = parsePersonalDashboardId(request.headers.get('x-kts-shared-version'));
    const expected = request.headers.get('x-kts-shared-expected-snapshot');
    const expectedId = parsePersonalDashboardId(expected);
    let filename: string;
    try { filename = decodeURIComponent(request.headers.get('x-kts-shared-filename') ?? ''); }
    catch { return personalJson({error: 'Некорректное имя JSON'}, 400); }
    if (!htmlVersionId || !(expected === 'null' || expectedId) || request.headers.get('x-kts-shared-confirm') !== 'true'
      || filename.length > 255 || !/^[^/\\\u0000-\u001f\u007f]+\.json$/i.test(filename)
      || request.headers.get('content-type')?.trim().toLowerCase() !== 'application/gzip'
      || request.headers.has('content-encoding')) {
      return personalJson({error: 'Нужен сжатый JSON, версия HTML и подтверждение публикации всей группе'}, 400);
    }
    const length = request.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES)) {
      return personalJson({error: 'Сжатый файл должен быть не больше 16 МиБ'}, 413);
    }
    await assertSupportSharedJsonUploadTarget(htmlVersionId, expectedId);
    releaseSlot = await acquireDistributedTopDashboardDataUploadSlot();
    if (!releaseSlot) return personalJson({error: 'Уже выполняется загрузка данных; повторите после её завершения'}, 409);
    const prepared = await prepareSupportSharedRoutePlannerUpload(request);
    pending = prepared.pending;
    const storagePath = await pending.commit();
    databaseAttempted = true;
    const result = await importSupportSharedDashboardJson({htmlVersionId, expectedActiveSnapshotId: expectedId,
      originalName: filename, savedAt: prepared.savedAt, fileSize: pending.fileSize, sha256: pending.sha256, storagePath, actorId: access.actorId});
    if (result.status === 'imported') pending.preserve();
    // Duplicate content keeps its existing file. The unused incoming file is discarded below.
    await deleteTopDashboardDataFiles(result.prunedStoragePaths).catch(() => { console.error('Shared route planner file cleanup failed'); });
    return personalJson({status: result.status, snapshot: result.snapshot,
      message: result.status === 'duplicate' ? 'Этот JSON уже загружен.' : 'JSON опубликован для всех менеджеров по сопровождению.'}, result.status === 'imported' ? 201 : 200);
  } catch (error) {
    // A connection failure around COMMIT has an unknown outcome. Preserve the private file for recovery,
    // rather than risking a successfully committed database reference pointing to deleted bytes.
    if (databaseAttempted && !(error instanceof PersonalDashboardError)) pending?.preserve();
    return personalApiError(error);
  } finally {
    await pending?.discard().catch(() => { console.error('Shared route planner temporary cleanup failed'); });
    await releaseSlot?.().catch(() => { console.error('Shared route planner upload lock release failed'); });
  }
}
