import { isManagerSessionRole, type AdminSession } from '@/shared/lib/adminAuth';
import type { AnalyticsActorType } from '../../analyticsRepo';
import { assertClientCompanyVisible } from '../../clientCompaniesRepo';
import { readActiveClientCompany } from './clientReads';
import { managerRoleLabel } from './calculations';

export function sessionManagerId(session?: AdminSession | null) {
  return isManagerSessionRole(session?.role) ? session?.managerId ?? -1 : null;
}

export function actorTypeFromRole(role: AdminSession['role'] | 'admin'): AnalyticsActorType {
  return isManagerSessionRole(role) ? 'manager' : 'admin';
}

export async function resolveWholesaleClientCompany(clientCompanyId: number | null | undefined, session?: AdminSession | null) {
  const id = Number(clientCompanyId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Выберите клиента из списка');
  }
  if (session) await assertClientCompanyVisible(id, session);

  const result = await readActiveClientCompany(id);
  const row = result.rows[0];
  if (!row) throw new Error('Клиент не найден или отключен');
  return { id: Number(row.id), title: row.title };
}

export function actorMeta(session?: AdminSession | null) {
  const actorManagerId = isManagerSessionRole(session?.role) ? session?.managerId ?? null : null;
  const actorRole: AdminSession['role'] =
    isManagerSessionRole(session?.role) ? session.role : session?.role === 'wholesale_admin' ? 'wholesale_admin' : 'admin';
  const actorFallback =
    actorRole === 'admin'
      ? 'Администратор'
      : actorRole === 'wholesale_admin'
        ? 'Администратор прайсов'
        : managerRoleLabel(actorRole);

  return { actorManagerId, actorRole, actorFallback };
}
