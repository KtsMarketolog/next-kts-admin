import type { DashboardAccessOption } from '@/shared/lib/dashboardAccess';
import { canViewDashboardKey, hasDashboardManagementRight } from '@/shared/lib/dashboardPermissions';
import type { AccessUserRole } from './AdminUsersTypes';

import { toggleDashboardAccess } from './AdminUsersDashboardAccess';
import styles from './AdminUsersDashboardAccess.module.scss';

type Props = {
  value: string[];
  options: DashboardAccessOption[] | null;
  loading: boolean;
  disabled: boolean;
  error: string | null;
  onChange: (value: string[]) => void;
  onRetry: () => void;
  role: AccessUserRole;
  canManageTopDashboard?: boolean;
};

export function AdminUsersDashboardAccessFields({ value, options, loading, disabled, error, onChange, onRetry, role, canManageTopDashboard }: Props) {
  const unavailableCount = options ? value.filter((key) => !options.some((option) => option.key === key)).length : 0;
  const session = { role, sessionId: 'settings-preview', adminUserId: 1, managerId: 1, canManageTopDashboard, dashboardAccess: value };

  return (
    <fieldset className={styles.accessFieldset} disabled={disabled}>
      <legend>Доступные дашборды — только просмотр</legend>
      <p className={styles.help}>
        Галочки разрешают только просмотр. Права загрузки, публикации и управления доступами не меняются.
        Личные отчёты доступны только своему менеджеру. Доступ по существующим правам управления отмечен отдельно.
        Новые дашборды не добавляются автоматически.
      </p>
      {loading ? (
        <p className={styles.help} role="status">Загрузка списка дашбордов…</p>
      ) : error || options === null ? (
        <div className={styles.error}>
          <p role="alert">{error || 'Список дашбордов недоступен.'} Сохранение временно недоступно; текущие права не изменены.</p>
          <button type="button" onClick={onRetry}>Повторить загрузку дашбордов</button>
        </div>
      ) : (
        <>
          <div className={styles.options}>
            {options.map((option) => (
              <label className={styles.option} key={option.key}>
                <input
                  type="checkbox"
                  checked={canViewDashboardKey(session, option.key)}
                  disabled={hasDashboardManagementRight(session, option.key) || (option.key.startsWith('manager:') && option.key !== `manager:${role === 'manager' ? 'development' : role === 'support_manager' ? 'support' : ''}`)}
                  onChange={(event) => onChange(toggleDashboardAccess(value, option.key, event.target.checked))}
                />
                <span>
                  <strong>{option.title}</strong>
                  {option.description && <small>{option.description}</small>}
                  {hasDashboardManagementRight(session, option.key) && <small>Доступ по правам управления — эти галочки его не отменяют.</small>}
                </span>
              </label>
            ))}
          </div>
          {options.length === 0 && <p className={styles.help}>Дашбордов для выдачи доступа пока нет.</p>}
          {unavailableCount > 0 && (
            <p className={styles.help}>Сохранены ранее выданные права вне текущего списка: {unavailableCount}. Они не будут сброшены при сохранении.</p>
          )}
          <p className={styles.help}>Изменения галочек применяются после сохранения пользователя.</p>
        </>
      )}
    </fieldset>
  );
}
