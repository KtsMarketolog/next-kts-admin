import { hashPassword, requireWholesaleAdmin } from '@/shared/lib/adminAuth';
import { deleteWholesaleManager, updateWholesaleManager } from '@/shared/lib/db';

type Context = {
  params: Promise<{ id: string }>;
};

export async function PUT(request: Request, context: Context) {
  const denied = await requireWholesaleAdmin();
  if (denied) return denied;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const login = typeof body.login === 'string' ? body.login.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!name || !login) {
    return Response.json({ error: 'Name and login are required' }, { status: 400 });
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
  const denied = await requireWholesaleAdmin();
  if (denied) return denied;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  await deleteWholesaleManager(numericId);
  return Response.json({ ok: true });
}
