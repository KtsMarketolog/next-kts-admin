import { adminRequest } from '../shared/adminRequest';

/** Read only this resource, and let the caller acknowledge only its saved row. */
export async function readSavedContentItem<T>(endpoint: string, key: string, match: (item: T) => boolean, signal: AbortSignal): Promise<T> {
  const response = await adminRequest(endpoint, { signal });
  if (!response.ok) throw new Error('Не удалось получить сохранённую запись');
  const data = await response.json();
  if (!Array.isArray(data?.[key])) throw new Error('Сервер вернул неполный список');
  const item = (data[key] as T[]).find(match);
  if (!item) throw new Error('Сохранённая запись отсутствует в ответе сервера');
  return item;
}
