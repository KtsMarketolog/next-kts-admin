import { revalidatePath } from 'next/cache';

import { deleteGroupCompany, updateGroupCompany } from '@/shared/lib/db';
import { requireAdmin } from '@/shared/lib/adminAuth';

type Context = {
  params: Promise<{ id: string }>;
};

function normalizeLinkUrl(value: unknown) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  if (trimmed.startsWith('/')) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export async function PUT(request: Request, context: Context) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
  const linkUrl = normalizeLinkUrl(body.linkUrl);
  if (!imageUrl) return Response.json({ error: 'Image is required' }, { status: 400 });

  await updateGroupCompany(numericId, {
    imageUrl,
    linkUrl,
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

  await deleteGroupCompany(numericId);
  revalidatePath('/');
  return Response.json({ ok: true });
}
