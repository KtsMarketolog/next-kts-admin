'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  moveAccessUserPassword as moveUserPassword,
  readAccessUserPasswords as readSavedPasswords,
  removeAccessUserPassword as removeUserPassword,
  saveAccessUserPassword as saveUserPassword,
} from '@/shared/lib/adminPasswordStorage';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';

import {
  ACTIVE_TAB_STORAGE_KEY,
  defaultRoleForTab,
  emptyDraftForTab,
  isUserTab,
  roleOptionsForTab,
  tabForRole,
} from './AdminUsersConfig';
import type { AccessUser, AccessUserRole, Draft, UserTab } from './AdminUsersTypes';
import { EMPTY_DRAFT } from './AdminUsersTypes';
import { AdminUsersView } from './AdminUsersView';

type AdminUsersSectionProps = {
  showStatus: (message: string) => void;
};

function readActiveTab(): UserTab {
  if (typeof window === 'undefined') return 'admin';
  const value = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
  return isUserTab(value) ? value : 'admin';
}

function saveActiveTab(tab: UserTab) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab);
}

function attachSavedPasswords(users: AccessUser[]) {
  const passwords = readSavedPasswords();
  return users.map((user) => ({ ...user, displayPassword: user.displayPassword || passwords[user.id] || '' }));
}

function isAdminAccessUser(user: AccessUser) {
  return tabForRole(user.role) === 'admin';
}

async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
}

export function AdminUsersSection({ showStatus }: AdminUsersSectionProps) {
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [activeTab, setActiveTab] = useState<UserTab>(() => readActiveTab());
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  const [passwordEditIds, setPasswordEditIds] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const showStatusRef = useRef(showStatus);

  useEffect(() => {
    showStatusRef.current = showStatus;
  }, [showStatus]);

  const activeRoleOptions = roleOptionsForTab(activeTab);
  const filteredUsers = useMemo(() => users.filter((user) => tabForRole(user.role) === activeTab), [activeTab, users]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/users', { cache: 'no-store' });
      if (!response.ok) {
        showStatusRef.current(await readError(response, 'Не удалось загрузить пользователей'));
        return;
      }
      const data = await response.json();
      const accessUsers = Array.isArray(data.users) ? data.users : [];
      setUsers(attachSavedPasswords(accessUsers.filter(isAdminAccessUser)));
    } catch {
      showStatusRef.current('Не удалось загрузить пользователей');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    saveActiveTab(activeTab);
    setDraft((current) => {
      const roleIsAllowed = roleOptionsForTab(activeTab).some((option) => option.value === current.role);
      const role = roleIsAllowed ? current.role : defaultRoleForTab(activeTab);
      return {
        ...current,
        role,
        supportManagerId: null,
      };
    });
  }, [activeTab]);

  const updateUser = (id: string, patch: Partial<AccessUser>) => {
    setUsers((current) => current.map((user) => (user.id === id ? { ...user, ...patch } : user)));
  };

  const updateUserRole = (id: string, role: AccessUserRole) => {
    updateUser(id, { role, supportManagerId: null, supportManagerName: '' });
  };

  const markSaved = (id: string) => {
    setSavedId(id);
    window.setTimeout(() => {
      setSavedId((current) => (current === id ? null : current));
    }, 2000);
  };

  const copySavedPassword = async (password?: string) => {
    if (!password) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(password);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = password;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      showStatusRef.current('Пароль скопирован');
    } catch {
      showStatusRef.current('Не удалось скопировать пароль');
    }
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
    const role = activeRoleOptions.some((option) => option.value === draft.role) ? draft.role : defaultRoleForTab(activeTab);
    const payload = {
      ...draft,
      name: draft.name.trim(),
      login: draft.login.trim(),
      email: draft.email.trim(),
      password: draft.password.trim(),
      role,
      supportManagerId: null,
    };

    if (!payload.name || !payload.login || !payload.password) {
      showStatusRef.current('Заполните имя, логин и пароль, затем сохраните пользователя');
      return;
    }
    if (!validatePasswordBeforeSave(payload.password)) return;

    setBusyId('new');
    const response = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setBusyId(null);

    if (!response.ok) {
      showStatusRef.current(await readError(response, 'Не удалось добавить пользователя'));
      return;
    }

    const data = await response.json();
    if (data.user) {
      const createdUser = { ...data.user, displayPassword: payload.password };
      saveUserPassword(createdUser.id, payload.password);
      setUsers((current) => [...current, createdUser]);
      const nextTab = tabForRole(data.user.role);
      setActiveTab(nextTab);
      setDraft(emptyDraftForTab(nextTab));
      markSaved('new');
      showStatusRef.current('Пользователь добавлен');
    }
  };

  const saveUser = async (user: AccessUser) => {
    const passwordIsEdited = Boolean(passwordEditIds[user.id]);
    const nextPassword = passwordIsEdited ? (passwordDrafts[user.id] || '').trim() : '';
    if (passwordIsEdited && !nextPassword) {
      showStatusRef.current('Введите новый пароль или нажмите «Отменить пароль»');
      return;
    }
    if (nextPassword && !validatePasswordBeforeSave(nextPassword)) return;

    setBusyId(user.id);
    const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...user, supportManagerId: null, password: nextPassword }),
    });
    setBusyId(null);

    if (!response.ok) {
      showStatusRef.current(await readError(response, 'Не удалось сохранить пользователя'));
      return;
    }

    const data = await response.json();
    if (data.user) {
      const displayPassword = nextPassword || user.displayPassword || '';
      const savedUser = { ...data.user, displayPassword };
      setUsers((current) => current.map((item) => (item.id === user.id ? savedUser : item)));
      setActiveTab(tabForRole(data.user.role));
      if (nextPassword || data.user.id !== user.id) moveUserPassword(user.id, data.user.id, displayPassword);
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
    }
  };

  const deleteUser = async (user: AccessUser) => {
    if (!window.confirm(`Удалить пользователя ${user.login}?`)) return;
    setBusyId(user.id);
    const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
    setBusyId(null);

    if (!response.ok) {
      showStatusRef.current(await readError(response, 'Не удалось удалить пользователя'));
      return;
    }

    setUsers((current) => current.filter((item) => item.id !== user.id));
    removeUserPassword(user.id);
    showStatusRef.current('Пользователь удалён');
  };

  return (
    <AdminUsersView
      users={users}
      filteredUsers={filteredUsers}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      draft={draft}
      setDraft={setDraft}
      busyId={busyId}
      savedId={savedId}
      loading={loading}
      passwordDrafts={passwordDrafts}
      passwordEditIds={passwordEditIds}
      setPasswordDrafts={setPasswordDrafts}
      setPasswordEditIds={setPasswordEditIds}
      createUser={createUser}
      updateUser={updateUser}
      updateUserRole={updateUserRole}
      copySavedPassword={copySavedPassword}
      saveUser={saveUser}
      deleteUser={deleteUser}
    />
  );
}
