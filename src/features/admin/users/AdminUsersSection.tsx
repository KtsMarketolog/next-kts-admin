'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createEmployeeActionLock, employeeRequest, EmployeeRequestError, EMPLOYEE_UNKNOWN_OUTCOME, withoutEmployeePassword } from '../shared/employeeRequest';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import type { DashboardAccessOption } from '@/shared/lib/dashboardAccess';

import {
  ACTIVE_TAB_STORAGE_KEY,
  emptyDraftForTab,
  isUserTab,
  roleOptionsForTab,
  tabForRole,
} from './AdminUsersConfig';
import type { AccessUser, AccessUserRole, Draft, UserTab } from './AdminUsersTypes';
import { EMPTY_DRAFT } from './AdminUsersTypes';
import { AdminUsersView } from './AdminUsersView';
import { defaultDashboardAccess, readDashboardOptions } from './AdminUsersDashboardAccess';

type AdminUsersSectionProps = {
  showStatus: (message: string) => void;
  canManageSiteAdmins?: boolean;
};

function readActiveTab(): UserTab {
  if (typeof window === 'undefined') return 'admin';
  try {
    const value = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    return isUserTab(value) ? value : 'admin';
  } catch { return 'admin'; }
}

function saveActiveTab(tab: UserTab) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab); } catch { /* Optional UI preference. */ }
}

function normalizeUsers(users: AccessUser[]) {
  return users.map((user) => ({
    ...withoutEmployeePassword(user),
    dashboardAccess: Array.isArray(user.dashboardAccess) ? user.dashboardAccess : [],
  }));
}

