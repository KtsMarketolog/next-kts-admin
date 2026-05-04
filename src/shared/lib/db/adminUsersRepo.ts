import { query } from './client';
import { ensureSiteSchema } from './schema';

export type AdminUserAuth = {
  id: number;
  login: string;
  passwordHash: string;
  isActive: boolean;
  role: 'admin' | 'wholesale_admin';
};

function normalizeLogin(login: string) {
  return login.trim().toLowerCase();
}

export async function getAdminUserByLogin(login: string): Promise<AdminUserAuth | null> {
  await ensureSiteSchema();
  const result = await query<{
    id: string;
    login: string;
    password_hash: string;
    is_active: boolean;
    role: string;
  }>(
    `select id::text, login, password_hash, is_active, role
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
    passwordHash: row.password_hash,
    isActive: row.is_active,
    role: row.role === 'wholesale_admin' ? 'wholesale_admin' : 'admin',
  };
}
