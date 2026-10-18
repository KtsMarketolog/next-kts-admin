import type { AdminSession } from '../adminAuth';
import { decryptClientPassword } from '../clientPasswordVault';
import { query } from './client';
import { ensureSiteSchema } from './schema';

/** The credential and its current company scope come from the same SQL snapshot. */
export async function readClientCompanyPassword(companyId: number, session: AdminSession) {
  if (!Number.isSafeInteger(companyId) || companyId <= 0
    || !['admin', 'wholesale_admin', 'manager', 'support_manager'].includes(session.role)) return null;
  if (['manager', 'support_manager'].includes(session.role)
    && (!Number.isSafeInteger(session.managerId) || Number(session.managerId) <= 0)) return null;
  await ensureSiteSchema();
  const result = await query<{ id: string; password_hash: string; password_ciphertext: string | null }>(
    `select cu.id::text, cu.password_hash, cu.password_ciphertext
     from client_companies cc
     join lateral (
       select id, password_hash, password_ciphertext from client_users where company_id = cc.id
       order by created_at asc, id asc limit 1
     ) cu on true
     where cc.id = $1 and cc.archived_at is null
       and ($2::text in ('admin', 'wholesale_admin')
         or ($2::text in ('manager', 'support_manager') and (cc.manager_id = $3 or cc.support_manager_id = $3)))`,
    [companyId, session.role, session.managerId ?? null],
  );
  const row = result.rows[0];
  return row ? { password: decryptClientPassword(row.password_ciphertext, row.password_hash), clientUserId: Number(row.id) } : null;
}
