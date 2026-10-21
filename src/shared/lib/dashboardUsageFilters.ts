import { isDashboardUsageAction, isDashboardUsageKey, type DashboardUsageAction } from './dashboardUsage';

export type DashboardUsageFilters = {
  from?: string; to?: string; actorKey?: string; search?: string;
  dashboardKey?: string; action?: DashboardUsageAction; includePreview?: boolean;
};
export class DashboardUsageFilterError extends Error {
  constructor(message = 'Некорректный фильтр') { super(message); this.name = 'DashboardUsageFilterError'; }
}
export function isDashboardUsageActor(value: unknown): value is string {
  return typeof value === 'string' && /^(?:admin:(?:[1-9][0-9]{0,14}|primary)|manager:[1-9][0-9]{0,14})$/.test(value);
}
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1970-01-01' || value > '9998-12-31') return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** Moscow calendar dates, never the browser/server's local timezone. */
export function dashboardUsageDateBounds(input: Pick<DashboardUsageFilters, 'from' | 'to'>) {
  for (const date of [input.from, input.to]) if (date !== undefined && !validDate(date)) throw new DashboardUsageFilterError('Укажите существующую дату в формате ГГГГ-ММ-ДД');
  if (input.from && input.to && input.from > input.to) throw new DashboardUsageFilterError('Начало периода не может быть позже окончания');
  return {
    fromInclusive: input.from ? new Date(`${input.from}T00:00:00+03:00`).toISOString() : null,
    toExclusive: input.to ? new Date(new Date(`${input.to}T00:00:00+03:00`).getTime() + 86_400_000).toISOString() : null,
  };
}
export function validateDashboardUsageFilters(input: DashboardUsageFilters) {
  if (input.actorKey !== undefined && !isDashboardUsageActor(input.actorKey)) throw new DashboardUsageFilterError();
  if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 100)) throw new DashboardUsageFilterError();
  if (input.dashboardKey !== undefined && !isDashboardUsageKey(input.dashboardKey)) throw new DashboardUsageFilterError();
  if (input.action !== undefined && !isDashboardUsageAction(input.action)) throw new DashboardUsageFilterError();
  return dashboardUsageDateBounds(input);
}
export function parseDashboardUsageFilters(params: URLSearchParams, view: 'events' | 'employees' | 'employee' | 'actors', exporting = false) {
  const allowed = view === 'actors' ? ['view', 'search', 'after']
    : ['view', 'from', 'to', 'actor', ...(view === 'events' ? ['dashboard', 'action', 'preview', 'search', ...(!exporting ? ['before'] : [])]
      : [...(view === 'employees' ? ['search'] : []), ...(!exporting ? ['after'] : [])])];
  if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) throw new DashboardUsageFilterError();
  const input: DashboardUsageFilters = {};
  for (const key of ['from', 'to', 'search'] as const) if (params.has(key)) {
    const value = key === 'search' ? params.get(key)!.trim() : params.get(key)!;
    if (value || key !== 'search') input[key] = value;
  }
  if (params.has('actor')) input.actorKey = params.get('actor')!;
  if (params.has('dashboard')) input.dashboardKey = params.get('dashboard')!;
  if (params.has('action')) input.action = params.get('action') as DashboardUsageAction;
  if (view === 'events') {
    if (params.has('preview') && !['0', '1'].includes(params.get('preview')!)) throw new DashboardUsageFilterError();
    input.includePreview = params.get('preview') === '1';
  }
  validateDashboardUsageFilters(input);
  if (view === 'employee' && !input.actorKey) throw new DashboardUsageFilterError();
  const before = params.get('before') || undefined, after = params.get('after') || undefined;
  if (before && !/^[1-9][0-9]{0,17}$/.test(before)) throw new DashboardUsageFilterError();
  if (after && !(view === 'employee' ? isDashboardUsageKey(after) : isDashboardUsageActor(after))) throw new DashboardUsageFilterError();
  return { ...input, ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

export const DASHBOARD_USAGE_EXPORT_LIMIT = 5000;
export class DashboardUsageExportLimitError extends Error {
  constructor(reason: 'rows' | 'size' = 'rows') {
    super(reason === 'size'
      ? 'Превышен безопасный объём Excel. Сузьте период или выберите сотрудника. Файл не создан, данные не обрезались.'
      : 'Слишком много данных для Excel. Сузьте период или выберите сотрудника (не более 5000 строк). Файл не создан, данные не обрезались.');
    this.name = 'DashboardUsageExportLimitError';
  }
}
