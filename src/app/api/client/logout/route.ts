import { clearClientSession } from '@/shared/lib/clientAuth';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';

export async function POST(request: Request) {
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  await clearClientSession();
  return Response.json({ ok: true });
}
