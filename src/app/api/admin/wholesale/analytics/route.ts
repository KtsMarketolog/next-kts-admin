import { requireWholesaleAdmin } from '@/shared/lib/adminAuth';
import { clearWholesaleAnalyticsEvents, getWholesaleAdminAnalytics, type WholesaleAdminAnalyticsPeriod } from '@/shared/lib/db';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';

function parsePeriod(value: string | null): WholesaleAdminAnalyticsPeriod {
  if (value === '7d' || value === '30d' || value === 'all') return value;
  return '30d';
}

export async function GET(request: Request) {
  const denied = await requireWholesaleAdmin();
  if (denied) return denied;

  const url = new URL(request.url);
  const analytics = await getWholesaleAdminAnalytics(parsePeriod(url.searchParams.get('period')));
  return Response.json(analytics);
}

export async function DELETE(request: Request) {
  const denied = await requireWholesaleAdmin();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const deleted = await clearWholesaleAnalyticsEvents();
  return Response.json({ deleted });
}
