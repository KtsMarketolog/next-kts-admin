import { requireEmployee } from '@/shared/lib/adminAuth';
import { createClientDocumentDownloadResponse } from '@/shared/lib/clientDocumentDownloadResponse';
import { getClientDocumentForAdminDownload } from '@/shared/lib/db';

type Context = {
  params: Promise<{ id: string; documentId: string }>;
};

const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' };

function parseId(value: string) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function GET(_request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) {
    denied.headers.set('Cache-Control', PRIVATE_HEADERS['Cache-Control']);
    return denied;
  }

  const { id, documentId } = await context.params;
  const clientId = parseId(id);
  const numericDocumentId = parseId(documentId);
  if (!clientId || !numericDocumentId) return Response.json({ error: 'Некорректный документ' }, { status: 400, headers: PRIVATE_HEADERS });

  try {
    const document = await getClientDocumentForAdminDownload(clientId, numericDocumentId, session);
    return await createClientDocumentDownloadResponse(document);
  } catch {
    return Response.json(
      { error: 'Документ не найден или недоступен' },
      { status: 404, headers: PRIVATE_HEADERS },
    );
  }
}
