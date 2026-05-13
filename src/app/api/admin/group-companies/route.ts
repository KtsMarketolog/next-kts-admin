import { revalidatePath } from 'next/cache';

import { createGroupCompany, getGroupCompanies } from '@/shared/lib/db';
import { requireAdmin } from '@/shared/lib/adminAuth';

function normalizeLinkUrl(value: unknown) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  if (trimmed.startsWith('/')) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

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
  const linkUrl = normalizeLinkUrl(body.linkUrl);
  if (!imageUrl) return Response.json({ error: 'Image is required' }, { status: 400 });

  const id = await createGroupCompany({
    imageUrl,
    linkUrl,
    sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 0,
    isActive: Boolean(body.isActive ?? true),
  });

  revalidatePath('/');
  return Response.json({ id });
}
