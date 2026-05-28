import { createClientRealtimeStream, clientRealtimeHeaders } from '@/shared/lib/clientRealtime';
import { requireClientSession } from '@/shared/lib/clientAuth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const { denied, session } = await requireClientSession();
  if (denied) return denied;

  const stream = createClientRealtimeStream((event) => event.companyId === session.companyId);
  return new Response(stream, { headers: clientRealtimeHeaders });
}
