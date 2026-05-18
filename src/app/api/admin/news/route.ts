import { revalidatePath } from 'next/cache';

import { createNewsItem, getNewsItems } from '@/shared/lib/db';
import { requireAdmin } from '@/shared/lib/adminAuth';

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const news = await getNewsItems();
  return Response.json({ news });
}

export async function POST(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!imageUrl) return Response.json({ error: 'Image is required' }, { status: 400 });
  if (!title) return Response.json({ error: 'Title is required' }, { status: 400 });

  const id = await createNewsItem({
    date: typeof body.date === 'string' ? body.date.trim() : '',
    title,
    imageUrl,
    linkUrl: typeof body.linkUrl === 'string' ? body.linkUrl.trim() : '',
    sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
    isActive: Boolean(body.isActive ?? true),
  });

  revalidatePath('/');
  return Response.json({ id });
}
