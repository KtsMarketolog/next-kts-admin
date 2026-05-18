import { revalidatePath } from 'next/cache';

import { deleteNewsItem, updateNewsItem } from '@/shared/lib/db';
import { requireAdmin } from '@/shared/lib/adminAuth';

type Context = {
  params: Promise<{ id: string }>;
};

export async function PUT(request: Request, context: Context) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) {
    return Response.json({ error: 'Invalid id' }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!imageUrl) return Response.json({ error: 'Image is required' }, { status: 400 });
  if (!title) return Response.json({ error: 'Title is required' }, { status: 400 });

  await updateNewsItem(numericId, {
    date: typeof body.date === 'string' ? body.date.trim() : '',
    title,
    imageUrl,
    linkUrl: typeof body.linkUrl === 'string' ? body.linkUrl.trim() : '',
    sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
    isActive: Boolean(body.isActive),
  });

  revalidatePath('/');
  return Response.json({ ok: true });
}

export async function DELETE(_request: Request, context: Context) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) {
    return Response.json({ error: 'Invalid id' }, { status: 400 });
  }

  await deleteNewsItem(numericId);
  revalidatePath('/');
  return Response.json({ ok: true });
}
