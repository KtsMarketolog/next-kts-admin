import Link from 'next/link';

import styles from '@/app/admin/admin.module.scss';

import { AdminClientManagerSelect } from './AdminClientManagerSelect';
import type { ClientCompany, ClientDraft, Manager } from './AdminClientsModel';

type AdminClientCompanyCardProps = {
  company: ClientCompany;
  currentDraft: ClientDraft;
  displayPassword: string;
  passwordIsEdited: boolean;
  passwordDraft: string;
  developmentManagers: Manager[];
  supportManagers: Manager[];
  busy: boolean;
  isExpanded: boolean;
  isSaved: boolean;
  onDraftChange: (id: number, patch: Partial<ClientDraft>) => void;
  onCopyPassword: (password?: string) => void;
  onToggleExpanded: (id: number) => void;
  onTogglePasswordEdit: (id: number) => void;
  onPasswordDraftChange: (id: number, value: string) => void;
  onSave: (id: number) => void;
  onDelete: (company: ClientCompany) => void;
};

export function AdminClientCompanyCard({
  company,
  currentDraft,
  displayPassword,
  passwordIsEdited,
  passwordDraft,
  developmentManagers,
  supportManagers,
  busy,
  isExpanded,
  isSaved,
  onDraftChange,
  onCopyPassword,
  onToggleExpanded,
  onTogglePasswordEdit,
  onPasswordDraftChange,
  onSave,
  onDelete,
}: AdminClientCompanyCardProps) {
  return (
    <article className={styles.clientCompanyCard}>
      <div className={styles.clientCompanyHeader}>
        <div>
          <p>{company.isActive ? 'Активный клиент' : 'Отключен'}</p>
          <h3>{company.title || 'Без названия'}</h3>
        </div>
        <div className={styles.clientCompanyMeta}>
          {company.chatUnreadCount > 0 ? (
            <Link className={styles.clientUnreadMeta} href={`/admin/clients/${company.id}?tab=chat`}>
              Новые сообщения: {company.chatUnreadCount}
            </Link>
          ) : null}
          <span>Пользователей ЛК: {company.userCount}</span>
          <span>{company.clientLogin ? `Логин: ${company.clientLogin}` : 'Логин: email клиента'}</span>
          <span>{company.managerName ? `Менеджер: ${company.managerName}` : 'Менеджер не выбран'}</span>
          <span>{company.supportManagerName ? `Сопровождение: ${company.supportManagerName}` : 'Сопровождение не выбрано'}</span>
          {company.requireTwoFactor ? <span>Код на email при входе</span> : null}
        </div>
        <button className={styles.clientCompanyToggle} type="button" onClick={() => onToggleExpanded(company.id)}>
          {isExpanded ? 'Скрыть' : 'Раскрыть'}
        </button>
      </div>

      {isExpanded ? (
        <>
          <div className={styles.clientCompanyGrid}>
            <label>
              <span>Компания</span>
              <input value={currentDraft.title} onChange={(event) => onDraftChange(company.id, { title: event.target.value })} />
            </label>
            <label>
              <span>Email</span>
              <input value={currentDraft.email} onChange={(event) => onDraftChange(company.id, { email: event.target.value })} />
            </label>
            <label>
              <span>Телефон</span>
              <input value={currentDraft.phone} onChange={(event) => onDraftChange(company.id, { phone: event.target.value })} />
            </label>
            <label className={styles.clientWideField}>
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
                  onClick={() => onCopyPassword(displayPassword)}
                />
                <button
                  className={styles.userPasswordCopyButton}
                  type="button"
                  disabled={!displayPassword}
                  title="Скопировать пароль"
                  onClick={() => onCopyPassword(displayPassword)}
                >
                  Скопировать
                </button>
              </div>
              {!displayPassword && !passwordIsEdited ? (
                <small className={styles.passwordPolicyHint}>Нажмите «Задать пароль», чтобы клиент мог войти в кабинет.</small>
              ) : null}
              {passwordIsEdited && (
                <>
                  <input
                    className={styles.userPasswordEditInput}
                    type="password"
                    autoComplete="new-password"
                    placeholder="Введите новый пароль"
                    value={passwordDraft}
                    onChange={(event) => onPasswordDraftChange(company.id, event.target.value)}
                  />
                  <small className={styles.passwordPolicyHint}>Минимум 10 символов, обязательно буквы и цифры</small>
                </>
              )}
            </label>
            <label>
              <span>Менеджер</span>
              <AdminClientManagerSelect
                value={currentDraft.managerId}
                onChange={(managerId) => onDraftChange(company.id, { managerId })}
                options={developmentManagers}
                placeholder="Не выбран"
              />
            </label>
            <label>
              <span>Сопровождение</span>
              <AdminClientManagerSelect
                value={currentDraft.supportManagerId}
                onChange={(supportManagerId) => onDraftChange(company.id, { supportManagerId })}
                options={supportManagers}
                placeholder="Не выбрано"
              />
            </label>
            <label className={styles.clientWideField}>
              <span>Заметка</span>
              <textarea value={currentDraft.note} onChange={(event) => onDraftChange(company.id, { note: event.target.value })} />
            </label>
          </div>

          <div className={styles.clientCompanyActions}>
            <label className={styles.checkbox}>
              <input type="checkbox" checked={currentDraft.isActive} onChange={(event) => onDraftChange(company.id, { isActive: event.target.checked })} />
              Активна
            </label>
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={currentDraft.requireTwoFactor}
                onChange={(event) => onDraftChange(company.id, { requireTwoFactor: event.target.checked })}
              />
              Требовать код на email при входе
            </label>
            <Link className={styles.clientOpenLink} href={`/admin/clients/${company.id}`}>
              Перейти
            </Link>
            <button className={styles.secondary} type="button" disabled={busy} onClick={() => onTogglePasswordEdit(company.id)}>
              {passwordIsEdited ? 'Отменить пароль' : displayPassword ? 'Изменить пароль' : 'Задать пароль'}
            </button>
            <button className={isSaved ? styles.savedButton : ''} disabled={busy} onClick={() => onSave(company.id)}>
              {isSaved ? 'Сохранено' : 'Сохранить'}
            </button>
            <button className={styles.danger} type="button" disabled={busy} onClick={() => onDelete(company)}>
              Удалить
            </button>
          </div>
        </>
      ) : null}
    </article>
  );
}
