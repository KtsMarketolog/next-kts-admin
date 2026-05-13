'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';

type AccessUserRole = 'admin' | 'wholesale_admin' | 'manager' | 'support_manager';
type UserTab = 'admin' | 'manager' | 'support_manager';

type AccessUser = {
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

type AdminUsersSectionProps = {
  showStatus: (message: string) => void;
};

type Draft = {
  name: string;
  login: string;
  email: string;
  role: AccessUserRole;
  supportManagerId: number | null;
  password: string;
  isActive: boolean;
};

const EMPTY_DRAFT: Draft = {
  name: '',
  login: '',
  email: '',
  role: 'manager',
  supportManagerId: null,
  password: '',
  isActive: true,
};

const ACTIVE_TAB_STORAGE_KEY = 'kts-admin-users-active-tab';
const SAVED_PASSWORDS_STORAGE_KEY = 'kts-admin-users-passwords-v1';

function isUserTab(value: string | null): value is UserTab {
  return value === 'admin' || value === 'manager' || value === 'support_manager';
}

function readActiveTab(): UserTab {
  if (typeof window === 'undefined') return 'admin';
  const value = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
  return isUserTab(value) ? value : 'admin';
}

function saveActiveTab(tab: UserTab) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, tab);
}

function readSavedPasswords() {
  if (typeof window === 'undefined') return {} as Record<string, string>;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SAVED_PASSWORDS_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {} as Record<string, string>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'),
    );
  } catch {
    return {} as Record<string, string>;
  }
}

function writeSavedPasswords(passwords: Record<string, string>) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SAVED_PASSWORDS_STORAGE_KEY, JSON.stringify(passwords));
}

function saveUserPassword(userId: string, password: string) {
  const passwords = readSavedPasswords();
  passwords[userId] = password;
  writeSavedPasswords(passwords);
}

function moveUserPassword(previousId: string, nextId: string, password: string) {
  const passwords = readSavedPasswords();
  delete passwords[previousId];
  if (password) passwords[nextId] = password;
  writeSavedPasswords(passwords);
}

function removeUserPassword(userId: string) {
  const passwords = readSavedPasswords();
  delete passwords[userId];
  writeSavedPasswords(passwords);
}

function attachSavedPasswords(users: AccessUser[]) {
  const passwords = readSavedPasswords();
  return users.map((user) => ({ ...user, displayPassword: user.displayPassword || passwords[user.id] || '' }));
}

