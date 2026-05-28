export type ClientCompany = {
  id: number;
  title: string;
  email: string;
  phone: string;
  note: string;
  managerId: number | null;
  managerName: string;
  supportManagerId: number | null;
  supportManagerName: string;
  userCount: number;
  clientLogin: string;
  clientUserId: number | null;
  chatUnreadCount: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Manager = {
  id: number;
  name: string;
  role: 'manager' | 'support_manager' | string;
  isActive: boolean;
};

export type ClientDraft = {
  title: string;
  email: string;
  phone: string;
  note: string;
  managerId: number | null;
  supportManagerId: number | null;
  isActive: boolean;
  password: string;
};

export type AdminClientsSectionProps = {
  onBack: () => void;
};

export const emptyDraft: ClientDraft = {
  title: '',
  email: '',
  phone: '',
  note: '',
  managerId: null,
  supportManagerId: null,
  isActive: true,
  password: '',
};

export function readApiErrorFallback(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export async function readApiError(response: Response, fallback: string) {
  const data = await response.json().catch(() => null);
  return typeof data?.error === 'string' && data.error ? data.error : fallback;
}

export function managerIdValue(value: number | null) {
  return value ? String(value) : '';
}

export function toDraft(company: ClientCompany): ClientDraft {
  return {
    title: company.title,
    email: company.email,
    phone: company.phone,
    note: company.note,
    managerId: company.managerId,
    supportManagerId: company.supportManagerId,
    isActive: company.isActive,
    password: '',
  };
}
