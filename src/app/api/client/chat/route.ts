import { requireClientSession } from '@/shared/lib/clientAuth';
import { publishClientRealtimeEvent } from '@/shared/lib/clientRealtime';
import { createClientChatMessageForClient, getClientChatConversationForClient } from '@/shared/lib/db';
import { clientChatResponse, parseClientChatPage } from '@/shared/lib/clientChatApi';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { checkDbRateLimit, getClientIp } from '@/shared/lib/rateLimit';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';

const CHAT_LIMIT = 30;
const CHAT_WINDOW_MS = 10 * 60 * 1000;

export async function GET(request: Request) {
  const { denied, session } = await requireClientSession();
  if (denied) return clientChatResponse(denied);

  try {
    const chat = await getClientChatConversationForClient(session, parseClientChatPage(request.url));
    return clientChatResponse(Response.json(chat));
  } catch (error) {
    return clientChatResponse(Response.json({ error: error instanceof Error ? error.message : 'Не удалось загрузить чат' }, { status: 400 }));
  }
}

export async function POST(request: Request) {
  const { denied, session } = await requireClientSession();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const rateLimit = await checkDbRateLimit(`client-chat:${session.clientUserId}:${getClientIp(request) || 'unknown'}`, CHAT_LIMIT, CHAT_WINDOW_MS);
  if (!rateLimit.allowed) {
    return Response.json({ error: 'Too many messages' }, { status: 429, headers: { 'Retry-After': String(rateLimit.retryAfter) } });
  }

  const body = await request.json().catch(() => ({}));
  const text = normalizeTextField(body.message, 2000);
  if (!text) return Response.json({ error: 'Введите сообщение' }, { status: 400 });

  const message = await createClientChatMessageForClient(session, text);
  publishClientRealtimeEvent({ type: 'chat.updated', companyId: session.companyId });
  return Response.json({ message });
}
