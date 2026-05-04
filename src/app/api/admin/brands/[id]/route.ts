import { deleteBrandItem, updateBrandItem } from '@/shared/lib/db';
import { requireAdmin } from '@/shared/lib/adminAuth';

type Context = {
  params: Promise<{ id: string }>;
};

export async function PUT(request: Request, context: Context) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const categoryId = Number(body.categoryId);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!Number.isFinite(categoryId)) return Response.json({ error: 'Category is required' }, { status: 400 });
  if (!name) return Response.json({ error: 'Name is required' }, { status: 400 });

  await updateBrandItem(numericId, {
    categoryId,
    name,
    imageUrl: typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '',
    iconKey: typeof body.iconKey === 'string' ? body.iconKey.trim() : '',
    sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : undefined,
    isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
  });

  return Response.json({ ok: true });
}

export async function DELETE(_request: Request, context: Context) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  await deleteBrandItem(numericId);
  return Response.json({ ok: true });
}
