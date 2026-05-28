import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireEmployee } from '@/shared/lib/adminAuth';
import { saveClientDocumentUpload, removeClientDocumentFile } from '@/shared/lib/clientDocumentStorage';
import { createClientDocument, getClientDocumentsForAdmin } from '@/shared/lib/db';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
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

  const formData = await request.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'Выберите файл' }, { status: 400 });
  }

  const rawTitle = normalizeTextField(formData.get('title'), 200);
  const isVisible = formData.get('isVisible') !== 'false';
  let savedFile: Awaited<ReturnType<typeof saveClientDocumentUpload>> | null = null;

  try {
    savedFile = await saveClientDocumentUpload(clientId, file);
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

    return Response.json({ document });
  } catch (error) {
    if (savedFile) await removeClientDocumentFile(savedFile.filePath);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Не удалось прикрепить документ' },
      { status: 400 },
    );
  }
}
