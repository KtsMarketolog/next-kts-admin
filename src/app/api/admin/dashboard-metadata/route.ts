import { getAdminSession } from '@/shared/lib/adminAuth';
import { canAccessReportsCatalog } from '@/shared/lib/dashboardAccess';
import { getDashboardReportDates } from '@/shared/lib/db/dashboardReportDatesRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getAdminSession();
  if (!session || !canAccessReportsCatalog(session)) return Response.json({ error: 'Нет доступа' }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } });
  try {
    return Response.json({ reports: await getDashboardReportDates(session) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Failed to load dashboard update dates', error);
    return Response.json({ error: 'Не удалось загрузить даты обновлений' }, { status: 500, headers: { 'Cache-Control': 'private, no-store' } });
  }
}
