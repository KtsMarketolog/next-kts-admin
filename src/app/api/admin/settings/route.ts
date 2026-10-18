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

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Invalid settings' }, { status: 400 });
  }
  const settings: { phone?: string; email?: string; address?: string } = {};
  const labels = { phone: 'Phone', email: 'Email', address: 'Address' };
  for (const key of ['phone', 'email', 'address'] as const) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const value = typeof body[key] === 'string' ? body[key].trim() : '';
    if (!value) return Response.json({ error: `${labels[key]} is required` }, { status: 400 });
    settings[key] = value;
  }
  if (!Object.keys(settings).length) {
    return Response.json({ error: 'No settings supplied' }, { status: 400 });
  }

  await updateSiteSettings(settings);
  return Response.json(settings);
}
