import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireEmployee } from '@/shared/lib/adminAuth';
import { publishClientRealtimeEvent } from '@/shared/lib/clientRealtime';
import { deleteClientDocument, updateClientDocumentVisibility } from '@/shared/lib/db';
import { processClientDocumentCleanup } from '@/shared/lib/db/clientDocumentCleanupRepo';
import { TransactionCommitUnknownError } from '@/shared/lib/db/transactionOutcome';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';

type Context = {
  params: Promise<{ id: string; documentId: string }>;
};

function parseId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PATCH(request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const { id, documentId } = await context.params;
  const clientId = parseId(id);
  const numericDocumentId = parseId(documentId);
  if (!clientId || !numericDocumentId) return Response.json({ error: 'Некорректный документ' }, { status: 400 });

  const limited = await enforceAdminActionRateLimit(session, 'client_document_update', 120);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  try {
    const document = await updateClientDocumentVisibility(clientId, numericDocumentId, body.isVisible === true, session);
    publishClientRealtimeEvent({ type: 'documents.updated', companyId: clientId });
    return Response.json({ document });
  } catch (error) {
    if (error instanceof TransactionCommitUnknownError) {
      return Response.json({ error: error.message, saved: null, code: error.code }, { status: 503 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : 'Не удалось обновить документ' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const { id, documentId } = await context.params;
  const clientId = parseId(id);
  const numericDocumentId = parseId(documentId);
  if (!clientId || !numericDocumentId) return Response.json({ error: 'Некорректный документ' }, { status: 400 });

  const limited = await enforceAdminActionRateLimit(session, 'client_document_delete', 60);
  if (limited) return limited;

  let cleanupId: number;
  try {
    const document = await deleteClientDocument(clientId, numericDocumentId, session);
    cleanupId = document.cleanupId;
  } catch (error) {
    if (error instanceof TransactionCommitUnknownError) {
      return Response.json({ error: error.message, saved: null, code: error.code }, { status: 503 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : 'Не удалось удалить документ' },
      { status: 400 },
    );
  }
  // The record has been deleted and the cleanup request is durable. A disk or
  // realtime failure must not report that the document deletion was rolled back.
  let cleanupPending = true;
  try {
    cleanupPending = (await processClientDocumentCleanup(cleanupId)).pending;
  } catch {
    console.warn(JSON.stringify({ event: 'client_document_cleanup_pending', cleanupId }));
  }
  try {
    publishClientRealtimeEvent({ type: 'documents.updated', companyId: clientId });
  } catch {
    console.warn(JSON.stringify({ event: 'client_document_notification_failed', clientId }));
  }
  return Response.json({
    ok: true,
    cleanupPending,
    ...(cleanupPending ? { warning: 'Документ удалён из списка. Очистка файла ожидает повторной проверки администратором.' } : {}),
  });
}
