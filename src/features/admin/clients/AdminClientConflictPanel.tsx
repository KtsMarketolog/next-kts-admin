'use client';

import { useId, useState } from 'react';

import adminStyles from '@/app/admin/admin.module.scss';

import type { Manager } from './AdminClientsModel';
import type {
  ClientConflictComparison,
  ClientConflictField,
  ClientConflictValue,
  ClientEditableField,
} from './clientConflict';
import styles from './AdminClientConflictPanel.module.scss';

type Props = {
  comparison: ClientConflictComparison | null;
  busy: boolean;
  error: string;
  passwordPending: boolean;
  managers: Manager[];
  onLoad: () => void;
  onCancel: () => void;
  onResolve: (fields: ClientEditableField[]) => void;
  onReload: () => void;
};

function fieldValue(field: ClientConflictField, value: ClientConflictValue, managers: Manager[]) {
  if (value === null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (field.key === 'managerId' || field.key === 'supportManagerId') {
    return managers.find((manager) => manager.id === value)?.name || `#${value}`;
  }
  return String(value);
}

export function AdminClientConflictPanel({
  comparison,
  busy,
  error,
  passwordPending,
  managers,
  onLoad,
  onCancel,
  onResolve,
  onReload,
}: Props) {
  const titleId = useId();
  // A newly fetched comparison requires an explicit new choice, even if its
  // version is unchanged. Never carry a previous overwrite selection forward.
  const [selection, setSelection] = useState<{
    comparison: ClientConflictComparison;
    fields: ClientEditableField[];
  } | null>(null);
  const selected = comparison && selection?.comparison === comparison ? selection.fields : [];

  const selectField = (key: ClientEditableField, checked: boolean) => {
    if (!comparison || busy) return;
    setSelection((current) => {
      const fields = current?.comparison === comparison ? current.fields : [];
      return {
        comparison,
        fields: checked ? [...new Set([...fields, key])] : fields.filter((field) => field !== key),
      };
    });
  };

  return (
    <section className={styles.panel} aria-labelledby={titleId} aria-busy={busy}>
      <div role="alert">
        <h3 id={titleId} className={styles.title}>Карточка изменена другим пользователем</h3>
        <p className={styles.description}>
          {comparison
            ? 'Ваши правки не сохранены. Ниже показаны актуальные данные сервера и значения из вашей формы.'
            : 'Ваши правки не сохранены и остаются в форме. Сначала загрузите актуальную карточку для сравнения.'}
        </p>
      </div>

      {passwordPending ? (
        <p className={styles.passwordNotice}>
          Новый пароль не участвует в сравнении и не переносится. После согласования правок введите его заново, если смена пароля ещё нужна.
        </p>
      ) : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      {comparison ? (
        <>
          <p className={styles.description}>
            Выберите только свои правки, которые нужно перенести в актуальную карточку.
            Остальные поля останутся как на сервере. Автоматического сохранения не будет:
            после переноса проверьте форму и нажмите «Сохранить».
          </p>
          <ul className={styles.fields} aria-label="Сравнение актуальной карточки и ваших правок">
            {comparison.fields.map((field) => (
              <li className={styles.field} key={field.key}>
                <div className={styles.fieldHeader}>
                  <strong>{field.label}</strong>
                  {field.serverChanged ? <span className={styles.changed}>Изменено на сервере</span> : null}
                </div>
                <div className={styles.values}>
                  <div className={styles.valueBlock}>
                    <span className={styles.valueLabel}>На сервере</span>
                    <p className={styles.value}>{fieldValue(field, field.serverValue, managers)}</p>
                  </div>
                  <div className={styles.valueBlock}>
                    <span className={styles.valueLabel}>В вашей форме</span>
                    <p className={styles.value}>{fieldValue(field, field.localValue, managers)}</p>
                  </div>
                </div>
                {field.localChanged ? (
                  <label className={styles.selection}>
                    <input
                      type="checkbox"
                      checked={selected.includes(field.key)}
                      disabled={busy}
                      onChange={(event) => selectField(field.key, event.target.checked)}
                    />
                    <span>Перенести: {field.label}</span>
                  </label>
                ) : <p className={styles.unchanged}>Ваших изменений в этом поле нет</p>}
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <button type="button" disabled={busy || selected.length === 0} onClick={() => onResolve(selected)}>
              Применить выбранные правки
            </button>
            <button type="button" className={adminStyles.secondary} disabled={busy} onClick={onReload}>
              Загрузить без моих правок
            </button>
            <button type="button" className={adminStyles.secondary} disabled={busy} onClick={onLoad}>
              {busy ? 'Загружаем…' : 'Обновить сравнение'}
            </button>
            <button type="button" className={adminStyles.secondary} disabled={busy} onClick={onCancel}>
              Закрыть сравнение
            </button>
          </div>
        </>
      ) : (
        <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={onLoad}>
            {busy ? 'Загружаем…' : 'Загрузить актуальную карточку'}
          </button>
        </div>
      )}
    </section>
  );
}
