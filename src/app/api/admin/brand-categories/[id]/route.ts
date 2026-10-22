import { revalidatePath } from 'next/cache';

import { deleteBrandCategory, updateBrandCategory } from '@/shared/lib/db';
import { requireAdmin } from '@/shared/lib/adminAuth';
import { saveVersionedContent } from '@/shared/lib/adminContentSave';

type Context = {
  params: Promise<{ id: string }>;
};

export async function PUT(request: Request, context: Context) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Invalid brand category' }, { status: 400 });
  }
  if (Object.keys(body).filter((key) => key !== 'revision').length === 1 && Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
    if (!Number.isInteger(body.sortOrder) || body.sortOrder < 0 || body.sortOrder > 2_147_483_647) {
      return Response.json({ error: 'Invalid sort order' }, { status: 400 });
    }
    return Response.json({ error: 'Обновите страницу: порядок теперь сохраняется одной операцией.', code: 'ATOMIC_REORDER_REQUIRED' }, { status: 409 });
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return Response.json({ error: 'Title is required' }, { status: 400 });

  return saveVersionedContent(body.revision, (revision) => updateBrandCategory(numericId, {
    key: typeof body.key === 'string' ? body.key.trim() : undefined,
    title,
    isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
  }, revision));
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
