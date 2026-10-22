import { revalidatePath } from 'next/cache';

import { deleteGroupCompany, updateGroupCompany } from '@/shared/lib/db';
import { requireAdmin } from '@/shared/lib/adminAuth';
import { saveVersionedContent } from '@/shared/lib/adminContentSave';

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

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Invalid company' }, { status: 400 });
  }
  if (Object.keys(body).filter((key) => key !== 'revision').length === 1 && Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
    if (!Number.isInteger(body.sortOrder) || body.sortOrder < 0 || body.sortOrder > 2_147_483_647) {
      return Response.json({ error: 'Invalid sort order' }, { status: 400 });
    }
    return Response.json({ error: 'Обновите страницу: порядок теперь сохраняется одной операцией.', code: 'ATOMIC_REORDER_REQUIRED' }, { status: 409 });
  }
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
  const linkUrl = normalizeLinkUrl(body.linkUrl);
  if (!imageUrl) return Response.json({ error: 'Image is required' }, { status: 400 });

  return saveVersionedContent(body.revision, (revision) => updateGroupCompany(numericId, {
    imageUrl,
    linkUrl,
    isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
  }, revision));
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