export function AdminUsersSection({ showStatus, canManageSiteAdmins = true }: AdminUsersSectionProps) {
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [draft, setDraft] = useState<Draft>(() => ({ ...EMPTY_DRAFT, role: canManageSiteAdmins ? EMPTY_DRAFT.role : 'wholesale_admin' }));
  const [activeTab, setActiveTab] = useState<UserTab>(() => readActiveTab());
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  const [passwordEditIds, setPasswordEditIds] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dashboardOptions, setDashboardOptions] = useState<DashboardAccessOption[] | null>(null);
  const [dashboardOptionsVersion, setDashboardOptionsVersion] = useState<string | null>(null);
  const [dashboardOptionsLoading, setDashboardOptionsLoading] = useState(true);
  const [dashboardOptionsError, setDashboardOptionsError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const actionLock = useRef(createEmployeeActionLock());
  const showStatusRef = useRef(showStatus);
  const draftAccessTouched = useRef(false);

  useEffect(() => {
    showStatusRef.current = showStatus;
  }, [showStatus]);

  const activeRoleOptions = roleOptionsForTab(activeTab, canManageSiteAdmins);
  const filteredUsers = useMemo(() => users.filter((user) => tabForRole(user.role) === activeTab), [activeTab, users]);

  const loadUsers = useCallback(async () => {
    if (!actionLock.current.acquire()) return;
    setLoading(true);
    setDashboardOptionsLoading(true);
    try {
      const data = await employeeRequest<{ users: AccessUser[]; dashboardOptions: unknown; dashboardOptionsVersion?: string }>('/api/admin/users');
      const accessUsers: AccessUser[] = Array.isArray(data.users) ? data.users : [];
      const visibleUsers = canManageSiteAdmins ? accessUsers : accessUsers.filter((user) => user.role !== 'admin');
      setUsers(normalizeUsers(visibleUsers));
      setPasswordDrafts({});
      setPasswordEditIds({});
      setRequestError(null);
      const options = readDashboardOptions(data.dashboardOptions);
      setDashboardOptions(options);
      setDashboardOptionsVersion(typeof data.dashboardOptionsVersion === 'string' ? data.dashboardOptionsVersion : null);
      setDashboardOptionsError(options ? null : 'Сервер не передал корректный список дашбордов.');
    } catch {
      showStatusRef.current('Не удалось загрузить пользователей');
      setDashboardOptionsError('Не удалось загрузить список дашбордов.');
    } finally {
      actionLock.current.release();
      setLoading(false);
      setDashboardOptionsLoading(false);
    }
  }, [canManageSiteAdmins]);

  const reloadDashboardOptions = async () => {
    if (!actionLock.current.acquire()) return;
    setDashboardOptionsLoading(true);
    setDashboardOptionsError(null);
    try {
      const data = await employeeRequest<{ dashboardOptions: unknown; dashboardOptionsVersion?: string }>('/api/admin/users');
      const options = readDashboardOptions(data.dashboardOptions);
      if (!options) throw new Error('Сервер не передал корректный список дашбордов.');
      // Retry options only: preserve the administrator's unsaved user changes.
      setDashboardOptions(options);
      setDashboardOptionsVersion(typeof data.dashboardOptionsVersion === 'string' ? data.dashboardOptionsVersion : null);
      if (draftAccessTouched.current) showStatusRef.current('Список обновлён. Проверьте доступы нового сотрудника перед сохранением.');
    } catch (error) {
      setDashboardOptions(null);
      setDashboardOptionsError(error instanceof Error ? error.message : 'Не удалось загрузить список дашбордов.');
    } finally {
      actionLock.current.release();
      setDashboardOptionsLoading(false);
    }
  };

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    saveActiveTab(activeTab);
    setDraft((current) => {
      const options = roleOptionsForTab(activeTab, canManageSiteAdmins);
      const roleIsAllowed = options.some((option) => option.value === current.role);
      const role = roleIsAllowed ? current.role : options[0].value;
      return {
        ...current,
        role,
        supportManagerId: null,
        canManageTopDashboard: role === 'top' ? current.canManageTopDashboard : false,
      };
    });
  }, [activeTab, canManageSiteAdmins]);

  useEffect(() => {
    if (!dashboardOptions || draftAccessTouched.current) return;
    const selected = defaultDashboardAccess(dashboardOptions, draft.role);
    setDraft((current) => JSON.stringify(current.dashboardAccess) === JSON.stringify(selected) ? current : { ...current, dashboardAccess: selected });
  }, [dashboardOptions, draft.role]);

  const updateUser = (id: string, patch: Partial<AccessUser>) => {
    setUsers((current) => current.map((user) => (user.id === id ? { ...user, ...patch } : user)));
  };

  const updateUserRole = (id: string, role: AccessUserRole) => {
    updateUser(id, {
      role,
      supportManagerId: null,
      supportManagerName: '',
      canManageTopDashboard: role === 'top'
        ? users.find((user) => user.id === id)?.canManageTopDashboard === true
        : false,
    });
  };

  const markSaved = (id: string) => {
    setSavedId(id);
    window.setTimeout(() => {
      setSavedId((current) => (current === id ? null : current));
    }, 2000);
  };

  const reportRequestError = (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Не удалось выполнить запрос';
    setRequestError(message);
    showStatusRef.current(message);
  };

  const validatePasswordBeforeSave = (password: string) => {
    const passwordPolicy = validatePasswordPolicy(password);
    if (!passwordPolicy.ok) {
      showStatusRef.current(passwordPolicy.error || 'Пароль не подходит. Измените пароль и сохраните снова.');
      return false;
    }
    return true;
  };

  const createUser = async () => {
    const role = activeRoleOptions.some((option) => option.value === draft.role) ? draft.role : activeRoleOptions[0].value;
    if (dashboardOptionsLoading || dashboardOptions === null || (draftAccessTouched.current && !dashboardOptionsVersion)) {
      showStatusRef.current('Дождитесь загрузки списка дашбордов перед сохранением сотрудника');
      return;
    }
    const payload = {
      ...draft,
      name: draft.name.trim(),
      login: draft.login.trim(),
      email: draft.email.trim(),
      password: draft.password.trim(),
      role,
      supportManagerId: null,
      canManageTopDashboard: role === 'top' && draft.canManageTopDashboard,
      // Untouched forms inherit the current all-employees policy inside the creation transaction.
      dashboardAccess: draftAccessTouched.current ? draft.dashboardAccess : undefined,
      dashboardOptionsVersion: draftAccessTouched.current ? dashboardOptionsVersion : undefined,
    };

    if (!payload.name || !payload.login || !payload.password) {
      showStatusRef.current('Заполните имя, логин и пароль, затем сохраните пользователя');
      return;
    }
    if (!validatePasswordBeforeSave(payload.password)) return;
    if (!actionLock.current.acquire()) return;
    setRequestError(null);
    setBusyId('new');
    try {
      const data = await employeeRequest<{ user: AccessUser }>('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, { mutation: true });
      if (!data.user?.id) throw new EmployeeRequestError(EMPLOYEE_UNKNOWN_OUTCOME);
      const createdUser = withoutEmployeePassword(data.user);
      setUsers((current) => [...current, createdUser]);
      const nextTab = tabForRole(data.user.role);
      setActiveTab(nextTab);
      draftAccessTouched.current = false;
      setDraft({ ...emptyDraftForTab(nextTab), role, dashboardAccess: defaultDashboardAccess(dashboardOptions, role) });
      markSaved('new');
      showStatusRef.current('Пользователь добавлен');
    } catch (error) {
      reportRequestError(error);
      if (error instanceof EmployeeRequestError && error.status === 409) {
        setDashboardOptions(null);
        setDashboardOptionsVersion(null);
        setDashboardOptionsError('Общие доступы изменились. Обновите список и проверьте выбор; введённые данные сотрудника сохранены.');
      }
    } finally {
      actionLock.current.release();
      setBusyId(null);
    }
  };

  const saveUser = async (user: AccessUser) => {
    if (dashboardOptionsLoading || dashboardOptions === null) {
      showStatusRef.current('Дождитесь загрузки списка дашбордов перед сохранением сотрудника');
      return;
    }
    const passwordIsEdited = Boolean(passwordEditIds[user.id]);
    const nextPassword = passwordIsEdited ? (passwordDrafts[user.id] || '').trim() : '';
    if (passwordIsEdited && !nextPassword) {
      showStatusRef.current('Введите новый пароль или нажмите «Отменить пароль»');
      return;
    }
    if (nextPassword && !validatePasswordBeforeSave(nextPassword)) return;

    const payload = canManageSiteAdmins ? { ...withoutEmployeePassword(user), password: nextPassword } : {
      name: user.name, login: user.login, email: user.email, role: user.role,
      isActive: user.isActive, canManageTopDashboard: user.canManageTopDashboard,
      supportManagerId: user.supportManagerId, dashboardAccess: user.dashboardAccess,
      dashboardAccessVersion: user.dashboardAccessVersion,
    };
    if (!actionLock.current.acquire()) return;
    setRequestError(null);
    setBusyId(user.id);
    try {
      const data = await employeeRequest<{ user: AccessUser }>(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, { mutation: true });
      if (!data.user?.id) throw new EmployeeRequestError(EMPLOYEE_UNKNOWN_OUTCOME);
      const savedUser = withoutEmployeePassword(data.user);
      setUsers((current) => current.map((item) => (item.id === user.id ? savedUser : item)));
      setActiveTab(tabForRole(data.user.role));
      setPasswordDrafts((current) => {
        const next = { ...current };
        delete next[user.id];
        if (data.user.id !== user.id) delete next[data.user.id];
        return next;
      });
      setPasswordEditIds((current) => {
        const next = { ...current };
        delete next[user.id];
        if (data.user.id !== user.id) delete next[data.user.id];
        return next;
      });
      markSaved(data.user.id);
      showStatusRef.current('Пользователь сохранён');
    } catch (error) {
      reportRequestError(error);
    } finally {
      actionLock.current.release();
      setBusyId(null);
    }
  };

  const deleteUser = async (user: AccessUser) => {
    if (actionLock.current.isBusy()) return;
    if (!window.confirm(`Удалить пользователя ${user.login}?`)) return;
    if (!actionLock.current.acquire()) return;
    setRequestError(null);
    setBusyId(user.id);
    try {
      await employeeRequest(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' }, { mutation: true });
      setUsers((current) => current.filter((item) => item.id !== user.id));
      showStatusRef.current('Пользователь удалён');
    } catch (error) {
      reportRequestError(error);
    } finally {
      actionLock.current.release();
      setBusyId(null);
    }
  };

  return (
    <AdminUsersView
      users={users}
      canManageSiteAdmins={canManageSiteAdmins}
      filteredUsers={filteredUsers}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      draft={draft}
      setDraft={setDraft}
      onDraftDashboardAccessChange={(dashboardAccess) => {
        draftAccessTouched.current = true;
        setDraft((current) => ({ ...current, dashboardAccess }));
      }}
      busyId={busyId}
      savedId={savedId}
      loading={loading}
      dashboardOptions={dashboardOptions}
      dashboardOptionsLoading={dashboardOptionsLoading}
      dashboardOptionsError={dashboardOptionsError}
      reloadDashboardOptions={reloadDashboardOptions}
      requestError={requestError}
      reloadUsers={loadUsers}
      passwordDrafts={passwordDrafts}
      passwordEditIds={passwordEditIds}
      setPasswordDrafts={setPasswordDrafts}
      setPasswordEditIds={setPasswordEditIds}
      createUser={createUser}
      updateUser={updateUser}
      updateUserRole={updateUserRole}
      saveUser={saveUser}
      deleteUser={deleteUser}
    />
  );
}
