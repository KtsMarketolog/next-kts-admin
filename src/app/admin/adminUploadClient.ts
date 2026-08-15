import { CATEGORY_ICON_MAX_FILE_SIZE } from './adminPanelConfig';

export type AdminUploadKind = 'image' | 'brandLogo' | 'priceGroup' | 'categoryIcon';

export async function uploadAdminImage(file: File, kind: AdminUploadKind = 'image') {
  if (kind === 'categoryIcon' && file.size > CATEGORY_ICON_MAX_FILE_SIZE) {
    throw new Error('Иконка категории должна быть не больше 500 КБ');
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('kind', kind);
  const res = await fetch('/api/admin/uploads', { method: 'POST', body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Не удалось загрузить файл');
  return data.url as string;
}
