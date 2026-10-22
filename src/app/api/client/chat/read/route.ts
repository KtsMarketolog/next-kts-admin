import { requireClientSession } from '@/shared/lib/clientAuth';
import { clientChatResponse, ClientChatRequestError, readClientChatAcknowledgement } from '@/shared/lib/clientChatApi';
import { publishClientRealtimeEvent } from '@/shared/lib/clientRealtime';
import { markClientChatReadForClient } from '@/shared/lib/db';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { checkDbRateLimit } from '@/shared/lib/rateLimit';

export async function POST(request: Request) {
  const { denied, session } = await requireClientSession();
  if (denied) return clientChatResponse(denied);
  const forbidden = enforceSameOriginRequest(request);
  if (forbidden) return clientChatResponse(forbidden);
  try {
    const limited = await checkDbRateLimit(`client-chat-read:${session.clientUserId}`, 600, 10 * 60 * 1000);
    if (!limited.allowed) return clientChatResponse(Response.json({ error: 'Слишком много подтверждений прочтения' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } }));
    const ids = await readClientChatAcknowledgement(request);
    const result = await markClientChatReadForClient(session, ids);
    if (result.changed) publishClientRealtimeEvent({ type: 'chat.updated', companyId: session.companyId });
    return clientChatResponse(Response.json(result));
  } catch (error) {
    return clientChatResponse(Response.json({ error: error instanceof Error ? error.message : 'Не удалось подтвердить прочтение' },
      { status: error instanceof ClientChatRequestError ? error.status : 400 }));
  }
}
