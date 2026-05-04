import { clearAdminSession } from '@/shared/lib/adminAuth';

export async function POST() {
  await clearAdminSession();
  return Response.json({ ok: true });
}
