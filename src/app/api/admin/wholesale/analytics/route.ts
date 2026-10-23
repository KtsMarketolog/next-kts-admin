import { requireWholesaleAdminSession } from '@/shared/lib/adminAuth';
import { clearWholesaleAnalyticsEvents, getWholesaleAdminAnalytics, type WholesaleAdminAnalyticsPeriod } from '@/shared/lib/db';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { analyticsUnavailableResponse } from '@/shared/lib/db/wholesaleAdminRepo/analytics/availability';

function parsePeriod(value: string | null): WholesaleAdminAnalyticsPeriod {
  if (value === '7d' || value === '30d' || value === 'all') return value;
  return '30d';
}

export async function GET(request: Request) {
  const { denied, session } = await requireWholesaleAdminSession();
  if (denied) return denied;

  const url = new URL(request.url);
  const analytics = await getWholesaleAdminAnalytics(parsePeriod(url.searchParams.get('period')), session).catch(analyticsUnavailableResponse);
  if (analytics instanceof Response) return analytics;
  return Response.json(analytics, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function DELETE(request: Request) {
  const { denied } = await requireWholesaleAdminSession();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const deleted = await clearWholesaleAnalyticsEvents();
  return Response.json({ deleted });
}
