import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireEmployee } from '@/shared/lib/adminAuth';
import { createClientChatMessageForAdmin, getClientChatConversationForAdmin } from '@/shared/lib/db';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';

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
    const chat = await getClientChatConversationForAdmin(clientId, session);
    return Response.json(chat);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Не удалось загрузить чат' }, { status: 400 });
  }
}

export async function POST(request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const { id } = await context.params;
  const clientId = parseClientId(id);
  if (!clientId) return Response.json({ error: 'Некорректный клиент' }, { status: 400 });

  const limited = await enforceAdminActionRateLimit(session, 'client_chat_message_create', 60);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const text = normalizeTextField(body.message, 2000);
  if (!text) return Response.json({ error: 'Введите сообщение' }, { status: 400 });

  try {
    const message = await createClientChatMessageForAdmin(clientId, session, text);
    return Response.json({ message });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Не удалось отправить сообщение' }, { status: 400 });
  }
}
