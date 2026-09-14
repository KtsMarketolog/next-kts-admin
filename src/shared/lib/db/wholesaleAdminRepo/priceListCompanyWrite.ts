import type { PoolClient } from 'pg';
import type { AdminSession } from '@/shared/lib/adminAuth';

type Assignment = { managerId: number | null; supportManagerId: number | null };

/** Use the price transaction, never the global pool. Locks keep permission,
 * role and activity checks valid until the price and company commit together. */
export async function lockPriceListCompany(
  client: PoolClient,
  companyId: number | null | undefined,
  assignment: Assignment,
  session?: AdminSession | null,
) {
  if (!Number.isSafeInteger(companyId) || Number(companyId) <= 0) throw new Error('Выберите клиента из списка');
  if (!assignment.managerId) throw new Error('Выберите менеджера по развитию');
  if (!assignment.supportManagerId) throw new Error('Выберите менеджера по сопровождению');

  // Deterministic manager -> company -> price lock order for both POST and PUT.
  // FOR SHARE, not KEY SHARE: role/activity can change without changing an ID.
  const managers = await client.query<{ id: string; role: string; is_active: boolean }>(
    `select id::text, role, is_active from wholesale_managers
     where id = any($1::bigint[]) order by id for share`,
    [[assignment.managerId, assignment.supportManagerId]],
  );
  for (const [id, role, label] of [
    [assignment.managerId, 'manager', 'Менеджер по развитию'],
    [assignment.supportManagerId, 'support_manager', 'Менеджер по сопровождению'],
  ] as const) {
    if (!managers.rows.some((row) => Number(row.id) === id && row.role === role && row.is_active)) {
      throw new Error(`${label} не найден или отключен`);
    }
  }
  const allClients = !session || session.role === 'admin' || session.role === 'wholesale_admin';
  const company = await client.query<{ id: string; title: string }>(
    `select id::text, title from client_companies
     where id = $1 and is_active = true
       and ($2::boolean or manager_id = $3 or support_manager_id = $3)
     for update`,
    [companyId, allClients, session?.managerId ?? 0],
  );
  if (!company.rows[0]) throw new Error('Клиент не найден, отключен или недоступен');
  return { id: Number(company.rows[0].id), title: company.rows[0].title };
}

export async function writePriceListCompanyAssignment(client: PoolClient, companyId: number, assignment: Assignment) {
  const result = await client.query(
    `update client_companies set manager_id = $2, support_manager_id = $3, updated_at = now()
     where id = $1`,
    [companyId, assignment.managerId, assignment.supportManagerId],
  );
  if (result.rowCount !== 1) throw new Error('Не удалось сохранить назначение менеджеров клиента');
}
