import type { DashboardUsageEmployee, DashboardUsageRow } from '@/shared/lib/db/dashboardUsageRepo';
import { DASHBOARD_USAGE_LABELS } from '@/shared/lib/dashboardUsage';

export const roleLabels: Record<string, string> = {
  admin: 'Администратор', admintop: 'Админ ТОП', top: 'ТОП', manager: 'МР',
  support_manager: 'МС', wholesale_admin: 'Администратор прайсов', purchaser: 'Закупки',
};
export const uploadTypes = { html: 'Версия HTML', data: 'Данные отчёта', personal: 'Личный снимок' };
export const formatTimestamp = (value: string | null) => value
  ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/Moscow' }).format(new Date(value))
  : '—';
export const formatDay = (value: string) => new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow',
}).format(new Date(value));
export const formatTime = (value: string) => new Intl.DateTimeFormat('ru-RU', {
  timeStyle: 'medium', timeZone: 'Europe/Moscow',
}).format(new Date(value));
export function formatDuration(value: number) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return [hours ? `${hours} ч` : '', minutes ? `${minutes} мин` : '', `${seconds % 60} с`].filter(Boolean).join(' ');
}
export const formatFileSize = (bytes: number) => bytes < 1024 ? `${bytes} Б` : bytes < 1048576
  ? `${(bytes / 1024).toFixed(1)} КБ` : `${(bytes / 1048576).toFixed(1)} МБ`;
export const eventLabel = (row: DashboardUsageRow) => row.hasProfitabilityDetails
  ? 'Загружен счёт / КП' : DASHBOARD_USAGE_LABELS[row.action];
export const eventMode = (row: DashboardUsageRow) => row.preview ? 'Предпросмотр / архив'
  : row.action === 'file_uploaded' ? 'Сохранено на сайте' : 'Опубликованный отчёт';

export type UsagePerson = Pick<DashboardUsageEmployee, 'actorKey' | 'actorName' | 'actorRole'>;
export type UsageSelection = { kind: 'employee'; person: UsagePerson; summary?: DashboardUsageEmployee }
  | { kind: 'event'; event: DashboardUsageRow };
export type EventFilters = { actor: string; actorName: string; dashboard: string; dashboardName: string; action: string; preview: boolean };
export const emptyEventFilters: EventFilters = { actor: '', actorName: '', dashboard: '', dashboardName: '', action: '', preview: false };
// Only cursor strings are retained between tabs. Historical result pages are not accumulated in memory.
export type UsagePagePosition = string[];
export const firstPage = (): UsagePagePosition => [''];
export function usageUrl(params: Record<string, string>, pages: UsagePagePosition, cursorKey = 'after') {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => { if (value) query.set(key, value); });
  const cursor = pages.at(-1);
  if (cursor) query.set(cursorKey, cursor);
  return `/api/admin/dashboard-usage?${query}`;
}
