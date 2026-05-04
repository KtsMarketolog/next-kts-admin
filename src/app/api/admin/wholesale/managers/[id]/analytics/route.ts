import { requireWholesaleAdmin } from '@/shared/lib/adminAuth';
import { getWholesaleManagerAnalytics, type WholesaleManagerAnalyticsPeriod } from '@/shared/lib/db';

type Context = {
  params: Promise<{ id: string }>;
};

function parsePeriod(value: string | null): WholesaleManagerAnalyticsPeriod {
  if (value === '7d' || value === '30d' || value === 'all') return value;
  return '30d';
}

export async function GET(request: Request, context: Context) {
  const denied = await requireWholesaleAdmin();
  if (denied) return denied;

  const { id } = await context.params;
  const managerId = Number(id);
  if (!Number.isInteger(managerId)) {
    return Response.json({ error: 'Invalid manager id' }, { status: 400 });
  }

  const url = new URL(request.url);
  const analytics = await getWholesaleManagerAnalytics(managerId, parsePeriod(url.searchParams.get('period')));
  if (!analytics) {
    return Response.json({ error: 'Manager not found' }, { status: 404 });
  }

  return Response.json(analytics);
}
