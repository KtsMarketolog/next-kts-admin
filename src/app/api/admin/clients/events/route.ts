import { requireEmployee } from '@/shared/lib/adminAuth';
import { createClientRealtimeStream, clientRealtimeHeaders } from '@/shared/lib/clientRealtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const { denied } = await requireEmployee();
  if (denied) return denied;

  const stream = createClientRealtimeStream((event) => event.type === 'chat.updated');
  return new Response(stream, { headers: clientRealtimeHeaders });
}
