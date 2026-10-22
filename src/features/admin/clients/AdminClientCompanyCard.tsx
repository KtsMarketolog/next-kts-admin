import Link from 'next/link';

import styles from '@/app/admin/admin.module.scss';
import { EmployeePasswordField } from '../shared/EmployeePasswordField';
import passwordStyles from './ClientPasswordField.module.scss';

import { AdminClientManagerSelect } from './AdminClientManagerSelect';
import { AdminClientConflictPanel } from './AdminClientConflictPanel';
import type { ClientConflictComparison, ClientEditableField } from './clientConflict';
import type { ClientCompany, ClientDraft, Manager } from './AdminClientsModel';

type AdminClientCompanyCardProps = {
  company: ClientCompany;
  currentDraft: ClientDraft;
  passwordIsEdited: boolean;
  passwordDraft: string;
  developmentManagers: Manager[];
  supportManagers: Manager[];
  busy: boolean;
  isExpanded: boolean;
  isSaved: boolean;
  canPermanentlyDelete: boolean;
  conflict: { comparison: ClientConflictComparison | null; error: string } | null;
  managers: Manager[];
  onLoadConflict: (id: number) => void;
  onCloseConflict: (id: number) => void;
  onResolveConflict: (id: number, fields: ClientEditableField[], discardAll?: boolean) => void;
  onDraftChange: (id: number, patch: Partial<ClientDraft>) => void;
  onToggleExpanded: (id: number) => void;
  onTogglePasswordEdit: (id: number) => void;
  onPasswordDraftChange: (id: number, value: string) => void;
  onSave: (id: number) => void;
  onArchive: (company: ClientCompany) => void;
  onRestore: (company: ClientCompany) => void;
  onPermanentDelete: (company: ClientCompany) => void;
};

export function AdminClientCompanyCard({
  company,
  currentDraft,
  passwordIsEdited,
  passwordDraft,
  developmentManagers,
  supportManagers,
  busy,
  isExpanded,
  isSaved,
  canPermanentlyDelete,
  conflict,
  managers,
  onLoadConflict,
  onCloseConflict,
  onResolveConflict,
  onDraftChange,
  onToggleExpanded,
  onTogglePasswordEdit,
  onPasswordDraftChange,
  onSave,
  onArchive,
  onRestore,
  onPermanentDelete,
}: AdminClientCompanyCardProps) {
  if (company.archivedAt) {
    return (
      <article className={styles.clientCompanyCard}>
        <div className={styles.clientCompanyHeader}>
          <div>
            <p>В архиве · {new Date(company.archivedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК</p>
            <h3>{company.title || 'Без названия'}</h3>
          </div>
          <div className={styles.clientCompanyMeta}>
            <span>{company.email || 'Email не указан'}</span>
            <span>{company.managerName ? `Менеджер: ${company.managerName}` : 'Менеджер не выбран'}</span>
            <span>Вход в кабинет закрыт. Данные и файлы сохранены.</span>
          </div>
        </div>
        <div className={styles.clientCompanyActions}>
          <Link className={styles.clientOpenLink} href={`/admin/clients/${company.id}`}>Открыть архив клиента</Link>
          <button className={styles.secondary} type="button" disabled={busy} onClick={() => onRestore(company)}>Восстановить</button>
          {canPermanentlyDelete ? <button className={styles.danger} type="button" disabled={busy} onClick={() => onPermanentDelete(company)}>Удалить навсегда</button> : null}
        </div>
      </article>
    );
  }
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

      {conflict ? <AdminClientConflictPanel
        comparison={conflict.comparison}
        busy={busy}
        error={conflict.error}
        passwordPending={passwordIsEdited}
        managers={managers}
        onLoad={() => onLoadConflict(company.id)}
        onCancel={() => onCloseConflict(company.id)}
        onResolve={(fields) => onResolveConflict(company.id, fields)}
        onReload={() => onResolveConflict(company.id, [], true)}
      /> : null}

      {isExpanded ? (
        <fieldset disabled={busy || Boolean(conflict?.comparison)} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
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
            <div className={`${styles.clientWideField} ${passwordStyles.field}`}>
              <span>Пароль</span>
              {company.clientUserId ? <EmployeePasswordField
                endpoint={`/api/admin/clients/${company.id}/password`}
                disabled={busy || passwordIsEdited}
                resetKey={company}
              /> : null}
              {!company.clientUserId && !passwordIsEdited ? (
                <small className={styles.passwordPolicyHint}>Нажмите «Задать пароль», чтобы клиент мог войти в кабинет.</small>
              ) : null}
              {passwordIsEdited && (
                <>
                  <input
                    className={styles.userPasswordEditInput}
                    type="password"
                    autoComplete="new-password"
                    aria-label="Новый пароль клиента"
                    placeholder="Введите новый пароль"
                    value={passwordDraft}
                    onChange={(event) => onPasswordDraftChange(company.id, event.target.value)}
                  />
                  <small className={styles.passwordPolicyHint}>Минимум 10 символов, обязательно буквы и цифры</small>
                </>
              )}
            </div>
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
              {passwordIsEdited ? 'Отменить пароль' : company.clientUserId ? 'Изменить пароль' : 'Задать пароль'}
            </button>
            <button className={isSaved ? styles.savedButton : ''} disabled={busy || Boolean(conflict)} onClick={() => onSave(company.id)}>
              {isSaved ? 'Сохранено' : 'Сохранить'}
            </button>
            <button className={styles.secondary} type="button" disabled={busy} onClick={() => onArchive(company)}>
              В архив
            </button>
          </div>
        </fieldset>
      ) : null}
    </article>
  );
}
