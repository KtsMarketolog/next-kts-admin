'use client';

import { readWholesaleManagerPasswords as readManagerPasswords } from '@/shared/lib/adminPasswordStorage';

import type { Manager, ManagerDraft, ManagerRole } from './AdminWholesaleTypes';

export const MANAGER_ROLE_TABS: Array<{ value: ManagerRole; label: string }> = [
  { value: 'manager', label: 'Менеджер по развитию' },
  { value: 'support_manager', label: 'Менеджер по сопровождению' },
];

const MANAGER_ROLE_TAB_STORAGE_KEY = 'kts-admin-wholesale-manager-role-tab';

export const emptyManager: ManagerDraft = {
  name: '',
  login: '',
  email: '',
  phone: '',
  supportManagerId: null,
  password: '',
  isActive: true,
};

export function isManagerRole(value: string | null): value is ManagerRole {
  return value === 'manager' || value === 'support_manager';
}

export function readManagerRoleTab(): ManagerRole {
  if (typeof window === 'undefined') return 'manager';
  const value = window.localStorage.getItem(MANAGER_ROLE_TAB_STORAGE_KEY);
  return isManagerRole(value) ? value : 'manager';
}

export function saveManagerRoleTab(tab: ManagerRole) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(MANAGER_ROLE_TAB_STORAGE_KEY, tab);
}

export function attachManagerPasswords(managers: Manager[]) {
  const passwords = readManagerPasswords();
  return managers.map((manager) => ({
    ...manager,
    displayPassword: manager.displayPassword || passwords[String(manager.id)] || '',
  }));
}
