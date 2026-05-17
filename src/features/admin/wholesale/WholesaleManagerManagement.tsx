'use client';

import type { Dispatch, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';

import {
  MANAGER_ROLE_TABS,
  emptyManager,
  saveManagerRoleTab,
  type Manager,
  type ManagerDraft,
  type ManagerRole,
} from './AdminWholesaleModel';

type RouterLike = {
  push: (href: string) => void;
};

type WholesaleManagerManagementProps = {
  managerRoleTab: ManagerRole;
  managerDraft: ManagerDraft;
  managerRoleTitle: string;
  managerRoleLabel: string;
  supportManagers: Manager[];
  managerRoleRows: Manager[];
  managerPasswordEditIds: Record<number, boolean>;
  managerPasswordDrafts: Record<number, string>;
  busy: boolean;
  managerCreated: boolean;
  savedManagerId: number | null;
  router: RouterLike;
  setManagerRoleTab: (role: ManagerRole) => void;
  setManagerCreated: (value: boolean) => void;
  setManagerDraft: Dispatch<SetStateAction<ManagerDraft>>;
  setManagers: Dispatch<SetStateAction<Manager[]>>;
  setManagerPasswordDrafts: Dispatch<SetStateAction<Record<number, string>>>;
  setManagerPasswordEditIds: Dispatch<SetStateAction<Record<number, boolean>>>;
  createManager: () => Promise<void>;
  copyManagerPassword: (password?: string) => Promise<void>;
  saveManager: (manager: Manager) => Promise<void>;
  deleteManager: (id: number) => Promise<void>;
};

export function WholesaleManagerManagement({
  managerRoleTab,
  managerDraft,
  managerRoleTitle,
  managerRoleLabel,
  supportManagers,
  managerRoleRows,
  managerPasswordEditIds,
  managerPasswordDrafts,
  busy,
  managerCreated,
  savedManagerId,
  router,
  setManagerRoleTab,
  setManagerCreated,
  setManagerDraft,
  setManagers,
  setManagerPasswordDrafts,
  setManagerPasswordEditIds,
  createManager,
  copyManagerPassword,
  saveManager,
  deleteManager,
}: WholesaleManagerManagementProps) {
  return (
          <div className={styles.wholesaleManagersAdminBlock}>

        <div className={styles.userRoleTabs}>
          {MANAGER_ROLE_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              aria-pressed={managerRoleTab === tab.value}
              onClick={() => {
                setManagerRoleTab(tab.value);
                saveManagerRoleTab(tab.value);
                setManagerCreated(false);
                setManagerDraft(emptyManager);
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className={`${styles.userCreateCard} ${managerRoleTab === 'support_manager' ? styles.userSupportManagerLayout : ''}`}>
          <div className={styles.autofillGuard} aria-hidden="true">
            <input tabIndex={-1} autoComplete="username" />
            <input tabIndex={-1} type="password" autoComplete="current-password" />
          </div>
          <label>
            <span>Имя</span>
            <input value={managerDraft.name} onChange={(event) => setManagerDraft({ ...managerDraft, name: event.target.value })} autoComplete="off" />
          </label>
          <label>
            <span>Логин</span>
            <input value={managerDraft.login} onChange={(event) => setManagerDraft({ ...managerDraft, login: event.target.value })} autoComplete="new-password" />
          </label>
          <label>
            <span>Email</span>
            <input value={managerDraft.email} onChange={(event) => setManagerDraft({ ...managerDraft, email: event.target.value })} autoComplete="new-password" />
          </label>
          <label>
            <span>Роль</span>
            <select value={managerRoleTab} disabled>
              <option value={managerRoleTab}>{managerRoleTitle}</option>
            </select>
          </label>
          {managerRoleTab === 'manager' && (
            <label>
              <span>Менеджер по сопровождению</span>
              <select
                value={managerDraft.supportManagerId ?? ''}
                disabled={supportManagers.length === 0}
                onChange={(event) => setManagerDraft({ ...managerDraft, supportManagerId: event.target.value ? Number(event.target.value) : null })}
              >
                <option value="">Не выбран</option>
                {supportManagers.map((manager) => (
                  <option key={manager.id} value={manager.id}>
                    {manager.name || manager.login}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className={managerRoleTab === 'manager' ? undefined : styles.userPasswordWide}>
            <span>Пароль</span>
            <input type="password" value={managerDraft.password} onChange={(event) => setManagerDraft({ ...managerDraft, password: event.target.value })} autoComplete="new-password" />
            <small className={styles.passwordPolicyHint}>Минимум 10 символов, обязательно буквы и цифры</small>
          </label>
          <label className={styles.userActiveToggle}>
            <input type="checkbox" checked={managerDraft.isActive} onChange={(event) => setManagerDraft({ ...managerDraft, isActive: event.target.checked })} />
            Активен
          </label>
          <button className={managerCreated ? styles.savedButton : undefined} disabled={busy} onClick={createManager}>
            {managerCreated ? 'Сохранено' : `Добавить ${managerRoleLabel}`}
          </button>
        </div>

        <h3>{managerRoleTab === 'manager' ? 'Менеджеры и статистика' : 'Менеджеры по сопровождению'}</h3>
        {managerRoleTab === 'manager' ? (
          <div className={styles.managerCards}>
          {managerRoleRows.map((manager) => {
            const passwordIsEdited = Boolean(managerPasswordEditIds[manager.id]);
            const displayPassword = manager.displayPassword || '';
            const availableSupportManagers = supportManagers.filter((supportManager) => supportManager.id !== manager.id);

            return (
            <article className={styles.managerCard} key={manager.id}>
              <div className={styles.managerFields}>
                <label>
                  <span>Имя</span>
                  <input value={manager.name} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, name: event.target.value } : item))} />
                </label>
                <label>
                  <span>Логин</span>
                  <input value={manager.login} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, login: event.target.value } : item))} />
                </label>
                <label>
                  <span>Email</span>
                  <input value={manager.email} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, email: event.target.value } : item))} />
                </label>
                <label>
                  <span>Телефон</span>
                  <input value={manager.phone} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, phone: event.target.value } : item))} />
                </label>
                <label>
                  <span>Роль</span>
                  <select value={manager.role} disabled>
                    <option value="manager">Менеджер по развитию</option>
                  </select>
                </label>
                <label>
                  <span>Менеджер по сопровождению</span>
                  <select
                    value={manager.supportManagerId ?? ''}
                    disabled={manager.role !== 'manager' || availableSupportManagers.length === 0}
                    onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, supportManagerId: event.target.value ? Number(event.target.value) : null } : item))}
                  >
                    <option value="">{manager.role === 'manager' ? 'Не выбран' : 'Не назначается'}</option>
                    {availableSupportManagers.map((supportManager) => (
                      <option key={supportManager.id} value={supportManager.id}>
                        {supportManager.name || supportManager.login}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.managerPasswordField}>
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
                      onClick={() => copyManagerPassword(displayPassword)}
                    />
                    <button
                      className={styles.userPasswordCopyButton}
                      type="button"
                      disabled={!displayPassword}
                      title="Скопировать пароль"
                      onClick={() => copyManagerPassword(displayPassword)}
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
                        value={managerPasswordDrafts[manager.id] || ''}
                        onChange={(event) => setManagerPasswordDrafts((current) => ({ ...current, [manager.id]: event.target.value }))}
                      />
                      <small className={styles.passwordPolicyHint}>Минимум 10 символов, обязательно буквы и цифры</small>
                    </>
                  )}
                </label>
              </div>
              <div className={styles.managerControls}>
                <button
                  className={styles.managerMetric}
                  type="button"
                  onClick={() => router.push(`/admin/wholesale/admin/managers/${manager.id}`)}
                >
                  <span>Прайсов</span>
                  <strong>{manager.priceListCount}</strong>
                </button>
                <label className={styles.managerActive}>
                  <input type="checkbox" checked={manager.isActive} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, isActive: event.target.checked } : item))} />
                  <span>Активен</span>
                </label>
                <div className={styles.managerActions}>
                  <button
                    className={styles.secondary}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setManagerPasswordEditIds((current) => ({ ...current, [manager.id]: !current[manager.id] }));
                      setManagerPasswordDrafts((current) => {
                        const next = { ...current };
                        delete next[manager.id];
                        return next;
                      });
                    }}
                  >
                    {passwordIsEdited ? 'Отменить пароль' : 'Изменить пароль'}
                  </button>
                  <button
                    className={styles.secondary}
                    type="button"
                    onClick={() => router.push(`/admin/wholesale/admin/managers/${manager.id}/analytics`)}
                  >
                    Аналитика
                  </button>
                  <button
                    className={styles.secondary}
                    type="button"
                    onClick={() => router.push(`/admin/wholesale/admin/managers/${manager.id}`)}
                  >
                    Прайсы
                  </button>
                  <button
                    className={savedManagerId === manager.id ? styles.savedButton : undefined}
                    disabled={busy}
                    onClick={() => saveManager(manager)}
                  >
                    {savedManagerId === manager.id ? 'Сохранено' : 'Сохранить'}
                  </button>
                  <button className={styles.danger} disabled={busy} onClick={() => deleteManager(manager.id)}>Удалить</button>
                </div>
              </div>
            </article>
            );
          })}
          {managerRoleRows.length === 0 ? <p className={styles.mutedText}>Менеджеров по развитию пока нет</p> : null}
        </div>
        ) : (
          <div className={styles.userAccessList}>
            {managerRoleRows.map((manager) => {
              const passwordIsEdited = Boolean(managerPasswordEditIds[manager.id]);
              const displayPassword = manager.displayPassword || '';

              return (
                <article className={styles.userAccessCard} key={manager.id}>
                  <div className={`${styles.userAccessFields} ${managerRoleTab === 'support_manager' ? styles.userSupportManagerLayout : ''}`}>
                    <label>
                      <span>Имя</span>
                      <input value={manager.name} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, name: event.target.value } : item))} />
                    </label>
                    <label>
                      <span>Логин</span>
                      <input value={manager.login} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, login: event.target.value } : item))} />
                    </label>
                    <label>
                      <span>Email</span>
                      <input value={manager.email} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, email: event.target.value } : item))} />
                    </label>
                    <label>
                      <span>Роль</span>
                      <select value={manager.role} disabled>
                        <option value="support_manager">Менеджер по сопровождению</option>
                      </select>
                    </label>
                    <label className={styles.userPasswordWide}>
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
                          onClick={() => copyManagerPassword(displayPassword)}
                        />
                        <button
                          className={styles.userPasswordCopyButton}
                          type="button"
                          disabled={!displayPassword}
                          title="Скопировать пароль"
                          onClick={() => copyManagerPassword(displayPassword)}
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
                            value={managerPasswordDrafts[manager.id] || ''}
                            onChange={(event) => setManagerPasswordDrafts((current) => ({ ...current, [manager.id]: event.target.value }))}
                          />
                          <small className={styles.passwordPolicyHint}>Минимум 10 символов, обязательно буквы и цифры</small>
                        </>
                      )}
                    </label>
                  </div>
                  <div className={styles.userAccessMeta}>
                    <label className={styles.userActiveToggle}>
                      <input type="checkbox" checked={manager.isActive} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, isActive: event.target.checked } : item))} />
                      Активен
                    </label>
                    <div className={styles.userAccessBadges}>
                      <span>Менеджер по сопровождению</span>
                      <span>Прайсов: {manager.priceListCount}</span>
                    </div>
                    <div className={styles.userAccessActions}>
                      <button
                        className={styles.secondary}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setManagerPasswordEditIds((current) => ({ ...current, [manager.id]: !current[manager.id] }));
                          setManagerPasswordDrafts((current) => {
                            const next = { ...current };
                            delete next[manager.id];
                            return next;
                          });
                        }}
                      >
                        {passwordIsEdited ? 'Отменить пароль' : 'Изменить пароль'}
                      </button>
                      <button
                        className={savedManagerId === manager.id ? styles.savedButton : undefined}
                        disabled={busy}
                        onClick={() => saveManager(manager)}
                      >
                        {savedManagerId === manager.id ? 'Сохранено' : 'Сохранить'}
                      </button>
                      <button className={styles.danger} disabled={busy} onClick={() => deleteManager(manager.id)}>Удалить</button>
                    </div>
                  </div>
                </article>
              );
            })}
            {managerRoleRows.length === 0 ? <p className={styles.mutedText}>Менеджеров по сопровождению пока нет</p> : null}
          </div>
        )}
          </div>

  );
}
