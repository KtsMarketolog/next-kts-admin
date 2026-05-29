import { requireClientSession } from '@/shared/lib/clientAuth';
import { getClientPriceRequestsForClient } from '@/shared/lib/db';

export async function GET() {
  const { denied, session } = await requireClientSession();
  if (denied) return denied;

  const requests = await getClientPriceRequestsForClient(session.companyId);
  return Response.json({ requests });
}
