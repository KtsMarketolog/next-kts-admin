import { createBrandItem } from '@/shared/lib/db';
import { requireAdmin } from '@/shared/lib/adminAuth';

export async function POST(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const categoryId = Number(body.categoryId);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!Number.isFinite(categoryId)) return Response.json({ error: 'Category is required' }, { status: 400 });
  if (!name) return Response.json({ error: 'Name is required' }, { status: 400 });

  const id = await createBrandItem({
    categoryId,
    name,
    imageUrl: typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '',
    iconKey: typeof body.iconKey === 'string' ? body.iconKey.trim() : '',
    sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
    isActive: Boolean(body.isActive ?? true),
  });

  return Response.json({ id });
}
