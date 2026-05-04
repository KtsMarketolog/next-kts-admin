import { createBrandCategory, getBrandPortfolio } from '@/shared/lib/db';
import { requireAdmin } from '@/shared/lib/adminAuth';

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const portfolio = await getBrandPortfolio();
  return Response.json(portfolio);
}

export async function POST(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return Response.json({ error: 'Title is required' }, { status: 400 });

  const keySource = typeof body.key === 'string' && body.key.trim() ? body.key.trim() : title;
  const key = keySource
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '');

  const id = await createBrandCategory({
    key,
    title,
    sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
    isActive: Boolean(body.isActive ?? true),
  });

  return Response.json({ id });
}