const ROLE_LABELS: Record<AccessUserRole, string> = {
  admin: 'Администратор',
  wholesale_admin: 'Админ прайсов',
  manager: 'Менеджер по развитию',
  support_manager: 'Менеджер по сопровождению',
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

const USER_TABS: Array<{ value: UserTab; label: string }> = [
  { value: 'admin', label: 'Админ' },
  { value: 'manager', label: 'Менеджер по развитию' },
  { value: 'support_manager', label: 'Менеджер по сопровождению' },
];

function tabForRole(role: AccessUserRole): UserTab {
  if (role === 'support_manager') return 'support_manager';
  if (role === 'manager') return 'manager';
  return 'admin';
}

function roleOptionsForTab(tab: UserTab) {
  if (tab === 'manager') return MANAGER_ROLE_OPTIONS;
  if (tab === 'support_manager') return SUPPORT_MANAGER_ROLE_OPTIONS;
  return ADMIN_ROLE_OPTIONS;
}

function defaultRoleForTab(tab: UserTab): AccessUserRole {
  if (tab === 'manager') return 'manager';
  if (tab === 'support_manager') return 'support_manager';
  return 'admin';
}

function emptyDraftForTab(tab: UserTab): Draft {
  return {
    ...EMPTY_DRAFT,
    role: defaultRoleForTab(tab),
    supportManagerId: tab === 'manager' ? EMPTY_DRAFT.supportManagerId : null,
  };
}

function addButtonLabel(tab: UserTab) {
  if (tab === 'manager') return 'Добавить менеджера по развитию';
  if (tab === 'support_manager') return 'Добавить менеджера по сопровождению';
  return 'Добавить пользователя';
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

  const supportManagers = useMemo(
    () =>
      users
        .filter((user) => user.role === 'support_manager')
        .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name, 'ru')),
    [users],
  );
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
      setUsers(attachSavedPasswords(Array.isArray(data.users) ? data.users : []));
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
        supportManagerId: role === 'manager' ? current.supportManagerId : null,
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
      supportManagerId: role === 'manager' ? draft.supportManagerId : null,
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
      body: JSON.stringify({ ...user, password: nextPassword }),
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

  const supportManagerSelect = (
    value: number | null,
    onChange: (value: number | null) => void,
    disabled: boolean,
  ) => (
    <select value={value ?? ''} disabled={disabled || supportManagers.length === 0} onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}>
      <option value="">Не выбран</option>
      {supportManagers.map((manager) => (
        <option key={manager.id} value={manager.numericId}>
          {manager.name || manager.login}
        </option>
      ))}
    </select>
  );

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <p>Доступы</p>
          <h2>Пользователи и доступы</h2>
        </div>
        <span className={styles.headingMeta}>{filteredUsers.length} из {users.length}</span>
      </div>

      <div className={styles.userRoleTabs}>
        {USER_TABS.map((tab) => (
          <button key={tab.value} type="button" aria-pressed={activeTab === tab.value} onClick={() => setActiveTab(tab.value)}>
            {tab.label}
          </button>
        ))}
      </div>

      <div className={styles.userCreateCard}>
        <div className={styles.autofillGuard} aria-hidden="true">
          <input tabIndex={-1} autoComplete="username" />
          <input tabIndex={-1} type="password" autoComplete="current-password" />
        </div>
        <label>
          <span>Имя</span>
          <input
            name={`new-${activeTab}-name`}
            autoComplete="off"
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </label>
        <label>
          <span>Логин</span>
          <input
            name={`new-${activeTab}-login`}
            autoComplete="off"
            value={draft.login}
            onChange={(event) => setDraft((current) => ({ ...current, login: event.target.value }))}
          />
        </label>
        <label>
          <span>Email</span>
          <input
            name={`new-${activeTab}-email`}
            autoComplete="new-password"
            value={draft.email}
            onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))}
          />
        </label>
        <label>
          <span>Роль</span>
          <select
            value={draft.role}
            disabled={activeRoleOptions.length === 1}
            onChange={(event) => {
              const role = event.target.value as AccessUserRole;
              setDraft((current) => ({ ...current, role, supportManagerId: role === 'manager' ? current.supportManagerId : null }));
            }}
          >
            {activeRoleOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {activeTab === 'manager' && (
          <label>
            <span>Менеджер по сопровождению</span>
            {supportManagerSelect(draft.supportManagerId, (supportManagerId) => setDraft((current) => ({ ...current, supportManagerId })), false)}
          </label>
        )}
        <label className={activeTab === 'manager' ? undefined : styles.userPasswordWide}>
          <span>Пароль</span>
          <input
            name={`new-${activeTab}-password`}
            type="password"
            autoComplete="new-password"
            value={draft.password}
            onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))}
          />
        </label>
        <label className={styles.userActiveToggle}>
          <input
            type="checkbox"
            checked={draft.isActive}
            onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))}
          />
          Активен
        </label>
        <button className={savedId === 'new' ? styles.savedButton : undefined} disabled={busyId === 'new'} onClick={createUser}>
          {savedId === 'new' ? 'Сохранено' : addButtonLabel(activeTab)}
        </button>
      </div>

      {loading ? (
        <p className={styles.mutedText}>Загрузка пользователей...</p>
      ) : filteredUsers.length === 0 ? (
        <p className={styles.mutedText}>В этой вкладке пока нет пользователей</p>
      ) : (
        <div className={styles.userAccessList}>
          {filteredUsers.map((user) => {
            const passwordIsEdited = Boolean(passwordEditIds[user.id]);
            const displayPassword = user.displayPassword || '';

            return (
            <article className={styles.userAccessCard} key={user.id}>
              <div className={styles.userAccessFields}>
                <label>
                  <span>Имя</span>
                  <input value={user.name} onChange={(event) => updateUser(user.id, { name: event.target.value })} />
                </label>
                <label>
                  <span>Логин</span>
                  <input value={user.login} onChange={(event) => updateUser(user.id, { login: event.target.value })} />
                </label>
                <label>
                  <span>Email</span>
                  <input value={user.email} onChange={(event) => updateUser(user.id, { email: event.target.value })} />
                </label>
                <label>
                  <span>Роль</span>
                  <select
                    value={user.role}
                    disabled={user.isCurrent || roleOptionsForTab(activeTab).length === 1}
                    onChange={(event) => updateUserRole(user.id, event.target.value as AccessUserRole)}
                  >
                    {roleOptionsForTab(activeTab).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                {user.role === 'manager' && (
                  <label>
                    <span>Менеджер по сопровождению</span>
                    {supportManagerSelect(user.supportManagerId, (supportManagerId) => updateUser(user.id, { supportManagerId }), false)}
                  </label>
                )}
                <label className={user.role === 'manager' ? undefined : styles.userPasswordWide}>
                  <span>Пароль</span>
                  <div className={styles.userPasswordCopyField}>
                    <input
                      className={styles.userPasswordCopyInput}
                      type="text"
                      autoComplete="new-password"
                      spellCheck={false}
                      readOnly
                      placeholder="Пароль не сохранён"
                      value={displayPassword}
                      onClick={() => copySavedPassword(displayPassword)}
                    />
                    <button
                      className={styles.userPasswordCopyButton}
                      type="button"
                      disabled={!displayPassword}
                      title="Скопировать пароль"
                      onClick={() => copySavedPassword(displayPassword)}
                    >
                      Скопировать
                    </button>
                  </div>
                  {passwordIsEdited && (
                    <input
                      className={styles.userPasswordEditInput}
                      type="password"
                      autoComplete="new-password"
                      placeholder="Введите новый пароль"
                      value={passwordDrafts[user.id] || ''}
                      onChange={(event) => setPasswordDrafts((current) => ({ ...current, [user.id]: event.target.value }))}
                    />
                  )}
                </label>
              </div>

              <div className={styles.userAccessMeta}>
                <label className={styles.userActiveToggle}>
                  <input
                    type="checkbox"
                    checked={user.isActive}
                    disabled={user.isCurrent}
                    onChange={(event) => updateUser(user.id, { isActive: event.target.checked })}
                  />
                  Активен
                </label>
                <div className={styles.userAccessBadges}>
                  {user.isCurrent && <span className={styles.userCurrentBadge}>Это вы</span>}
                  <span>{ROLE_LABELS[user.role]}</span>
                  {user.accesses.map((access) => (
                    <span key={access}>{access}</span>
                  ))}
                  {user.role === 'manager' && user.supportManagerName && <span>Сопровождение: {user.supportManagerName}</span>}
                  {(user.role === 'manager' || user.role === 'support_manager') && <span>Прайсов: {user.priceListCount}</span>}
                </div>
                <div className={styles.userAccessActions}>
                  <button
                    className={styles.secondary}
                    type="button"
                    disabled={busyId === user.id}
                    onClick={() => {
                      setPasswordEditIds((current) => ({ ...current, [user.id]: !current[user.id] }));
                      setPasswordDrafts((current) => {
                        const next = { ...current };
                        delete next[user.id];
                        return next;
                      });
                    }}
                  >
                    {passwordIsEdited ? 'Отменить пароль' : 'Изменить пароль'}
                  </button>
                  <button
                    className={savedId === user.id ? styles.savedButton : undefined}
                    disabled={busyId === user.id}
                    onClick={() => saveUser(user)}
                  >
                    {savedId === user.id ? 'Сохранено' : 'Сохранить'}
                  </button>
                  <button className={styles.danger} disabled={busyId === user.id || user.isCurrent} onClick={() => deleteUser(user)}>
                    Удалить
                  </button>
                </div>
              </div>
            </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
