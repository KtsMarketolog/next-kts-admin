import { PersonalDashboardError } from '../../managerDashboardDomain';
import type { PersonalDashboardRecipient } from '../../managerDashboardRecipients';
import { type PersonalDashboardAudience, parsePersonalDashboardAudience } from '../../managerDashboardAudience';

export function positiveId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) throw new PersonalDashboardError('NOT_FOUND', 'Данные не найдены');
}

export function checkedRecipient(value: number | PersonalDashboardRecipient): PersonalDashboardRecipient {
  const recipient = typeof value === 'number' ? { source: 'manager' as const, id: value } : value;
  if (!recipient || (recipient.source !== 'manager' && recipient.source !== 'admin')) {
    throw new PersonalDashboardError('NOT_FOUND', 'Данные не найдены');
  }
  positiveId(recipient.id);
  return recipient;
}

export function ownerColumn(recipient: PersonalDashboardRecipient): 'manager_id' | 'admin_user_id' {
  return recipient.source === 'manager' ? 'manager_id' : 'admin_user_id';
}

export function checkedAudience(value: PersonalDashboardAudience): PersonalDashboardAudience {
  const audience = parsePersonalDashboardAudience(value);
  if (!audience) throw new PersonalDashboardError('NOT_FOUND', 'Группа личного дашборда не найдена');
  return audience;
}

export function safeLogText(value: string | undefined, max: number): string {
  return (typeof value === 'string' ? value : '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
}

export function sourceKey(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PersonalDashboardError('INVALID_SOURCE', 'Некорректный идентификатор импорта');
  }
  return value;
}

export function actor(value: string): string {
  if (typeof value !== 'string' || value.length > 160 || !/^(?:admin|admintop|manager):[A-Za-z0-9._:-]+$/.test(value)) {
    throw new PersonalDashboardError('INVALID_ACTOR', 'Не указан автор изменения');
  }
  return value;
}
