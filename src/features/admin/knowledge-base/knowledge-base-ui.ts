export const KB_API = '/api/admin/knowledge-base';

export async function readKbResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Не удалось выполнить запрос. Повторите попытку.');
  if (!data || typeof data !== 'object') throw new Error('Сервер вернул некорректный ответ. Обновите страницу.');
  return data as T;
}

export function kbRole(role: string) {
  return ({ admin: 'Администратор', admintop: 'Админ ТОП', top: 'ТОП', wholesale_admin: 'Администратор прайсов',
    manager: 'МР', support_manager: 'МС', purchaser: 'Закупщик' } as Record<string, string>)[role] ?? role;
}
export function kbSize(size: number | null) {
  if (size === null) return '';
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} КБ` : `${(size / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`;
}
export function kbDate(value: string | null) {
  return value ? new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}
