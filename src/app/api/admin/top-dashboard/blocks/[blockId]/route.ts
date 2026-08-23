import { requireTopDashboardSession } from '@/shared/lib/adminAuth';
import { getTopDashboardBlockOverview, TopDashboardBlockNotFoundError } from '@/shared/lib/db';

import { parsePositiveId } from '../routeUtils';

export const runtime = 'nodejs';

type Context = {
  params: Promise<{ blockId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { denied } = await requireTopDashboardSession();
  if (denied) return denied;

  const { blockId: rawBlockId } = await context.params;
  const blockId = parsePositiveId(rawBlockId);
  if (!blockId) return Response.json({ error: 'Некорректный блок' }, { status: 400 });

  try {
    const overview = await getTopDashboardBlockOverview(blockId);
    return Response.json(overview, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    if (error instanceof TopDashboardBlockNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error('Failed to load TOP dashboard block', error);
    return Response.json({ error: 'Не удалось загрузить блок' }, { status: 500 });
  }
}
