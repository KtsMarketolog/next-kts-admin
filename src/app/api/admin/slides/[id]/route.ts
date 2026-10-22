import { revalidatePath } from 'next/cache';

import { deleteHeroSlide, updateHeroSlide } from '@/shared/lib/db';
import { requireAdmin } from '@/shared/lib/adminAuth';
import { saveVersionedContent } from '@/shared/lib/adminContentSave';

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Params) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await params;
  const slideId = Number(id);
  if (!Number.isInteger(slideId)) {
    return Response.json({ error: 'Invalid id' }, { status: 400 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Invalid slide' }, { status: 400 });
  }
  // Old tabs must not split a reorder into independent writes.
  if (Object.keys(body).filter((key) => key !== 'revision').length === 1 && Object.prototype.hasOwnProperty.call(body, 'sortOrder')) {
    if (!Number.isInteger(body.sortOrder) || body.sortOrder < 0 || body.sortOrder > 2_147_483_647) {
      return Response.json({ error: 'Invalid sort order' }, { status: 400 });
    }
    return Response.json({ error: 'Обновите страницу: порядок теперь сохраняется одной операцией.', code: 'ATOMIC_REORDER_REQUIRED' }, { status: 409 });
  }
  return saveVersionedContent(body.revision, (revision) => updateHeroSlide(slideId, {
    title: typeof body.title === 'string' ? body.title.trim() : undefined,
    imageUrl: typeof body.imageUrl === 'string' ? body.imageUrl.trim() : undefined,
    tabletImageUrl: typeof body.tabletImageUrl === 'string' && body.tabletImageUrl.trim() ? body.tabletImageUrl.trim() : null,
    mobileImageUrl: typeof body.mobileImageUrl === 'string' && body.mobileImageUrl.trim() ? body.mobileImageUrl.trim() : null,
    popupImageUrl: typeof body.popupImageUrl === 'string' && body.popupImageUrl.trim() ? body.popupImageUrl.trim() : null,
    popupTabletImageUrl: typeof body.popupTabletImageUrl === 'string' && body.popupTabletImageUrl.trim() ? body.popupTabletImageUrl.trim() : null,
    popupMobileImageUrl: typeof body.popupMobileImageUrl === 'string' && body.popupMobileImageUrl.trim() ? body.popupMobileImageUrl.trim() : null,
    popupTitle: typeof body.popupTitle === 'string' && body.popupTitle.trim() ? body.popupTitle.trim() : null,
    popupText: typeof body.popupText === 'string' && body.popupText.trim() ? body.popupText.trim() : null,
    linkUrl: typeof body.linkUrl === 'string' && body.linkUrl.trim() ? body.linkUrl.trim() : null,
    isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
  }, revision));
}

export async function DELETE(_request: Request, { params }: Params) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await params;
  const slideId = Number(id);
  if (!Number.isInteger(slideId)) {
    return Response.json({ error: 'Invalid id' }, { status: 400 });
  }

  await deleteHeroSlide(slideId);
  revalidatePath('/');
  return Response.json({ ok: true });
}
