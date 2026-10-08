import type { AdminSessionRole } from './adminAuth';

export class AccessUserManagementError extends Error {
  readonly status = 403;

  constructor() {
    super('Учётными записями администраторов сайта управляет только администратор сайта');
  }
}

export class DashboardOptionsConflictError extends Error {
  readonly status = 409;

  constructor() {
    super('Список дашбордов или общие доступы изменились. Обновите список дашбордов и проверьте выбор перед созданием сотрудника.');
  }
}

export class AccessUserProfileForbiddenError extends Error {
  readonly status = 403;

  constructor() {
    super('Админ TOP может менять только доступ к дашбордам. Профиль, пароль и удаление сотрудника доступны администратору сайта.');
  }
}

type UserProfile = {
  name: string; login: string; email: string; role: string; isActive: boolean;
  canManageTopDashboard: boolean; supportManagerId?: number | null; passwordHash?: string;
};

export function assertDelegatedAccessOnly(previous: UserProfile, next: UserProfile) {
  if (next.passwordHash !== undefined || previous.name !== next.name || previous.login !== next.login
    || previous.email !== next.email || previous.role !== next.role || previous.isActive !== next.isActive
    || previous.canManageTopDashboard !== next.canManageTopDashboard
    || (previous.supportManagerId ?? null) !== (next.supportManagerId ?? null)) throw new AccessUserProfileForbiddenError();
}

export function assertAccessUserManagementAllowed(actorRole: AdminSessionRole, targetRole: string, nextRole?: string) {
  if (actorRole === 'admin') return;
  if (actorRole !== 'admintop' || targetRole === 'admin' || nextRole === 'admin') throw new AccessUserManagementError();
}
