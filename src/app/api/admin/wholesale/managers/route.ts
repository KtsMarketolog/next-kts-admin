import { hashPassword, requireWholesaleAdmin } from '@/shared/lib/adminAuth';
import { createWholesaleManager, getWholesaleManagers } from '@/shared/lib/db';

export async function GET() {
  const denied = await requireWholesaleAdmin();
  if (denied) return denied;

  const managers = await getWholesaleManagers();
  return Response.json({ managers });
}

export async function POST(request: Request) {
  const denied = await requireWholesaleAdmin();
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const login = typeof body.login === 'string' ? body.login.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!name || !login || !password) {
    return Response.json({ error: 'Name, login and password are required' }, { status: 400 });
  }

  const id = await createWholesaleManager({
    name,
    login,
    email,
    passwordHash: hashPassword(password),
    isActive: Boolean(body.isActive ?? true),
  });

  return Response.json({ id });
}
