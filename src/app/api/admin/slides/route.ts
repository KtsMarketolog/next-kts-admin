import { revalidatePath } from 'next/cache';

import { createHeroSlide, getHeroSlides } from '@/shared/lib/db';
import { requireAdmin } from '@/shared/lib/adminAuth';

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const slides = await getHeroSlides();
  return Response.json({ slides });
}

export async function POST(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
  if (!imageUrl) {
    return Response.json({ error: 'Image is required' }, { status: 400 });
  }

  const id = await createHeroSlide({
    title: typeof body.title === 'string' ? body.title.trim() : '',
    imageUrl,
    tabletImageUrl: typeof body.tabletImageUrl === 'string' && body.tabletImageUrl.trim() ? body.tabletImageUrl.trim() : null,
    mobileImageUrl: typeof body.mobileImageUrl === 'string' && body.mobileImageUrl.trim() ? body.mobileImageUrl.trim() : null,
    popupImageUrl: typeof body.popupImageUrl === 'string' && body.popupImageUrl.trim() ? body.popupImageUrl.trim() : null,
    popupTabletImageUrl: typeof body.popupTabletImageUrl === 'string' && body.popupTabletImageUrl.trim() ? body.popupTabletImageUrl.trim() : null,
    popupMobileImageUrl: typeof body.popupMobileImageUrl === 'string' && body.popupMobileImageUrl.trim() ? body.popupMobileImageUrl.trim() : null,
    popupTitle: typeof body.popupTitle === 'string' && body.popupTitle.trim() ? body.popupTitle.trim() : null,
    popupText: typeof body.popupText === 'string' && body.popupText.trim() ? body.popupText.trim() : null,
    linkUrl: typeof body.linkUrl === 'string' && body.linkUrl.trim() ? body.linkUrl.trim() : null,
    sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
    isActive: Boolean(body.isActive ?? true),
  });

  revalidatePath('/');
  return Response.json({ id });
}
