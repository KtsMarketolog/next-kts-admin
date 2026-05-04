import { query } from './client';
import { ensureSiteSchema } from './schema';

export type AdminUserAuth = {
  id: number;
  login: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
  role: 'admin' | 'wholesale_admin';
  passwordChangedAt: string | null;
};

function normalizeLogin(login: string) {
  return login.trim().toLowerCase();
}

export async function getAdminUserByLogin(login: string): Promise<AdminUserAuth | null> {
  await ensureSiteSchema();
  const result = await query<{
    id: string;
    login: string;
    email: string;
    password_hash: string;
    is_active: boolean;
    role: string;
    password_changed_at: string | null;
  }>(
    `select id::text, login, email, password_hash, is_active, role, password_changed_at::text
     from admin_users
     where login = $1
     limit 1`,
    [normalizeLogin(login)],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: Number(row.id),
    login: row.login,
    email: row.email,
    passwordHash: row.password_hash,
    isActive: row.is_active,
    role: row.role === 'wholesale_admin' ? 'wholesale_admin' : 'admin',
    passwordChangedAt: row.password_changed_at,
  };
}
