import { requireTopDashboardSession } from '@/shared/lib/adminAuth';
import { getTopDashboardOverview } from '@/shared/lib/db';

export const runtime = 'nodejs';

export async function GET() {
  const { denied } = await requireTopDashboardSession();
  if (denied) return denied;

  try {
    const overview = await getTopDashboardOverview();
    return Response.json(overview, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    console.error('Failed to load TOP dashboard versions', error);
    return Response.json(
      { error: 'Не удалось загрузить версии стратегического обзора' },
      { status: 500 },
    );
  }
}
