import { requireClientSession } from '@/shared/lib/clientAuth';
import { createClientDocumentDownloadResponse } from '@/shared/lib/clientDocumentDownloadResponse';
import { getClientDocumentForClientDownload } from '@/shared/lib/db';

type Context = {
  params: Promise<{ documentId: string }>;
};

const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' };

function parseId(value: string) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function GET(_request: Request, context: Context) {
  const { denied, session } = await requireClientSession();
  if (denied) {
    denied.headers.set('Cache-Control', PRIVATE_HEADERS['Cache-Control']);
    return denied;
  }

  const { documentId } = await context.params;
  const numericDocumentId = parseId(documentId);
  if (!numericDocumentId) return Response.json({ error: 'Некорректный документ' }, { status: 400, headers: PRIVATE_HEADERS });

  try {
    const document = await getClientDocumentForClientDownload(session.companyId, numericDocumentId);
    return await createClientDocumentDownloadResponse(document);
  } catch {
    return Response.json(
      { error: 'Документ не найден или недоступен' },
      { status: 404, headers: PRIVATE_HEADERS },
    );
  }
}
