import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { hashPassword, requireWholesaleAdmin, requireWholesaleAdminSession } from '@/shared/lib/adminAuth';
import { createWholesaleManager, getWholesaleManagers } from '@/shared/lib/db';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';

export async function GET() {
  const denied = await requireWholesaleAdmin();
  if (denied) return denied;

  const managers = await getWholesaleManagers();
  return Response.json({ managers });
}

export async function POST(request: Request) {
  const { denied, session } = await requireWholesaleAdminSession();
  if (denied) return denied;
  const limited = await enforceAdminActionRateLimit(session, 'manager_create', 40);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const name = normalizeTextField(body.name, 120);
  const login = normalizeTextField(body.login, 80);
  const email = normalizeTextField(body.email, 160);
  const password = typeof body.password === 'string' ? body.password : '';

  if (!name || !login || !password) {
    return Response.json({ error: 'Name, login and password are required' }, { status: 400 });
  }
  if (password.length < 8 || password.length > 200) {
    return Response.json({ error: 'Password must be 8-200 characters' }, { status: 400 });
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
