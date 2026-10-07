/** Dates describe the data, never a renamed block or a selected upload filename. */
export function normalizeDashboardDataDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(text)) return null;
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) return null;
  // Date.parse normalizes impossible dates such as February 30.
  const day = text.slice(0, 10);
  const calendarDay = new Date(`${day}T00:00:00Z`);
  if (calendarDay.toISOString().slice(0, 10) !== day) return null;
  return text.length === 10 ? day : parsed.toISOString();
}

export function formatDashboardTimestamp(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return `${new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow',
  }).format(new Date(value))} МСК`;
}

export function formatDashboardDataDate(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short', timeZone: 'Europe/Moscow',
  }).format(new Date(value));
}
