import type { AdminSection } from '@/features/admin/types';
import type { AdminSession } from '@/shared/lib/adminAuth';

export const ADMIN_SECTIONS: AdminSection[] = [
  'info',
  'slider',
  'news',
  'groupCompanies',
  'brands',
  'catalog',
  'firmware',
  'categories',
  'priceGroups',
  'users',
];

export const CATEGORY_ICON_MAX_FILE_SIZE = 500 * 1024;

export const SITE_NAV_ITEMS: Array<{ value: AdminSection; label: string; description: string }> = [
  { value: 'info', label: 'Информация', description: 'Телефон, email и адрес' },
  { value: 'slider', label: 'Слайдер', description: 'Главные слайды сайта' },
  { value: 'news', label: 'Новости', description: 'Публикации и даты' },
  { value: 'groupCompanies', label: 'Группа компаний', description: 'Логотипы и ссылки' },
  { value: 'brands', label: 'Портфель брендов', description: 'Бренды и категории' },
  { value: 'catalog', label: 'Каталог', description: 'Товары и импорт' },
  { value: 'firmware', label: 'Прошивки', description: 'Файлы обновлений' },
  { value: 'categories', label: 'Категории', description: 'Иконки категорий' },
  { value: 'priceGroups', label: 'Ценовая группа', description: 'Картинки ценовых групп' },
  { value: 'users', label: 'Пользователи и доступы', description: 'Роли и права' },
];

export type AdminArea = 'home' | 'site' | 'wholesale' | 'clients' | 'analogs';

export function isManagerRole(role: AdminSession['role'] | string | null | undefined) {
  return role === 'manager' || role === 'support_manager';
}
