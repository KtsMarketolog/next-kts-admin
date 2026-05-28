import { requireEmployee } from '@/shared/lib/adminAuth';
import { getClientChatUnreadCountsForAdmin } from '@/shared/lib/db';

export async function GET() {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;

  const clients = await getClientChatUnreadCountsForAdmin(session);
  return Response.json({ clients });
}
