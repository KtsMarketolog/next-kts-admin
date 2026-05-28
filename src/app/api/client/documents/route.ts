import { requireClientSession } from '@/shared/lib/clientAuth';
import { getClientDocumentsForClient } from '@/shared/lib/db';

export async function GET() {
  const { denied, session } = await requireClientSession();
  if (denied) return denied;

  const documents = await getClientDocumentsForClient(session.companyId);
  return Response.json({ documents });
}
