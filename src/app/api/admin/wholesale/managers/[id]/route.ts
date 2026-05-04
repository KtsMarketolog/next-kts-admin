import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { hashPassword, requireWholesaleAdminSession } from '@/shared/lib/adminAuth';
import { deleteWholesaleManager, updateWholesaleManager } from '@/shared/lib/db';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';

type Context = {
  params: Promise<{ id: string }>;
};

export async function PUT(request: Request, context: Context) {
  const { denied, session } = await requireWholesaleAdminSession();
  if (denied) return denied;
  const limited = await enforceAdminActionRateLimit(session, 'manager_update', 80);
  if (limited) return limited;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const name = normalizeTextField(body.name, 120);
  const login = normalizeTextField(body.login, 80);
  const email = normalizeTextField(body.email, 160);
  const password = typeof body.password === 'string' ? body.password : '';

  if (!name || !login) {
    return Response.json({ error: 'Name and login are required' }, { status: 400 });
  }
  if (password && (password.length < 8 || password.length > 200)) {
    return Response.json({ error: 'Password must be 8-200 characters' }, { status: 400 });
  }

  await updateWholesaleManager(numericId, {
    name,
    login,
    email,
    passwordHash: password ? hashPassword(password) : undefined,
    isActive: Boolean(body.isActive ?? true),
  });

  return Response.json({ ok: true });
}

export async function DELETE(_request: Request, context: Context) {
  const { denied, session } = await requireWholesaleAdminSession();
  if (denied) return denied;
  const limited = await enforceAdminActionRateLimit(session, 'manager_delete', 30);
  if (limited) return limited;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  await deleteWholesaleManager(numericId);
  return Response.json({ ok: true });
}
