import { requireEmployee } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { clientChatResponse, ClientChatRequestError, parseClientChatId, readClientChatAcknowledgement } from '@/shared/lib/clientChatApi';
import { publishClientRealtimeEvent } from '@/shared/lib/clientRealtime';
import { markClientChatReadForAdmin } from '@/shared/lib/db';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return clientChatResponse(denied);
  const forbidden = enforceSameOriginRequest(request);
  if (forbidden) return clientChatResponse(forbidden);
  try {
    const companyId = parseClientChatId((await context.params).id);
    const limited = await enforceAdminActionRateLimit(session, 'client_chat_read', 600);
    if (limited) return clientChatResponse(limited);
    const ids = await readClientChatAcknowledgement(request);
    const result = await markClientChatReadForAdmin(companyId, session, ids);
    if (result.changed) publishClientRealtimeEvent({ type: 'chat.updated', companyId });
    return clientChatResponse(Response.json(result));
  } catch (error) {
    return clientChatResponse(Response.json({ error: error instanceof Error ? error.message : 'Не удалось подтвердить прочтение' },
      { status: error instanceof ClientChatRequestError ? error.status : 400 }));
  }
}
