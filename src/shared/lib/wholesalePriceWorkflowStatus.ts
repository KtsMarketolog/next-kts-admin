export const WHOLESALE_PRICE_WORKFLOW_STATUSES = [
  { value: 'not_sent', label: 'Не отправлен' },
  { value: 'sent', label: 'Отправлен клиенту' },
  { value: 'negotiation', label: 'На согласовании' },
  { value: 'confirmed', label: 'Подтверждён клиентом' },
  { value: 'needs_correction', label: 'Требует корректировки' },
  { value: 'rejected', label: 'Отклонён' },
] as const;

export type WholesalePriceWorkflowStatus = (typeof WHOLESALE_PRICE_WORKFLOW_STATUSES)[number]['value'];

export const DEFAULT_WHOLESALE_PRICE_WORKFLOW_STATUS: WholesalePriceWorkflowStatus = 'not_sent';

const statusValues = new Set<string>(WHOLESALE_PRICE_WORKFLOW_STATUSES.map((status) => status.value));
const statusLabels = new Map<string, string>(WHOLESALE_PRICE_WORKFLOW_STATUSES.map((status) => [status.value, status.label]));

export function normalizeWholesalePriceWorkflowStatus(value: unknown): WholesalePriceWorkflowStatus {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return statusValues.has(normalized)
    ? (normalized as WholesalePriceWorkflowStatus)
    : DEFAULT_WHOLESALE_PRICE_WORKFLOW_STATUS;
}

export function getWholesalePriceWorkflowStatusLabel(value: unknown) {
  const status = normalizeWholesalePriceWorkflowStatus(value);
  return statusLabels.get(status) ?? statusLabels.get(DEFAULT_WHOLESALE_PRICE_WORKFLOW_STATUS) ?? 'Не отправлен';
}
