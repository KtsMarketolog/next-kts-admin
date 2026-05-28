import { requireEmployee } from '@/shared/lib/adminAuth';
import { createClientRealtimeStream, clientRealtimeHeaders } from '@/shared/lib/clientRealtime';
import { assertClientCompanyVisible } from '@/shared/lib/db/clientCompaniesRepo';

type Context = {
  params: Promise<{ id: string }>;
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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
    await assertClientCompanyVisible(clientId, session);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Клиент недоступен' }, { status: 403 });
  }

  const stream = createClientRealtimeStream((event) => event.companyId === clientId);
  return new Response(stream, { headers: clientRealtimeHeaders });
}
