import { query } from '@/shared/lib/db';
import { ensureTopDashboardDataStorage } from '@/shared/lib/topDashboardDataStorage';

const HEALTH_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    await Promise.all([
      query(`select 1 as ready`),
      ensureTopDashboardDataStorage(),
    ]);
    return Response.json(
      { status: 'ready' },
      { headers: HEALTH_HEADERS },
    );
  } catch (error) {
    console.error(JSON.stringify({
      event: 'readiness_failed',
      timestamp: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
      instance: process.env.KTS_INSTANCE_ID ?? 'standalone',
    }));
    return Response.json(
      { status: 'unavailable' },
      { status: 503, headers: HEALTH_HEADERS },
    );
  }
}
