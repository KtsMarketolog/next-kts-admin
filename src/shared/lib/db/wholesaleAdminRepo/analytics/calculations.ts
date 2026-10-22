import { normalizeWholesalePriceWorkflowStatus } from '@/shared/lib/wholesalePriceWorkflowStatus';
import type { AnalyticsEventType } from '../../analyticsRepo';
import type { WholesaleManagerAnalyticsPeriod, WholesalePriceListEditor } from '../types';

export function normalizeLogin(login: string) {
  return login.trim().toLowerCase();
}

export function managerRoleLabel(role: string | null | undefined) {
  return role === 'support_manager' ? 'Менеджер по сопровождению' : 'Менеджер по развитию';
}

export function periodSqlInterval(period: WholesaleManagerAnalyticsPeriod) {
  if (period === '7d') return '7 days';
  if (period === '30d') return '30 days';
  return null;
}

export function actionEventType(action: string): AnalyticsEventType {
  if (action === 'create') return 'price_created';
  if (action === 'delete') return 'price_deleted';
  if (action === 'enable') return 'price_activated';
  if (action === 'disable') return 'price_deactivated';
  if (action === 'status') return 'price_status_changed';
  return 'price_updated';
}

export function clientIdFromName(clientName?: string | null) {
  const value = clientName?.trim();
  return value ? value.toLowerCase() : null;
}

export function priceListAction(previous: { is_active: boolean; } | null, next: { isActive: boolean; }) {
  if (!previous) return 'create';
  if (previous.is_active !== next.isActive) return next.isActive ? 'enable' : 'disable';
  return 'edit';
}

export function priceListDetails(
  previous: { client_name: string; valid_until: string | null; is_active: boolean; workflow_status?: string | null; } | null,
  next: Pick<WholesalePriceListEditor, 'clientName' | 'validUntil' | 'isActive' | 'workflowStatus'>,
) {
  if (!previous) return 'Прайс создан';

  const details: string[] = [];
  if ((previous.client_name || '') !== next.clientName) details.push('изменён клиент');
  if ((previous.valid_until || '') !== (next.validUntil || '')) details.push('изменён срок действия');
  if (normalizeWholesalePriceWorkflowStatus(previous.workflow_status) !== next.workflowStatus) details.push('изменён статус работы');
  if (previous.is_active !== next.isActive) details.push(next.isActive ? 'прайс включён' : 'прайс отключён');
  return details.length ? details.join(', ') : 'Прайс обновлён';
}

export function qualityScore(input: {
  emptyPrices: number;
  pricesWithoutClient: number;
  pricesWithoutExpiration: number;
  expiredPrices: number;
  pricesWithoutViews: number;
  stalePrices30Days: number;
}) {
  const score =
    100 -
    Math.min(input.emptyPrices * 20, 40) -
    Math.min(input.pricesWithoutClient * 15, 30) -
    Math.min(input.pricesWithoutExpiration * 10, 20) -
    Math.min(input.expiredPrices * 15, 30) -
    Math.min(input.pricesWithoutViews * 5, 20) -
    Math.min(input.stalePrices30Days * 5, 20);
  return Math.max(0, Math.min(100, score));
}
