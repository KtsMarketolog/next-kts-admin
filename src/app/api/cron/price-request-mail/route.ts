import { timingSafeEqual } from 'node:crypto';
import { drainPriceRequestMail } from '@/shared/lib/priceRequestMailWorker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export async function POST(request: Request) {
  const secret = process.env.PRICE_REQUEST_MAIL_CRON_SECRET;
  if (!secret || secret.length < 32 || secret.length > 512) {
    return Response.json({ error: 'Mail scheduler is not configured' }, { status: 503, headers });
  }
  const authorization = request.headers.get('authorization') ?? '';
  const actual = Buffer.from(authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
  const expected = Buffer.from(secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  }
  // No caller-controlled scope or retry policy; the body is never buffered or parsed.
  if (request.body) void request.body.cancel().catch(() => {});
  try {
    return Response.json(await drainPriceRequestMail(), { headers });
  } catch {
    console.error('PRICE_REQUEST_MAIL_DRAIN_FAILED');
    return Response.json({ error: 'Mail queue will be retried' }, { status: 503, headers });
  }
}
