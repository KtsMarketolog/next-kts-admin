import { requireWholesaleAdmin } from '@/shared/lib/adminAuth';
import { getWholesaleManagerById, getWholesalePriceListsForManager } from '@/shared/lib/db';

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: Context) {
  const denied = await requireWholesaleAdmin();
  if (denied) return denied;

  const { id } = await context.params;
  const managerId = Number(id);
  if (!Number.isInteger(managerId)) {
    return Response.json({ error: 'Invalid manager id' }, { status: 400 });
  }

  const manager = await getWholesaleManagerById(managerId);
  if (!manager) {
    return Response.json({ error: 'Manager not found' }, { status: 404 });
  }

  const priceLists = await getWholesalePriceListsForManager(managerId, manager.role);
  return Response.json({ manager, priceLists });
}
