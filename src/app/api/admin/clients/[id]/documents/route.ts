import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireEmployee } from '@/shared/lib/adminAuth';
import { BoundedMultipartUploadError, readBoundedMultipartUpload } from '@/shared/lib/boundedMultipartUpload';
import { MAX_CLIENT_DOCUMENT_SIZE, saveClientDocumentUpload } from '@/shared/lib/clientDocumentStorage';
import { publishClientRealtimeEvent } from '@/shared/lib/clientRealtime';
import { createClientDocument, getClientDocumentsForAdmin } from '@/shared/lib/db';
import { removeUnreferencedClientDocumentUpload } from '@/shared/lib/db/clientDocumentCleanupRepo';
import { assertClientDocumentUploadAllowed } from '@/shared/lib/db/clientDocumentsRepo';
import { TransactionCommitUnknownError } from '@/shared/lib/db/transactionOutcome';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { acquireResourceUploadSlot } from '@/shared/lib/resourceUploadConcurrency';
import { UploadRequestError } from '@/shared/lib/uploadRequestGuard';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';

type Context = {
  params: Promise<{ id: string }>;
};

function parseId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;

  const { id } = await context.params;
  const clientId = parseId(id);
  if (!clientId) return Response.json({ error: 'Некорректный клиент' }, { status: 400 });

  try {
    const documents = await getClientDocumentsForAdmin(clientId, session);
    return Response.json({ documents });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Не удалось загрузить документы клиента' },
      { status: 400 },
    );
  }
}

export async function POST(request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const { id } = await context.params;
  const clientId = parseId(id);
  if (!clientId) return Response.json({ error: 'Некорректный клиент' }, { status: 400 });

  const limited = await enforceAdminActionRateLimit(session, 'client_document_upload', 60);
  if (limited) return limited;

  let savedFile: Awaited<ReturnType<typeof saveClientDocumentUpload>> | null = null;
  let releaseUploadSlot: Awaited<ReturnType<typeof acquireResourceUploadSlot>> = null;

  try {
    await assertClientDocumentUploadAllowed(clientId, session);
    releaseUploadSlot = await acquireResourceUploadSlot('document');
    if (!releaseUploadSlot) {
      return Response.json(
        { error: 'Сейчас обрабатываются другие загрузки. Повторите попытку чуть позже.', saved: false },
        { status: 503, headers: { 'Retry-After': '5' } },
      );
    }

    const uploadSignal = AbortSignal.any([request.signal, releaseUploadSlot.signal]);
    const formData = await readBoundedMultipartUpload(request, {
      maxBodyBytes: MAX_CLIENT_DOCUMENT_SIZE + 256 * 1024,
      maxFileBytes: MAX_CLIENT_DOCUMENT_SIZE,
      maxFiles: 1,
      maxFields: 2,
      maxFieldBytes: 4096,
      allowedFileFields: ['file'],
      allowedTextFields: ['title', 'isVisible'],
      signal: uploadSignal,
    });
    const file = formData.get('file');
    if (!(file instanceof File)) {
      return Response.json({ error: 'Выберите файл' }, { status: 400 });
    }

    const rawTitle = normalizeTextField(formData.get('title'), 200);
    const isVisible = formData.get('isVisible') !== 'false';
    savedFile = await saveClientDocumentUpload(clientId, file, { signal: uploadSignal });
    // An interrupted upload must not start a mutation. Once the transaction
    // commits, no upload timeout/disconnect can turn success into a false error.
    uploadSignal.throwIfAborted();
    const document = await createClientDocument(
      clientId,
      {
        title: rawTitle || savedFile.originalName,
        originalName: savedFile.originalName,
        mimeType: savedFile.mimeType,
        filePath: savedFile.filePath,
        fileSize: savedFile.fileSize,
        isVisible,
      },
      session,
    );

    try {
      publishClientRealtimeEvent({ type: 'documents.updated', companyId: clientId });
    } catch {
      console.warn(JSON.stringify({ event: 'client_document_notification_failed', clientId }));
    }
    return Response.json({ document });
  } catch (error) {
    if (savedFile) {
      try {
        await removeUnreferencedClientDocumentUpload(savedFile.filePath, clientId);
      } catch {
        console.warn(JSON.stringify({ event: 'client_document_upload_cleanup_failed', clientId }));
      }
    }
    if (error instanceof TransactionCommitUnknownError) {
      return Response.json({ error: error.message, saved: null, code: error.code }, { status: 503 });
    }
    if (releaseUploadSlot?.signal.aborted && !request.signal.aborted) {
      return Response.json({
        error: 'Обработка загрузки прервана из-за потери соединения с сервером. Повторите попытку.', saved: false,
      }, { status: 503, headers: { 'Retry-After': '5' } });
    }
    if (error instanceof BoundedMultipartUploadError || error instanceof UploadRequestError) {
      return Response.json({ error: error.message, saved: false, code: error.code }, { status: error.status });
    }
    if (request.signal.aborted) {
      return Response.json({ error: 'Загрузка прервана. Документ не сохранён.', saved: false }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : 'Не удалось прикрепить документ' },
      { status: 400 },
    );
  } finally {
    // Admission cleanup is secondary, including after a confirmed DB commit.
    if (releaseUploadSlot) {
      try {
        await releaseUploadSlot();
      } catch {
        console.warn(JSON.stringify({ event: 'client_document_upload_slot_release_failed', clientId }));
      }
    }
  }
}
