import type { AccessUserRole, Draft, UserTab } from './AdminUsersTypes';
import { EMPTY_DRAFT } from './AdminUsersTypes';

export const ACTIVE_TAB_STORAGE_KEY = 'kts-admin-users-active-tab';

export const ROLE_LABELS: Record<AccessUserRole, string> = {
  admin: 'Администратор',
  wholesale_admin: 'Админ прайсов',
  manager: 'Менеджер по развитию',
  support_manager: 'Менеджер по сопровождению',
  top: 'TOP',
};

const ADMIN_ROLE_OPTIONS: Array<{ value: AccessUserRole; label: string }> = [
  { value: 'admin', label: 'Администратор' },
  { value: 'wholesale_admin', label: 'Админ прайсов' },
];

const MANAGER_ROLE_OPTIONS: Array<{ value: AccessUserRole; label: string }> = [
  { value: 'manager', label: 'Менеджер по развитию' },
];

const SUPPORT_MANAGER_ROLE_OPTIONS: Array<{ value: AccessUserRole; label: string }> = [
  { value: 'support_manager', label: 'Менеджер по сопровождению' },
];

const TOP_ROLE_OPTIONS: Array<{ value: AccessUserRole; label: string }> = [
  { value: 'top', label: 'TOP' },
];

export const USER_TABS: Array<{ value: UserTab; label: string }> = [
  { value: 'admin', label: 'Админ' },
  { value: 'top', label: 'TOP' },
];

export function isUserTab(value: string | null): value is UserTab {
  return value === 'admin' || value === 'top';
}

export function tabForRole(role: AccessUserRole): UserTab {
  if (role === 'top') return 'top';
  if (role === 'support_manager') return 'support_manager';
  if (role === 'manager') return 'manager';
  return 'admin';
}

export function roleOptionsForTab(tab: UserTab) {
  if (tab === 'top') return TOP_ROLE_OPTIONS;
  if (tab === 'manager') return MANAGER_ROLE_OPTIONS;
  if (tab === 'support_manager') return SUPPORT_MANAGER_ROLE_OPTIONS;
  return ADMIN_ROLE_OPTIONS;
}

export function defaultRoleForTab(tab: UserTab): AccessUserRole {
  if (tab === 'top') return 'top';
  if (tab === 'manager') return 'manager';
  if (tab === 'support_manager') return 'support_manager';
  return 'admin';
}

export function emptyDraftForTab(tab: UserTab): Draft {
  return {
    ...EMPTY_DRAFT,
    role: defaultRoleForTab(tab),
    supportManagerId: tab === 'manager' ? EMPTY_DRAFT.supportManagerId : null,
  };
}

export function addButtonLabel(tab: UserTab) {
  if (tab === 'top') return 'Добавить сотрудника TOP';
  if (tab === 'manager') return 'Добавить менеджера по развитию';
  if (tab === 'support_manager') return 'Добавить менеджера по сопровождению';
  return 'Добавить пользователя';
}
