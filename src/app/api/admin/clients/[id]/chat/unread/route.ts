import { requireEmployee } from '@/shared/lib/adminAuth';
import { getClientChatUnreadCountForAdmin } from '@/shared/lib/db';

type Context = {
  params: Promise<{ id: string }>;
};

function parseClientId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;

  const { id } = await context.params;
  const clientId = parseClientId(id);
  if (!clientId) return Response.json({ error: 'Некорректный клиент' }, { status: 400 });

  try {
    const unreadCount = await getClientChatUnreadCountForAdmin(clientId, session);
    return Response.json({ unreadCount });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Не удалось загрузить счетчик чата' }, { status: 400 });
  }
}
