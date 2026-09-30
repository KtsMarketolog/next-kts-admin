import { timingSafeEqual } from 'node:crypto';

import { CURRENCY_PRIVATE_HEADERS } from '@/shared/lib/currencyDashboardAccess';
import { runCurrencyDashboardJob } from '@/shared/lib/currencyDashboardJob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const secret = process.env.CURRENCY_DASHBOARD_CRON_SECRET;
  if (!secret || secret.length < 32) {
    return Response.json({ error: 'Currency scheduler is not configured' }, { status: 503, headers: CURRENCY_PRIVATE_HEADERS });
  }
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers: CURRENCY_PRIVATE_HEADERS });
  }
  try {
    return Response.json(await runCurrencyDashboardJob(), { headers: CURRENCY_PRIVATE_HEADERS });
  } catch (error) {
    console.error('CURRENCY_DASHBOARD_JOB_FAILED', error instanceof Error ? error.message : 'unknown');
    return Response.json({ error: 'Currency refresh failed; last successful data retained' }, { status: 503, headers: CURRENCY_PRIVATE_HEADERS });
  }
}
