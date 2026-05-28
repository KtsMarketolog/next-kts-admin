import styles from '@/app/admin/admin.module.scss';

import { AdminClientManagerSelect } from './AdminClientManagerSelect';
import type { ClientDraft, Manager } from './AdminClientsModel';

type AdminClientCreateFormProps = {
  draft: ClientDraft;
  developmentManagers: Manager[];
  supportManagers: Manager[];
  busy: boolean;
  onChange: (patch: Partial<ClientDraft>) => void;
  onCreate: () => void;
};

export function AdminClientCreateForm({
  draft,
  developmentManagers,
  supportManagers,
  busy,
  onChange,
  onCreate,
}: AdminClientCreateFormProps) {
  return (
    <div className={styles.clientCreateCard}>
      <label>
        <span>Компания</span>
        <input value={draft.title} onChange={(event) => onChange({ title: event.target.value })} />
      </label>
      <label>
        <span>Email</span>
        <input value={draft.email} onChange={(event) => onChange({ email: event.target.value })} />
      </label>
      <label>
        <span>Телефон</span>
        <input value={draft.phone} onChange={(event) => onChange({ phone: event.target.value })} />
      </label>
      <label>
        <span>Пароль</span>
        <input type="password" value={draft.password} onChange={(event) => onChange({ password: event.target.value })} autoComplete="new-password" />
        <small className={styles.passwordPolicyHint}>Минимум 10 символов, обязательно буквы и цифры</small>
      </label>
      <label>
        <span>Менеджер</span>
        <AdminClientManagerSelect value={draft.managerId} onChange={(managerId) => onChange({ managerId })} options={developmentManagers} placeholder="Не выбран" />
      </label>
      <label>
        <span>Сопровождение</span>
        <AdminClientManagerSelect
          value={draft.supportManagerId}
          onChange={(supportManagerId) => onChange({ supportManagerId })}
          options={supportManagers}
          placeholder="Не выбрано"
        />
      </label>
      <label className={styles.checkbox}>
        <input type="checkbox" checked={draft.isActive} onChange={(event) => onChange({ isActive: event.target.checked })} />
        Активна
      </label>
      <button disabled={busy} onClick={onCreate}>
        Добавить клиента
      </button>
    </div>
  );
}
