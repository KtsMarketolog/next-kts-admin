import { requireEmployee } from '@/shared/lib/adminAuth';
import { createClientDocumentDownloadResponse } from '@/shared/lib/clientDocumentDownloadResponse';
import { getClientDocumentForAdminDownload } from '@/shared/lib/db';

type Context = {
  params: Promise<{ id: string; documentId: string }>;
};

function parseId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;

  const { id, documentId } = await context.params;
  const clientId = parseId(id);
  const numericDocumentId = parseId(documentId);
  if (!clientId || !numericDocumentId) return Response.json({ error: 'Некорректный документ' }, { status: 400 });

  try {
    const document = await getClientDocumentForAdminDownload(clientId, numericDocumentId, session);
    return createClientDocumentDownloadResponse(document);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Не удалось скачать документ' },
      { status: 404 },
    );
  }
}
