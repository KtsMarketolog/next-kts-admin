import { getCatalogAdminCategories } from '@/entities/catalog/api/catalogAdmin';
import { requireAdminSession } from '@/shared/lib/adminAuth';

export async function GET() {
  const { denied } = await requireAdminSession();
  if (denied) return denied;

  const categories = await getCatalogAdminCategories();
  return Response.json({ categories });
}
