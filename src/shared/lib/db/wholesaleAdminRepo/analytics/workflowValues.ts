import {
  getWholesalePriceWorkflowStatusLabel,
  normalizeWholesalePriceWorkflowStatus,
  type WholesalePriceWorkflowStatus,
} from '@/shared/lib/wholesalePriceWorkflowStatus';
import type { AnalyticsWorkflowRow } from './rows';

export const closedWorkflowStatuses = new Set<WholesalePriceWorkflowStatus>(['confirmed', 'rejected']);

export function safeTime(value: string | null | undefined) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function maxDateString(values: Array<string | null | undefined>) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

export function hoursBetween(start: string | null | undefined, end: string | null | undefined) {
  const startTime = safeTime(start);
  const endTime = safeTime(end);
  if (startTime === null || endTime === null || endTime < startTime) return null;
  return Math.round(((endTime - startTime) / (60 * 60 * 1000)) * 10) / 10;
}

export function averageHours(rows: AnalyticsWorkflowRow[], from: keyof AnalyticsWorkflowRow, to: keyof AnalyticsWorkflowRow) {
  const values = rows
    .map((row) => hoursBetween(row[from] as string | null | undefined, row[to] as string | null | undefined))
    .filter((value): value is number => value !== null);
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

export function rowManagerId(row: AnalyticsWorkflowRow) {
  return row.manager_id ? Number(row.manager_id) : null;
}

export function rowManagerName(row: AnalyticsWorkflowRow) {
  return row.manager_name || '';
}

export function rowStatus(row: AnalyticsWorkflowRow) {
  return normalizeWholesalePriceWorkflowStatus(row.workflow_status);
}

export function rowStatusLabel(row: AnalyticsWorkflowRow) {
  return getWholesalePriceWorkflowStatusLabel(row.workflow_status);
}

export function rowLastClientActivity(row: AnalyticsWorkflowRow) {
  return maxDateString([row.last_view_at, row.last_pdf_at, row.last_request_at]);
}

export function rowLastClientEventType(row: AnalyticsWorkflowRow) {
  const lastActivity = rowLastClientActivity(row);
  if (!lastActivity) return row.last_client_event_type || '';
  if (row.last_request_at === lastActivity) return 'public_price_request_sent';
  if (row.last_pdf_at === lastActivity) return 'public_price_pdf_downloaded';
  if (row.last_view_at === lastActivity) return Number(row.repeat_views) > 0 ? 'public_price_reopened' : 'public_price_opened';
  return row.last_client_event_type || '';
}

export function validUntilTime(value: string | null) {
  return value ? safeTime(`${value}T00:00:00`) : null;
}
