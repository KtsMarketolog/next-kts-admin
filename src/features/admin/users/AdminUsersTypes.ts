export type AccessUserRole = 'admin' | 'wholesale_admin' | 'manager' | 'support_manager' | 'top';
export type UserTab = 'admin' | 'manager' | 'support_manager' | 'top';

export type AccessUser = {
  id: string;
  source: 'admin' | 'manager';
  numericId: number;
  name: string;
  login: string;
  email: string;
  role: AccessUserRole;
  isActive: boolean;
  accesses: string[];
  priceListCount: number;
  supportManagerId: number | null;
  supportManagerName: string;
  isCurrent: boolean;
  displayPassword: string;
};

export type Draft = {
  name: string;
  login: string;
  email: string;
  role: AccessUserRole;
  supportManagerId: number | null;
  password: string;
  isActive: boolean;
};

export const EMPTY_DRAFT: Draft = {
  name: '',
  login: '',
  email: '',
  role: 'manager',
  supportManagerId: null,
  password: '',
  isActive: true,
};
