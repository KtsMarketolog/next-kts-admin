import { CATEGORY_ICON_MAX_FILE_SIZE } from './adminPanelConfig';
import { adminRequest, ADMIN_UPLOAD_TIMEOUT_MS } from '@/features/admin/shared/adminRequest';

export type AdminUploadKind = 'image' | 'brandLogo' | 'priceGroup' | 'categoryIcon';

export async function uploadAdminImage(file: File, kind: AdminUploadKind = 'image', request = adminRequest) {
  if (kind === 'categoryIcon' && file.size > CATEGORY_ICON_MAX_FILE_SIZE) {
    throw new Error('Иконка категории должна быть не больше 500 КБ');
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('kind', kind);
  const res = await request('/api/admin/uploads', { method: 'POST', body: formData }, { timeoutMs: ADMIN_UPLOAD_TIMEOUT_MS });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Не удалось загрузить файл');
  if (typeof data.url !== 'string' || !data.url) throw new Error('Сервер не подтвердил адрес загруженного файла. Проверьте результат перед повторной загрузкой.');
  return data.url as string;
}
