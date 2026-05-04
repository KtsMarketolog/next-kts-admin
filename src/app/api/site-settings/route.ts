import { getSiteSettings } from '@/shared/lib/db';
import { DEFAULT_ADDRESS, DEFAULT_EMAIL, DEFAULT_PHONE } from '@/shared/lib/phone';

export async function GET() {
  try {
    const settings = await getSiteSettings();
    return Response.json(settings);
  } catch {
    return Response.json({ phone: DEFAULT_PHONE, email: DEFAULT_EMAIL, address: DEFAULT_ADDRESS });
  }
}
