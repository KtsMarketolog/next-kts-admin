import { query } from '../client';
import type { WholesaleManagerRole } from './types';

export function normalizeLogin(login: string) {
  return login.trim().toLowerCase();
}

export function normalizeManagerRole(role: string | null | undefined): WholesaleManagerRole {
  return role === 'support_manager' ? 'support_manager' : 'manager';
}

export function managerRoleLabel(role: string | null | undefined) {
  return normalizeManagerRole(role) === 'support_manager' ? 'Менеджер по сопровождению' : 'Менеджер по развитию';
}

export async function normalizeWholesaleSupportManagerId(supportManagerId: number | null | undefined, selfId?: number) {
  if (supportManagerId === null || supportManagerId === undefined || supportManagerId === 0) return null;
  const numericId = Number(supportManagerId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error('Некорректный менеджер по сопровождению');
  }
  if (selfId && numericId === selfId) {
    throw new Error('Нельзя назначить менеджера сопровождения самим собой');
  }
  const result = await query<{ id: string }>(
    `select id::text
     from wholesale_managers
     where id = $1 and role = 'support_manager' and is_active = true
     limit 1`,
    [numericId],
  );
  if (!result.rows[0]) {
    throw new Error('Менеджер по сопровождению не найден');
  }
  return numericId;
}
