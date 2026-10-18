import { formatDashboardTimestamp } from '@/shared/lib/dashboardDates';
import type { TopDashboardDataVersion, TopDashboardDataVersionStatus, TopDashboardSnapshotFormat, TopDashboardVersionStatus } from './topDashboardManagementModel';

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(bytes / 1024)} КБ`;
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(bytes / (1024 * 1024))} МБ`;
}

export function formatDate(value: string | null) {
  return formatDashboardTimestamp(value);
}

export function statusLabel(status: TopDashboardVersionStatus | 'previous') {
  if (status === 'active') return 'Активная';
  if (status === 'previous') return 'Предыдущая';
  if (status === 'archived') return 'Архивная';
  return 'Черновик';
}

export function dataStatusLabel(status: TopDashboardDataVersionStatus) {
  if (status === 'active') return 'Активные данные';
  if (status === 'previous') return 'Предыдущая';
  return 'Архивные';
}

export function snapshotFormatLabel(format: TopDashboardSnapshotFormat) {
  if (format === 'purchases-v1') return 'Снимок закупок';
  if (format === 'multi-file-v1') return 'Универсальный набор файлов';
  return 'Снимок КТС';
}

export function storedSizeLabel(version: TopDashboardDataVersion) {
  return version.snapshotFormat === 'multi-file-v1'
    ? `Данные в наборе: ${formatFileSize(version.uncompressedSize)}`
    : `После распаковки: ${formatFileSize(version.uncompressedSize)}`;
}

export function versionCountLabel(count: number) {
  const normalized = Math.abs(count) % 100;
  const lastDigit = normalized % 10;
  const word = normalized >= 11 && normalized <= 19
    ? 'версий'
    : lastDigit === 1
      ? 'версия'
      : lastDigit >= 2 && lastDigit <= 4
        ? 'версии'
        : 'версий';
  return `${count} ${word}`;
}
