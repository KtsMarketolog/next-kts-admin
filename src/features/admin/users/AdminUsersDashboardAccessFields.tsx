import type { DashboardAccessOption } from '@/shared/lib/dashboardAccess';

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
};

export function AdminUsersDashboardAccessFields({ value, options, loading, disabled, error, onChange, onRetry }: Props) {
  const unavailableCount = options ? value.filter((key) => !options.some((option) => option.key === key)).length : 0;

  return (
    <fieldset className={styles.accessFieldset} disabled={disabled}>
      <legend>Доступные дашборды — только просмотр</legend>
      <p className={styles.help}>
        Закупщик видит только отмеченные дашборды и не может менять их HTML, данные или настройки.
        Без галочек доступа нет. Новые дашборды не добавляются автоматически.
      </p>
      {loading ? (
        <p className={styles.help} role="status">Загрузка списка дашбордов…</p>
      ) : error || options === null ? (
        <div className={styles.error}>
          <p role="alert">{error || 'Список дашбордов недоступен.'} Сохранение закупщика временно недоступно; текущие права не изменены.</p>
          <button type="button" onClick={onRetry}>Повторить загрузку дашбордов</button>
        </div>
      ) : (
        <>
          <div className={styles.options}>
            {options.map((option) => (
              <label className={styles.option} key={option.key}>
                <input
                  type="checkbox"
                  checked={value.includes(option.key)}
                  onChange={(event) => onChange(toggleDashboardAccess(value, option.key, event.target.checked))}
                />
                <span>
                  <strong>{option.title}</strong>
                  {option.description && <small>{option.description}</small>}
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
