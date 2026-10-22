import { adminRequest } from '../shared/adminRequest';
import { parseRecordRevision } from '@/shared/lib/recordVersion';

/** Acknowledge this exact write, never a later GET containing another writer's version. */
export async function readContentMutationItem<T extends { id: number; revision?: string }>(response: Response, id: number): Promise<T> {
  const data = await response.json();
  if (data?.ok !== true || data?.item?.id !== id || !parseRecordRevision(data.item.revision)) {
    throw new Error('Сервер не подтвердил версию сохранённой записи');
  }
  return data.item as T;
}

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
