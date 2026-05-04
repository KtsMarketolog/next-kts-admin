import { deleteHeroSlide, updateHeroSlide } from '@/shared/lib/db';
import { requireAdmin } from '@/shared/lib/adminAuth';

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Params) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await params;
  const slideId = Number(id);
  if (!Number.isInteger(slideId)) {
    return Response.json({ error: 'Invalid id' }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  await updateHeroSlide(slideId, {
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
    sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : undefined,
    isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
  });

  return Response.json({ ok: true });
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
  return Response.json({ ok: true });
}
