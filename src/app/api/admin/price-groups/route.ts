import { requireAdmin } from '@/shared/lib/adminAuth';
import { getPriceGroupsWithImages, updatePriceGroupImage } from '@/shared/lib/db';

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const groups = await getPriceGroupsWithImages();
  return Response.json({ groups });
}

export async function PUT(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
  if (!title) return Response.json({ error: 'Price group is required' }, { status: 400 });

  await updatePriceGroupImage(title, imageUrl);
  return Response.json({ ok: true });
}
