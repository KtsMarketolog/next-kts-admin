'use client';

import { useCallback, useEffect, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';

type AccessUserRole = 'admin' | 'wholesale_admin' | 'manager';

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
  isCurrent: boolean;
};

type AdminUsersSectionProps = {
  showStatus: (message: string) => void;
};

type Draft = {
  name: string;
  login: string;
  email: string;
  role: AccessUserRole;
  password: string;
  isActive: boolean;
};

const EMPTY_DRAFT: Draft = {
  name: '',
  login: '',
  email: '',
  role: 'manager',
  password: '',
  isActive: true,
};

const ROLE_LABELS: Record<AccessUserRole, string> = {
  admin: 'Администратор',
  wholesale_admin: 'Админ прайсов',
  manager: 'Менеджер',
};

async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
}

export function AdminUsersSection({ showStatus }: AdminUsersSectionProps) {
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    const response = await fetch('/api/admin/users', { cache: 'no-store' });
    setLoading(false);
    if (!response.ok) {
      showStatus(await readError(response, 'Не удалось загрузить пользователей'));
      return;
    }
    const data = await response.json();
    setUsers(Array.isArray(data.users) ? data.users : []);
  }, [showStatus]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const updateUser = (id: string, patch: Partial<AccessUser>) => {
    setUsers((current) => current.map((user) => (user.id === id ? { ...user, ...patch } : user)));
  };

  const markSaved = (id: string) => {
    setSavedId(id);
    window.setTimeout(() => {
      setSavedId((current) => (current === id ? null : current));
    }, 2000);
  };

  const createUser = async () => {
    setBusyId('new');
    const response = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    setBusyId(null);

    if (!response.ok) {
      showStatus(await readError(response, 'Не удалось добавить пользователя'));
      return;
    }

    const data = await response.json();
    if (data.user) {
      setUsers((current) => [...current, data.user]);
      setDraft(EMPTY_DRAFT);
      markSaved('new');
      showStatus('Пользователь добавлен');
    }
  };

  const saveUser = async (user: AccessUser) => {
    setBusyId(user.id);
    const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...user, password: passwords[user.id] || '' }),
    });
    setBusyId(null);

    if (!response.ok) {
      showStatus(await readError(response, 'Не удалось сохранить пользователя'));
      return;
    }

    const data = await response.json();
    if (data.user) {
      setUsers((current) => current.map((item) => (item.id === user.id ? data.user : item)));
      setPasswords((current) => {
        const next = { ...current };
        delete next[user.id];
        return next;
      });
      markSaved(data.user.id);
      showStatus('Пользователь сохранён');
    }
  };

  const deleteUser = async (user: AccessUser) => {
    if (!window.confirm(`Удалить пользователя ${user.login}?`)) return;
    setBusyId(user.id);
    const response = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
    setBusyId(null);

    if (!response.ok) {
      showStatus(await readError(response, 'Не удалось удалить пользователя'));
      return;
    }

    setUsers((current) => current.filter((item) => item.id !== user.id));
    showStatus('Пользователь удалён');
  };

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <p>Доступы</p>
          <h2>Пользователи и доступы</h2>
        </div>
        <span className={styles.headingMeta}>{users.length} пользователей</span>
      </div>

      <div className={styles.userCreateCard}>
        <label>
          <span>Имя</span>
          <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
        </label>
        <label>
          <span>Логин</span>
          <input value={draft.login} onChange={(event) => setDraft((current) => ({ ...current, login: event.target.value }))} />
        </label>
        <label>
          <span>Email</span>
          <input value={draft.email} onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} />
        </label>
        <label>
          <span>Роль</span>
          <select value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value as AccessUserRole }))}>
            <option value="manager">Менеджер</option>
            <option value="wholesale_admin">Админ прайсов</option>
            <option value="admin">Администратор</option>
          </select>
        </label>
        <label>
          <span>Пароль</span>
          <input
            type="password"
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
          {savedId === 'new' ? 'Пользователь добавлен' : 'Добавить пользователя'}
        </button>
      </div>

      {loading ? (
        <p className={styles.mutedText}>Загрузка пользователей...</p>
      ) : users.length === 0 ? (
        <p className={styles.mutedText}>Пользователей пока нет</p>
      ) : (
        <div className={styles.userAccessList}>
          {users.map((user) => (
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
                    disabled={user.isCurrent}
                    onChange={(event) => updateUser(user.id, { role: event.target.value as AccessUserRole })}
                  >
                    <option value="manager">Менеджер</option>
                    <option value="wholesale_admin">Админ прайсов</option>
                    <option value="admin">Администратор</option>
                  </select>
                </label>
                <label>
                  <span>Новый пароль</span>
                  <input
                    type="password"
                    placeholder="Не менять"
                    value={passwords[user.id] || ''}
                    onChange={(event) => setPasswords((current) => ({ ...current, [user.id]: event.target.value }))}
                  />
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
                  {user.role === 'manager' && <span>Прайсов: {user.priceListCount}</span>}
                </div>
                <div className={styles.userAccessActions}>
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
          ))}
        </div>
      )}
    </section>
  );
}
