import { revalidatePath } from 'next/cache';

import { deleteBrandCategory, updateBrandCategory } from '@/shared/lib/db';
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
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return Response.json({ error: 'Title is required' }, { status: 400 });

  await updateBrandCategory(numericId, {
    key: typeof body.key === 'string' ? body.key.trim() : undefined,
    title,
    sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : undefined,
    isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
  });

  revalidatePath('/');
  return Response.json({ ok: true });
}

export async function DELETE(_request: Request, context: Context) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  await deleteBrandCategory(numericId);
  revalidatePath('/');
  return Response.json({ ok: true });
}
