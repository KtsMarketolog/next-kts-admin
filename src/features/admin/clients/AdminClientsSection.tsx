'use client';

import { useEffect, useMemo, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';
import {
  readClientCompanyPasswords,
  removeClientCompanyPassword,
  saveClientCompanyPassword,
} from '@/shared/lib/adminPasswordStorage';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';

type ClientCompany = {
  id: number;
  title: string;
  email: string;
  phone: string;
  note: string;
  managerId: number | null;
  managerName: string;
  supportManagerId: number | null;
  supportManagerName: string;
  userCount: number;
  clientLogin: string;
  clientUserId: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type Manager = {
  id: number;
  name: string;
  role: 'manager' | 'support_manager' | string;
  isActive: boolean;
};

type ClientDraft = {
  title: string;
  email: string;
  phone: string;
  note: string;
  managerId: number | null;
  supportManagerId: number | null;
  isActive: boolean;
  password: string;
};

type AdminClientsSectionProps = {
  onBack: () => void;
};

const emptyDraft: ClientDraft = {
  title: '',
  email: '',
  phone: '',
  note: '',
  managerId: null,
  supportManagerId: null,
  isActive: true,
  password: '',
};

function readApiErrorFallback(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function readApiError(response: Response, fallback: string) {
  const data = await response.json().catch(() => null);
  return typeof data?.error === 'string' && data.error ? data.error : fallback;
}

function managerIdValue(value: number | null) {
  return value ? String(value) : '';
}

function toDraft(company: ClientCompany): ClientDraft {
  return {
    title: company.title,
    email: company.email,
    phone: company.phone,
    note: company.note,
    managerId: company.managerId,
    supportManagerId: company.supportManagerId,
    isActive: company.isActive,
    password: '',
  };
}

export function AdminClientsSection({ onBack }: AdminClientsSectionProps) {
  const [companies, setCompanies] = useState<ClientCompany[]>([]);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [draft, setDraft] = useState<ClientDraft>(emptyDraft);
  const [companyDrafts, setCompanyDrafts] = useState<Record<number, ClientDraft>>({});
  const [clientPasswords, setClientPasswords] = useState<Record<string, string>>({});
  const [clientPasswordEditIds, setClientPasswordEditIds] = useState<Record<number, boolean>>({});
  const [clientPasswordDrafts, setClientPasswordDrafts] = useState<Record<number, string>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedCompanyId, setSavedCompanyId] = useState<number | null>(null);

  const developmentManagers = useMemo(
    () => managers.filter((manager) => manager.role === 'manager' && manager.isActive),
    [managers],
  );
  const supportManagers = useMemo(
    () => managers.filter((manager) => manager.role === 'support_manager' && manager.isActive),
    [managers],
  );

  const showStatus = (message: string) => {
    setStatus(message);
    window.setTimeout(() => {
      setStatus((current) => (current === message ? '' : current));
    }, 2200);
  };

  const loadClients = async () => {
    const response = await fetch('/api/admin/clients', { cache: 'no-store' });
    if (!response.ok) throw new Error(await readApiError(response, 'Не удалось загрузить клиентов'));
    const data = await response.json();
    const nextCompanies = Array.isArray(data.companies) ? data.companies : [];
    setCompanies(nextCompanies);
    setCompanyDrafts(Object.fromEntries(nextCompanies.map((company: ClientCompany) => [company.id, toDraft(company)])));
  };

  const loadManagers = async () => {
    const response = await fetch('/api/admin/wholesale/managers', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    setManagers(Array.isArray(data.managers) ? data.managers : []);
  };

  useEffect(() => {
    setClientPasswords(readClientCompanyPasswords());
    void Promise.all([loadClients(), loadManagers()]).catch((error) => {
      showStatus(readApiErrorFallback(error, 'Не удалось загрузить клиентов'));
    });
  }, []);

  const validateClientPassword = (password: string) => {
    const passwordPolicy = validatePasswordPolicy(password);
    if (!passwordPolicy.ok) {
      showStatus(passwordPolicy.error || 'Пароль не подходит');
      return false;
    }
    return true;
  };

  const copyClientPassword = async (password?: string) => {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      showStatus('Пароль скопирован');
    } catch {
      showStatus('Не удалось скопировать пароль');
    }
  };

  const updateCompanyDraft = (id: number, patch: Partial<ClientDraft>) => {
    setCompanyDrafts((current) => ({
      ...current,
      [id]: { ...(current[id] ?? emptyDraft), ...patch },
    }));
  };

  const createCompany = async () => {
    if (!draft.title.trim()) {
      showStatus('Введите название компании');
      return;
    }
    if (!draft.email.trim()) {
      showStatus('Введите email клиента для входа');
      return;
    }
    if (!draft.password.trim()) {
      showStatus('Введите пароль клиента');
      return;
    }
    if (!validateClientPassword(draft.password.trim())) return;

    setBusy(true);
    const response = await fetch('/api/admin/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    setBusy(false);

    if (!response.ok) {
      showStatus(await readApiError(response, 'Не удалось добавить компанию'));
      return;
    }

    const data = await response.json().catch(() => ({}));
    if (data.company?.id) {
      saveClientCompanyPassword(data.company.id, draft.password.trim());
      setClientPasswords(readClientCompanyPasswords());
    }
    setDraft(emptyDraft);
    showStatus('Компания клиента добавлена');
    await loadClients();
  };

  const saveCompany = async (companyId: number) => {
    const nextDraft = companyDrafts[companyId];
    if (!nextDraft?.title.trim()) {
      showStatus('Введите название компании');
      return;
    }
    if (!nextDraft.email.trim()) {
      showStatus('Введите email клиента для входа');
      return;
    }

    const passwordIsEdited = Boolean(clientPasswordEditIds[companyId]);
    const nextPassword = passwordIsEdited ? (clientPasswordDrafts[companyId] || '').trim() : '';
    if (passwordIsEdited && !nextPassword) {
      showStatus('Введите новый пароль или отмените изменение пароля');
      return;
    }
    if (nextPassword && !validateClientPassword(nextPassword)) return;

    setBusy(true);
    const response = await fetch(`/api/admin/clients/${companyId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...nextDraft, password: nextPassword }),
    });
    setBusy(false);

    if (!response.ok) {
      showStatus(await readApiError(response, 'Не удалось сохранить компанию'));
      return;
    }

    if (nextPassword) {
      saveClientCompanyPassword(companyId, nextPassword);
      setClientPasswords(readClientCompanyPasswords());
      setClientPasswordDrafts((current) => {
        const next = { ...current };
        delete next[companyId];
        return next;
      });
      setClientPasswordEditIds((current) => {
        const next = { ...current };
        delete next[companyId];
        return next;
      });
    }
    setSavedCompanyId(companyId);
    showStatus('Компания клиента сохранена');
    await loadClients();
    window.setTimeout(() => {
      setSavedCompanyId((current) => (current === companyId ? null : current));
    }, 2200);
  };

  const deleteCompany = async (company: ClientCompany) => {
    const confirmed = window.confirm(
      `Удалить клиента "${company.title || 'Без названия'}"? Пользователь личного кабинета и его сессии тоже будут удалены.`,
    );
    if (!confirmed) return;

    setBusy(true);
    const response = await fetch(`/api/admin/clients/${company.id}`, { method: 'DELETE' });
    setBusy(false);

    if (!response.ok) {
      showStatus(await readApiError(response, 'Не удалось удалить клиента'));
      return;
    }

    removeClientCompanyPassword(company.id);
    setClientPasswords(readClientCompanyPasswords());
    setClientPasswordDrafts((current) => {
      const next = { ...current };
      delete next[company.id];
      return next;
    });
    setClientPasswordEditIds((current) => {
      const next = { ...current };
      delete next[company.id];
      return next;
    });
    setCompanyDrafts((current) => {
      const next = { ...current };
      delete next[company.id];
      return next;
    });
    showStatus('Клиент удален');
    await loadClients();
  };

  const renderManagerSelect = (
    value: number | null,
    onChange: (value: number | null) => void,
    options: Manager[],
    placeholder: string,
  ) => (
    <select value={managerIdValue(value)} onChange={(event) => onChange(event.target.value ? Number(event.target.value) : null)}>
      <option value="">{placeholder}</option>
      {options.map((manager) => (
        <option key={manager.id} value={manager.id}>
          {manager.name}
        </option>
      ))}
    </select>
  );

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <p>Личный кабинет</p>
          <h2>Клиенты</h2>
        </div>
        <button className={styles.secondary} onClick={onBack}>
          Вернуться в панель управления
        </button>
      </div>

      {status ? <p className={styles.status}>{status}</p> : null}

      <div className={styles.clientIntro}>
        <strong>Первый безопасный этап</strong>
        <span>Компании клиентов создаются отдельно и пока не привязаны к действующим прайсам.</span>
      </div>

      <div className={styles.clientCreateCard}>
        <label>
          <span>Компания</span>
          <input value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
        </label>
        <label>
          <span>Email</span>
          <input value={draft.email} onChange={(event) => setDraft((current) => ({ ...current, email: event.target.value }))} />
        </label>
        <label>
          <span>Телефон</span>
          <input value={draft.phone} onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value }))} />
        </label>
        <label>
          <span>Пароль</span>
          <input
            type="password"
            value={draft.password}
            onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))}
            autoComplete="new-password"
          />
          <small className={styles.passwordPolicyHint}>Минимум 10 символов, обязательно буквы и цифры</small>
        </label>
        <label>
          <span>Менеджер</span>
          {renderManagerSelect(
            draft.managerId,
            (managerId) => setDraft((current) => ({ ...current, managerId })),
            developmentManagers,
            'Не выбран',
          )}
        </label>
        <label>
          <span>Сопровождение</span>
          {renderManagerSelect(
            draft.supportManagerId,
            (supportManagerId) => setDraft((current) => ({ ...current, supportManagerId })),
            supportManagers,
            'Не выбрано',
          )}
        </label>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={draft.isActive}
            onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))}
          />
          Активна
        </label>
        <button disabled={busy} onClick={createCompany}>
          Добавить клиента
        </button>
      </div>

      <div className={styles.clientCompanyList}>
        {companies.length === 0 ? <p className={styles.mutedText}>Клиенты пока не добавлены.</p> : null}
        {companies.map((company) => {
          const currentDraft = companyDrafts[company.id] ?? toDraft(company);
          const passwordIsEdited = Boolean(clientPasswordEditIds[company.id]);
          const displayPassword = clientPasswords[String(company.id)] || '';
          return (
            <article className={styles.clientCompanyCard} key={company.id}>
              <div className={styles.clientCompanyHeader}>
                <div>
                  <p>{company.isActive ? 'Активный клиент' : 'Отключен'}</p>
                  <h3>{company.title || 'Без названия'}</h3>
                </div>
                <div className={styles.clientCompanyMeta}>
                  <span>Пользователей ЛК: {company.userCount}</span>
                  <span>{company.clientLogin ? `Логин: ${company.clientLogin}` : 'Логин: email клиента'}</span>
                  <span>{company.managerName ? `Менеджер: ${company.managerName}` : 'Менеджер не выбран'}</span>
                  <span>{company.supportManagerName ? `Сопровождение: ${company.supportManagerName}` : 'Сопровождение не выбрано'}</span>
                </div>
              </div>

              <div className={styles.clientCompanyGrid}>
                <label>
                  <span>Компания</span>
                  <input value={currentDraft.title} onChange={(event) => updateCompanyDraft(company.id, { title: event.target.value })} />
                </label>
                <label>
                  <span>Email</span>
                  <input value={currentDraft.email} onChange={(event) => updateCompanyDraft(company.id, { email: event.target.value })} />
                </label>
                <label>
                  <span>Телефон</span>
                  <input value={currentDraft.phone} onChange={(event) => updateCompanyDraft(company.id, { phone: event.target.value })} />
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
                      onClick={() => copyClientPassword(displayPassword)}
                    />
                    <button
                      className={styles.userPasswordCopyButton}
                      type="button"
                      disabled={!displayPassword}
                      title="Скопировать пароль"
                      onClick={() => copyClientPassword(displayPassword)}
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
                        value={clientPasswordDrafts[company.id] || ''}
                        onChange={(event) => setClientPasswordDrafts((current) => ({ ...current, [company.id]: event.target.value }))}
                      />
                      <small className={styles.passwordPolicyHint}>Минимум 10 символов, обязательно буквы и цифры</small>
                    </>
                  )}
                </label>
                <label>
                  <span>Менеджер</span>
                  {renderManagerSelect(
                    currentDraft.managerId,
                    (managerId) => updateCompanyDraft(company.id, { managerId }),
                    developmentManagers,
                    'Не выбран',
                  )}
                </label>
                <label>
                  <span>Сопровождение</span>
                  {renderManagerSelect(
                    currentDraft.supportManagerId,
                    (supportManagerId) => updateCompanyDraft(company.id, { supportManagerId }),
                    supportManagers,
                    'Не выбрано',
                  )}
                </label>
                <label className={styles.clientWideField}>
                  <span>Заметка</span>
                  <textarea value={currentDraft.note} onChange={(event) => updateCompanyDraft(company.id, { note: event.target.value })} />
                </label>
              </div>

              <div className={styles.clientCompanyActions}>
                <label className={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={currentDraft.isActive}
                    onChange={(event) => updateCompanyDraft(company.id, { isActive: event.target.checked })}
                  />
                  Активна
                </label>
                <button
                  className={styles.secondary}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setClientPasswordEditIds((current) => ({ ...current, [company.id]: !current[company.id] }));
                    setClientPasswordDrafts((current) => {
                      const next = { ...current };
                      delete next[company.id];
                      return next;
                    });
                  }}
                >
                  {passwordIsEdited ? 'Отменить пароль' : displayPassword ? 'Изменить пароль' : 'Задать пароль'}
                </button>
                <button className={savedCompanyId === company.id ? styles.savedButton : ''} disabled={busy} onClick={() => saveCompany(company.id)}>
                  {savedCompanyId === company.id ? 'Сохранено' : 'Сохранить'}
                </button>
                <button className={styles.danger} type="button" disabled={busy} onClick={() => deleteCompany(company)}>
                  Удалить
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
