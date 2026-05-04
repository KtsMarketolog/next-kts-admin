import { requireEmployee } from '@/shared/lib/adminAuth';
import { getWholesaleCatalog } from '@/shared/lib/db';

export async function GET() {
  const { denied } = await requireEmployee();
  if (denied) return denied;

  const categories = await getWholesaleCatalog();
  return Response.json({ categories });
}
