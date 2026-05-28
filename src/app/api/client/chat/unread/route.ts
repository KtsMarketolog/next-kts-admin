import { requireClientSession } from '@/shared/lib/clientAuth';
import { getClientChatUnreadCountForClient } from '@/shared/lib/db';

export async function GET() {
  const { denied, session } = await requireClientSession();
  if (denied) return denied;

  const unreadCount = await getClientChatUnreadCountForClient(session);
  return Response.json({ unreadCount });
}
