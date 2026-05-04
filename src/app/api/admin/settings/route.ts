import { getSiteSettings, updateSiteSettings } from '@/shared/lib/db';
import { requireAdmin } from '@/shared/lib/adminAuth';

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const settings = await getSiteSettings();
  return Response.json(settings);
}

export async function PUT(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  if (!phone) {
    return Response.json({ error: 'Phone is required' }, { status: 400 });
  }
  if (!email) {
    return Response.json({ error: 'Email is required' }, { status: 400 });
  }
  if (!address) {
    return Response.json({ error: 'Address is required' }, { status: 400 });
  }

  await updateSiteSettings({ phone, email, address });
  return Response.json({ phone, email, address });
}
