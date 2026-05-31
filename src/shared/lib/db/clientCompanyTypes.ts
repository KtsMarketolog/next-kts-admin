import type { WholesalePriceWorkflowStatus } from '@/shared/lib/wholesalePriceWorkflowStatus';

export type ClientCompany = {
  id: number;
  title: string;
  inn: string;
  kpp: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  note: string;
  managerId: number | null;
  managerName: string;
  supportManagerId: number | null;
  supportManagerName: string;
  requireTwoFactor: boolean;
  userCount: number;
  clientLogin: string;
  clientUserId: number | null;
  passwordChangedAt: string;
  displayPassword: string;
  chatUnreadCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ClientCompanyInput = {
  title: string;
  inn: string;
  kpp: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  note: string;
  managerId: number | null;
  supportManagerId: number | null;
  requireTwoFactor: boolean;
  isActive: boolean;
  passwordHash?: string;
  displayPassword?: string;
};

export type ClientCompanyManagerAssignmentsInput = {
  managerId: number | null;
  supportManagerId: number | null;
};

export type ClientPortalUserAuth = {
  id: number;
  companyId: number;
  companyTitle: string;
  name: string;
  email: string;
  phone: string;
  login: string;
  passwordHash: string;
  isActive: boolean;
  companyIsActive: boolean;
  requireTwoFactor: boolean;
  passwordChangedAt: string | null;
};

export type ClientPortalProfile = {
  id: number;
  name: string;
  email: string;
  phone: string;
  login: string;
  company: {
    id: number;
    title: string;
    email: string;
    phone: string;
    managerName: string;
    managerEmail: string;
    managerPhone: string;
    supportManagerName: string;
    supportManagerEmail: string;
    supportManagerPhone: string;
    chatUnreadCount: number;
  };
  priceLists: ClientCompanyPriceList[];
};

export type ClientCompanyPriceList = {
  id: number;
  title: string;
  token: string;
  validUntil: string | null;
  workflowStatus: WholesalePriceWorkflowStatus;
  workflowStatusLabel: string;
  isActive: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
};
