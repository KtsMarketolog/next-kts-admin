import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireEmployee } from '@/shared/lib/adminAuth';
import { removeClientDocumentFile } from '@/shared/lib/clientDocumentStorage';
import { deleteClientDocument, updateClientDocumentVisibility } from '@/shared/lib/db';
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
    return Response.json({ document });
  } catch (error) {
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

  try {
    const document = await deleteClientDocument(clientId, numericDocumentId, session);
    await removeClientDocumentFile(document.filePath);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Не удалось удалить документ' },
      { status: 400 },
    );
  }
}
