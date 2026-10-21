import * as XLSX from 'xlsx';
import { DASHBOARD_USAGE_LABELS } from './dashboardUsage';
import type { DashboardUsageExport } from './db/dashboardUsageRepo';
import { DASHBOARD_USAGE_EXPORT_LIMIT, DashboardUsageExportLimitError, type DashboardUsageFilters } from './dashboardUsageFilters';

const MAX_TEXT_CHARS = 2_000_000;
export const DASHBOARD_USAGE_EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const roles: Record<string, string> = { admin: 'Администратор', admintop: 'Админ ТОП', top: 'ТОП', manager: 'МР', support_manager: 'МС', wholesale_admin: 'Администратор прайсов', purchaser: 'Закупки' };
const timestamp = (value: string | null) => value ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/Moscow' }).format(new Date(value)) : '';

/** Explicit string cells preserve original text without interpreting =,+,-,@ as Excel formulas. */
export function buildDashboardUsageWorkbook(data: DashboardUsageExport, filters: DashboardUsageFilters): Buffer {
  if (data.rows.length > DASHBOARD_USAGE_EXPORT_LIMIT) throw new DashboardUsageExportLimitError();
  const rows: (string | number)[][] = data.view === 'events'
    ? [['ID события', 'Зарегистрировано, МСК', 'Код сотрудника', 'Сотрудник', 'Роль', 'Код дашборда', 'Дашборд', 'Действие', 'Режим', 'Версия HTML', 'Имя файла', 'Размер файла, байт', 'Время видимого отчёта, с'],
      ...data.rows.map(row => [row.id, timestamp(row.createdAt), row.actorKey, row.actorName, roles[row.actorRole] ?? row.actorRole,
        row.dashboardKey, row.dashboardTitle, row.hasProfitabilityDetails ? 'Загружен счёт / КП' : DASHBOARD_USAGE_LABELS[row.action],
        row.preview ? 'Предпросмотр / архив' : row.action === 'file_uploaded' ? 'Сохранено на сайте' : 'Опубликованный отчёт', row.versionId ?? '',
        row.upload?.name ?? '', row.upload?.size ?? '', row.durationSeconds ?? ''])]
    : [['Код сотрудника', 'Сотрудник', 'Роль', 'Последнее открытие, МСК', 'Последнее событие, МСК', 'Последнее действие, МСК', 'Последний дашборд', 'Отчёты', 'Действия', 'Загрузки файлов', 'Время видимого отчёта, с'],
      ...data.rows.map(row => [row.actorKey, row.actorName, roles[row.actorRole] ?? row.actorRole,
        timestamp(row.lastOpenedAt), timestamp(row.lastUsedAt), timestamp(row.lastInteractionAt), row.lastDashboardTitle ?? '',
        row.reportCount, row.interactionCount, row.uploadCount, row.viewingSeconds])];
  let chars = 0;
  const sheet = (values: (string | number)[][]) => {
    const worksheet: XLSX.WorkSheet = {};
    for (let r = 0; r < values.length; r++) for (let c = 0; c < values[r].length; c++) {
      const value = values[r][c];
      if (typeof value === 'string') {
        chars += value.length;
        if (value.length > 32767 || chars > MAX_TEXT_CHARS) throw new DashboardUsageExportLimitError('size');
      }
      worksheet[XLSX.utils.encode_cell({ r, c })] = typeof value === 'number' ? { t: 'n', v: value } : { t: 's', v: value };
    }
    worksheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: values.length - 1, c: Math.max(...values.map(row => row.length)) - 1 } });
    return worksheet;
  };
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet(rows), data.view === 'events' ? 'События' : 'Сотрудники');
  XLSX.utils.book_append_sheet(workbook, sheet([
    ['Состав выгрузки', data.view === 'events' ? 'Все события по применённым фильтрам' : 'Сводка сотрудников по применённым фильтрам'],
    ['Часовой пояс', 'МСК (UTC+03:00)'], ['Дата с', filters.from ?? 'Начало доступной истории'], ['Дата по, включительно', filters.to ?? 'По настоящее время'],
    ['Сотрудник', filters.actorKey ?? 'Все'], ['Поиск по имени', filters.search ?? ''], ['Дашборд', filters.dashboardKey ?? 'Все'],
    ['Действие', data.view === 'employees' ? 'Сводные показатели, включая время просмотра' : filters.action ? DASHBOARD_USAGE_LABELS[filters.action] : 'Все (интервалы просмотра только при отдельном выборе)'],
    ['Предпросмотры и архив', filters.includePreview ? 'Включены' : 'Не включены'], ['Строк данных', data.rows.length],
    ['История', 'Только доступная история за один календарный месяц. Более старые удалённые события не восстанавливаются.'],
    ['Время просмотра', 'Время видимого отчёта, не оценка производительности.'],
    ['Персональные данные', 'Пароли, значения фильтров, содержимое загруженных файлов и детализация счетов в эту выгрузку не входят.'],
  ]), 'Параметры');
  const output: Buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
  if (output.length > DASHBOARD_USAGE_EXPORT_MAX_BYTES) throw new DashboardUsageExportLimitError('size');
  return output;
}

// Bound synchronous workbook generation and DB snapshots per Node process, including route reloads.
const state = globalThis as typeof globalThis & { __ktsDashboardUsageExportBusy?: boolean };
export function acquireDashboardUsageExportSlot(): (() => void) | null {
  if (state.__ktsDashboardUsageExportBusy) return null;
  state.__ktsDashboardUsageExportBusy = true;
  return () => { state.__ktsDashboardUsageExportBusy = false; };
}
