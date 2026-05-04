import { createGroupCompany, getGroupCompanies } from '@/shared/lib/db';
import { requireAdmin } from '@/shared/lib/adminAuth';

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const companies = await getGroupCompanies();
  return Response.json({ companies });
}

export async function POST(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
  if (!imageUrl) return Response.json({ error: 'Image is required' }, { status: 400 });

  const id = await createGroupCompany({
    imageUrl,
    sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
    isActive: Boolean(body.isActive ?? true),
  });

  return Response.json({ id });
}
