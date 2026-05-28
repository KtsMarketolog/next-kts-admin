import { requireClientSession } from '@/shared/lib/clientAuth';
import { createClientDocumentDownloadResponse } from '@/shared/lib/clientDocumentDownloadResponse';
import { getClientDocumentForClientDownload } from '@/shared/lib/db';

type Context = {
  params: Promise<{ documentId: string }>;
};

function parseId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_request: Request, context: Context) {
  const { denied, session } = await requireClientSession();
  if (denied) return denied;

  const { documentId } = await context.params;
  const numericDocumentId = parseId(documentId);
  if (!numericDocumentId) return Response.json({ error: 'Некорректный документ' }, { status: 400 });

  try {
    const document = await getClientDocumentForClientDownload(session.companyId, numericDocumentId);
    return createClientDocumentDownloadResponse(document);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Не удалось скачать документ' },
      { status: 404 },
    );
  }
}
