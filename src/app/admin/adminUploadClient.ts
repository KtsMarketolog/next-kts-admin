import { CATEGORY_ICON_MAX_FILE_SIZE } from './adminPanelConfig';

export type AdminUploadKind = 'image' | 'brandLogo' | 'priceGroup' | 'categoryIcon';

export async function uploadAdminImage(file: File, kind: AdminUploadKind = 'image') {
  if (kind === 'categoryIcon' && file.size > CATEGORY_ICON_MAX_FILE_SIZE) {
    throw new Error('РРєРѕРЅРєР° РєР°С‚РµРіРѕСЂРёРё РґРѕР»Р¶РЅР° Р±С‹С‚СЊ РЅРµ Р±РѕР»СЊС€Рµ 500 РљР‘');
  }

  const formData = new FormData();
  formData.append('file', file);
  formData.append('kind', kind);
  const res = await fetch('/api/admin/uploads', { method: 'POST', body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ С„Р°Р№Р»');
  return data.url as string;
}
