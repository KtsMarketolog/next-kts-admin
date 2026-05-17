import type { Dispatch, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';

import { ROLE_LABELS, USER_TABS, addButtonLabel, roleOptionsForTab } from './AdminUsersConfig';
import type { AccessUser, AccessUserRole, Draft, UserTab } from './AdminUsersTypes';

type AdminUsersViewProps = {
  users: AccessUser[];
  filteredUsers: AccessUser[];
  supportManagers: AccessUser[];
  activeTab: UserTab;
  setActiveTab: (tab: UserTab) => void;
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
  busyId: string | null;
  savedId: string | null;
  loading: boolean;
  passwordDrafts: Record<string, string>;
  passwordEditIds: Record<string, boolean>;
  setPasswordDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  setPasswordEditIds: Dispatch<SetStateAction<Record<string, boolean>>>;
  createUser: () => Promise<void>;
  updateUser: (id: string, patch: Partial<AccessUser>) => void;
  updateUserRole: (id: string, role: AccessUserRole) => void;
  copySavedPassword: (password?: string) => Promise<void>;
  saveUser: (user: AccessUser) => Promise<void>;
  deleteUser: (user: AccessUser) => Promise<void>;
};

export function AdminUsersView({
  users,
  filteredUsers,
  supportManagers,
  activeTab,
  setActiveTab,
  draft,
  setDraft,
  busyId,
  savedId,
  loading,
  passwordDrafts,
  passwordEditIds,
  setPasswordDrafts,
  setPasswordEditIds,
  createUser,
  updateUser,
  updateUserRole,
  copySavedPassword,
  saveUser,
  deleteUser,
}: AdminUsersViewProps) {
  const activeRoleOptions = roleOptionsForTab(activeTab);
  const supportManagerSelect = (value: number | null, onChange: (value: number | null) => void, disabled: boolean) => (
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

      <div className={`${styles.userCreateCard} ${activeTab === 'support_manager' ? styles.userSupportManagerLayout : ''}`}>
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
          <small className={styles.passwordPolicyHint}>Минимум 10 символов, обязательно буквы и цифры</small>
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
                <div className={`${styles.userAccessFields} ${activeTab === 'support_manager' ? styles.userSupportManagerLayout : ''}`}>
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
                      <>
                        <input
                          className={styles.userPasswordEditInput}
                          type="password"
                          autoComplete="new-password"
                          placeholder="Введите новый пароль"
                          value={passwordDrafts[user.id] || ''}
                          onChange={(event) => setPasswordDrafts((current) => ({ ...current, [user.id]: event.target.value }))}
                        />
                        <small className={styles.passwordPolicyHint}>Минимум 10 символов, обязательно буквы и цифры</small>
                      </>
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

