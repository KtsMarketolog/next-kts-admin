import { timingSafeEqual } from 'node:crypto';
import { pruneExpiredDashboardUsage } from '@/shared/lib/db/dashboardUsageRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export async function POST(request: Request) {
  const secret = process.env.DASHBOARD_USAGE_CRON_SECRET;
  if (!secret || secret.length < 32 || secret.length > 512) return Response.json({ error: 'Usage retention scheduler is not configured' }, { status: 503, headers });
  const authorization = request.headers.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const actual = Buffer.from(token);
  const expected = Buffer.from(secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return Response.json({ error: 'Unauthorized' }, { status: 401, headers });
  // The cutoff and deletion scope are server-defined, never supplied by callers.
  if (request.body) return Response.json({ error: 'Request body is not accepted' }, { status: 400, headers });
  try {
    return Response.json(await pruneExpiredDashboardUsage(), { headers });
  } catch {
    console.error('DASHBOARD_USAGE_RETENTION_FAILED');
    return Response.json({ error: 'Usage retention failed; retry later' }, { status: 503, headers });
  }
}
