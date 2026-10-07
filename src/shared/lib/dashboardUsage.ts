/** No field values, filenames, passwords or financial data belong in this protocol. */
export const DASHBOARD_USAGE_MARKER = 'kts-dashboard-usage-v1';
export const DASHBOARD_USAGE_ACTIONS = ['report_open', 'tab_changed', 'filter_changed', 'calculation_completed', 'data_loaded', 'export_started'] as const;
export type DashboardUsageAction = typeof DASHBOARD_USAGE_ACTIONS[number];
export type DashboardUsageEvent = { id: string; action: DashboardUsageAction };
export type DashboardUsageBatch = {
  dashboardKey: string;
  preview: boolean;
  versionId: number | null;
  events: DashboardUsageEvent[];
};
export const DASHBOARD_USAGE_MAX_BODY = 8192;
export const DASHBOARD_USAGE_MAX_BATCH = 20;
export const DASHBOARD_USAGE_LABELS: Record<DashboardUsageAction, string> = {
  report_open: 'Открытие отчёта', tab_changed: 'Переключение вкладки',
  filter_changed: 'Изменение фильтра', calculation_completed: 'Расчёт завершён',
  data_loaded: 'Данные обработаны', export_started: 'Экспорт подготовлен / скачивание начато',
};

export function isDashboardUsageAction(value: unknown): value is DashboardUsageAction {
  return typeof value === 'string' && DASHBOARD_USAGE_ACTIONS.includes(value as DashboardUsageAction);
}

export function isDashboardUsageKey(value: unknown): value is string {
  return typeof value === 'string' && /^(?:top:[1-9][0-9]{0,14}|manager:(?:development|support)|route-planner|currency-rates)$/.test(value);
}

export function parseDashboardUsageBatch(value: unknown): DashboardUsageBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректные события');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['dashboardKey', 'preview', 'versionId', 'events'].includes(key))
    || !isDashboardUsageKey(input.dashboardKey) || typeof input.preview !== 'boolean'
    || (input.versionId !== null && (!Number.isSafeInteger(input.versionId) || Number(input.versionId) < 1))
    || !Array.isArray(input.events) || input.events.length < 1 || input.events.length > DASHBOARD_USAGE_MAX_BATCH) {
    throw new Error('Некорректные события');
  }
  const ids = new Set<string>();
  const events = input.events.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some((key) => !['id', 'action'].includes(key))
      || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(entry.id)
      || !isDashboardUsageAction(entry.action) || ids.has(entry.id)) throw new Error('Некорректные события');
    ids.add(entry.id);
    return { id: entry.id as string, action: entry.action as DashboardUsageAction };
  });
  return { dashboardKey: input.dashboardKey, preview: input.preview, versionId: input.versionId as number | null, events };
}

export function readDashboardUsageMessage(value: unknown, nonce: string): DashboardUsageAction | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.marker !== DASHBOARD_USAGE_MARKER || message.type !== 'event' || message.nonce !== nonce
    || Object.keys(message).some((key) => !['marker', 'type', 'nonce', 'action'].includes(key))) return null;
  return isDashboardUsageAction(message.action) ? message.action : null;
}
