/** Only reviewed event metadata; never raw files, form values, passwords or financial contents. */
export const DASHBOARD_USAGE_MARKER = 'kts-dashboard-usage-v1';
export const DASHBOARD_USAGE_ACTIONS = ['report_open', 'tab_changed', 'filter_changed', 'calculation_completed', 'data_loaded', 'export_started', 'file_uploaded', 'viewing_time'] as const;
export type DashboardUsageAction = typeof DASHBOARD_USAGE_ACTIONS[number];
export type DashboardUsageUpload = { name: string; size: number };
export type DashboardUsageUploadType = 'html' | 'data' | 'personal';
export type DashboardUsageEvent = {
  id: string; action: DashboardUsageAction; upload?: DashboardUsageUpload;
  uploadType?: DashboardUsageUploadType; durationSeconds?: number; viewingWindowId?: string;
};
export type DashboardUsageMessageDetails = Pick<DashboardUsageEvent, 'action' | 'upload'>;
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
  file_uploaded: 'Файл загружен на сайт', viewing_time: 'Время видимого отчёта',
};

export function isDashboardUsageAction(value: unknown): value is DashboardUsageAction {
  return typeof value === 'string' && DASHBOARD_USAGE_ACTIONS.includes(value as DashboardUsageAction);
}

export function isDashboardUsageKey(value: unknown): value is string {
  return typeof value === 'string' && /^(?:top:[1-9][0-9]{0,14}|manager:(?:development|support)|route-planner|currency-rates)$/.test(value);
}

export function parseDashboardUsageUpload(value: unknown): DashboardUsageUpload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Некорректные события');
  const upload = value as Record<string, unknown>;
  if (Object.keys(upload).some((key) => !['name', 'size'].includes(key))
    || typeof upload.name !== 'string' || !upload.name.trim() || upload.name.length > 255 || ['.', '..'].includes(upload.name)
    || /[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/.test(upload.name)
    || !Number.isSafeInteger(upload.size) || Number(upload.size) < 0 || Number(upload.size) > 2147483648) throw new Error('Некорректные события');
  return { name: upload.name, size: Number(upload.size) };
}

export function parseDashboardUsageEvent(value: unknown, options: { allowServerUpload?: boolean } = {}): DashboardUsageEvent {
  const invalid = () => { throw new Error('Некорректные события'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some((key) => !['id', 'action', 'upload', 'uploadType', 'durationSeconds', 'viewingWindowId'].includes(key))
    || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(entry.id)
    || !isDashboardUsageAction(entry.action)) return invalid();
  const result: DashboardUsageEvent = { id: entry.id, action: entry.action };
  if (entry.action === 'viewing_time') {
    if (!Number.isInteger(entry.durationSeconds) || Number(entry.durationSeconds) < 1 || Number(entry.durationSeconds) > 60
      || typeof entry.viewingWindowId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(entry.viewingWindowId)
      || 'upload' in entry || 'uploadType' in entry) return invalid();
    return { ...result, durationSeconds: Number(entry.durationSeconds), viewingWindowId: entry.viewingWindowId };
  }
  if ('durationSeconds' in entry || 'viewingWindowId' in entry) return invalid();
  if (entry.action === 'file_uploaded') {
    if (!options.allowServerUpload || typeof entry.uploadType !== 'string' || !['html', 'data', 'personal'].includes(entry.uploadType) || !('upload' in entry)) return invalid();
    result.uploadType = entry.uploadType as DashboardUsageUploadType;
  } else if ('uploadType' in entry) return invalid();
  if ('upload' in entry) {
    if (!['data_loaded', 'file_uploaded'].includes(entry.action) || !entry.upload || typeof entry.upload !== 'object' || Array.isArray(entry.upload)) return invalid();
    result.upload = parseDashboardUsageUpload(entry.upload);
  }
  return result;
}

export function parseDashboardUsageBatch(value: unknown, options: { allowServerUpload?: boolean } = {}): DashboardUsageBatch {
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
    const event = parseDashboardUsageEvent(entry, options);
    if (ids.has(event.id)) throw new Error('Некорректные события');
    ids.add(event.id);
    return event;
  });
  return { dashboardKey: input.dashboardKey, preview: input.preview, versionId: input.versionId as number | null, events };
}

export function readDashboardUsageMessage(value: unknown, nonce: string): DashboardUsageAction | null {
  return readDashboardUsageMessageDetails(value, nonce)?.action ?? null;
}

export function readDashboardUsageMessageDetails(value: unknown, nonce: string): DashboardUsageMessageDetails | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.marker !== DASHBOARD_USAGE_MARKER || message.type !== 'event' || message.nonce !== nonce
    || Object.keys(message).some((key) => !['marker', 'type', 'nonce', 'action', 'upload'].includes(key))
    || message.action === 'viewing_time' || message.action === 'file_uploaded') return null;
  try {
    const event = parseDashboardUsageEvent({ id: nonce, action: message.action, ...('upload' in message ? { upload: message.upload } : {}) });
    return { action: event.action, ...(event.upload ? { upload: event.upload } : {}) };
  } catch { return null; }
}
