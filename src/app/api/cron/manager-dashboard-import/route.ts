import { timingSafeEqual } from 'node:crypto';
import { importManagerDashboardFromEmail } from '@/shared/lib/managerDashboardMail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({error: 'Cron не настроен'}, {status: 503});
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '').trim() || request.headers.get('x-cron-secret')?.trim() || '';
  const actual = Buffer.from(token); const expected = Buffer.from(secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({error: 'Unauthorized'}, {status: 401});
  try {
    const result = await importManagerDashboardFromEmail();
    return Response.json(result, {headers: {'Cache-Control': 'no-store'}});
  } catch {
    console.error('Personal dashboard mail check failed', {category: 'mail'});
    return Response.json({error: 'Не удалось проверить почту личных снимков'}, {status: 503});
  }
}
