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
  requireTwoFactor: boolean;
  userCount: number;
  clientLogin: string;
  clientUserId: number | null;
  passwordChangedAt: string;
  displayPassword: string;
  chatUnreadCount: number;
  isActive: boolean;
  archivedAt: string | null;
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
  expectedUpdatedAt?: string;
  title: string;
  email: string;
  phone: string;
  note: string;
  managerId: number | null;
  supportManagerId: number | null;
  requireTwoFactor: boolean;
  isActive: boolean;
  password: string;
};

export type AdminClientsSectionProps = {
  onBack: () => void;
};

export type ClientListScope = 'active' | 'archived';

export function clientMatchesScope(company: ClientCompany, scope: ClientListScope) {
  return Boolean(company.archivedAt) === (scope === 'archived');
}

export function archiveClientConfirmation(company: ClientCompany) {
  return `Перенести клиента «${company.title || 'Без названия'}» в архив?\n\n`
    + 'Вход в личный кабинет будет закрыт, действующие сессии завершены. Компания, пользователи и пароли, переписка, документы, заявки, привязки прайсов и файлы сохранятся.\n\n'
    + 'Публичные ссылки на прайсы НЕ отключаются, заявки по ним могут продолжать поступать. Если публичные ссылки больше не нужны, отключите их до архивирования.\n\n'
    + 'Архив хранится до явного ручного удаления администратором; автоматического удаления по сроку нет. Восстановление из архива возможно, но доступ нужно будет включить отдельно. Несохранённые правки этой карточки не войдут в архив.';
}

export type ClientDeletionPreview = {
  id: number;
  title: string;
  archivedAt: string;
  updatedAt: string;
  revision: string;
  counts: {
    users: number; sessions: number; twoFactorChallenges: number; chatMessages: number;
    chatReadStates: number; documents: number; files: number; fileBytes: number;
    priceRequests: number; priceLists: number;
  };
};

export function readClientDeletionPreview(value: unknown, companyId: number): ClientDeletionPreview {
  if (!value || typeof value !== 'object') throw new Error('Не удалось получить состав удаляемых данных. Обновите список перед повтором.');
  const preview = value as ClientDeletionPreview;
  const countKeys = ['users', 'sessions', 'twoFactorChallenges', 'chatMessages', 'chatReadStates', 'documents', 'files', 'fileBytes', 'priceRequests', 'priceLists'] as const;
  if (preview.id !== companyId || typeof preview.title !== 'string' || !preview.title
    || typeof preview.archivedAt !== 'string' || !Number.isFinite(Date.parse(preview.archivedAt))
    || typeof preview.updatedAt !== 'string' || !Number.isFinite(Date.parse(preview.updatedAt))
    || typeof preview.revision !== 'string' || !/^[a-f0-9]{64}$/.test(preview.revision)
    || !preview.counts || countKeys.some((key) => !Number.isSafeInteger(preview.counts[key]) || preview.counts[key] < 0)) {
    throw new Error('Не удалось получить состав удаляемых данных. Обновите список перед повтором.');
  }
  return preview;
}

// A scope switch must not discard drafts for companies hidden by that scope.
export function mergeClientDrafts(
  current: Record<number, ClientDraft>,
  companies: ClientCompany[],
  previousCompanies: Map<number, ClientCompany>,
) {
  const next = { ...current };
  for (const company of companies) {
    const previous = previousCompanies.get(company.id);
    const dirty = current[company.id] && (!previous || JSON.stringify(current[company.id]) !== JSON.stringify(toDraft(previous)));
    if (!dirty) next[company.id] = toDraft(company);
  }
  return next;
}

export const emptyDraft: ClientDraft = {
  title: '',
  email: '',
  phone: '',
  note: '',
  managerId: null,
  supportManagerId: null,
  requireTwoFactor: false,
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
    expectedUpdatedAt: company.updatedAt,
    title: company.title,
    email: company.email,
    phone: company.phone,
    note: company.note,
    managerId: company.managerId,
    supportManagerId: company.supportManagerId,
    requireTwoFactor: company.requireTwoFactor,
    isActive: company.isActive,
    password: '',
  };
}
