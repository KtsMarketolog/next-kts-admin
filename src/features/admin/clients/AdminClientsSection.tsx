'use client';

import { useEffect, useMemo, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';

type ClientCompany = {
  id: number;
  title: string;
  inn: string;
  kpp: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  note: string;
  managerId: number | null;
  managerName: string;
  supportManagerId: number | null;
  supportManagerName: string;
  userCount: number;
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
  inn: string;
  kpp: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  note: string;
  managerId: number | null;
  supportManagerId: number | null;
  isActive: boolean;
};

type AdminClientsSectionProps = {
  onBack: () => void;
};

const emptyDraft: ClientDraft = {
  title: '',
  inn: '',
  kpp: '',
  contactName: '',
  email: '',
  phone: '',
  address: '',
  note: '',
  managerId: null,
  supportManagerId: null,
  isActive: true,
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
    inn: company.inn,
    kpp: company.kpp,
    contactName: company.contactName,
    email: company.email,
    phone: company.phone,
    address: company.address,
    note: company.note,
    managerId: company.managerId,
    supportManagerId: company.supportManagerId,
    isActive: company.isActive,
  };
}

export function AdminClientsSection({ onBack }: AdminClientsSectionProps) {
  const [companies, setCompanies] = useState<ClientCompany[]>([]);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [draft, setDraft] = useState<ClientDraft>(emptyDraft);
  const [companyDrafts, setCompanyDrafts] = useState<Record<number, ClientDraft>>({});
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
    void Promise.all([loadClients(), loadManagers()]).catch((error) => {
      showStatus(readApiErrorFallback(error, 'Не удалось загрузить клиентов'));
    });
  }, []);

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

    setBusy(true);
    const response = await fetch(`/api/admin/clients/${companyId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextDraft),
    });
    setBusy(false);

    if (!response.ok) {
      showStatus(await readApiError(response, 'Не удалось сохранить компанию'));
      return;
    }

    setSavedCompanyId(companyId);
    showStatus('Компания клиента сохранена');
    await loadClients();
    window.setTimeout(() => {
      setSavedCompanyId((current) => (current === companyId ? null : current));
    }, 2200);
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
          <span>ИНН</span>
          <input value={draft.inn} onChange={(event) => setDraft((current) => ({ ...current, inn: event.target.value }))} />
        </label>
        <label>
          <span>КПП</span>
          <input value={draft.kpp} onChange={(event) => setDraft((current) => ({ ...current, kpp: event.target.value }))} />
        </label>
        <label>
          <span>Контакт</span>
          <input value={draft.contactName} onChange={(event) => setDraft((current) => ({ ...current, contactName: event.target.value }))} />
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
        <label className={styles.clientWideField}>
          <span>Адрес</span>
          <input value={draft.address} onChange={(event) => setDraft((current) => ({ ...current, address: event.target.value }))} />
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
          return (
            <article className={styles.clientCompanyCard} key={company.id}>
              <div className={styles.clientCompanyHeader}>
                <div>
                  <p>{company.isActive ? 'Активный клиент' : 'Отключен'}</p>
                  <h3>{company.title || 'Без названия'}</h3>
                </div>
                <div className={styles.clientCompanyMeta}>
                  <span>Пользователей ЛК: {company.userCount}</span>
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
                  <span>ИНН</span>
                  <input value={currentDraft.inn} onChange={(event) => updateCompanyDraft(company.id, { inn: event.target.value })} />
                </label>
                <label>
                  <span>КПП</span>
                  <input value={currentDraft.kpp} onChange={(event) => updateCompanyDraft(company.id, { kpp: event.target.value })} />
                </label>
                <label>
                  <span>Контакт</span>
                  <input
                    value={currentDraft.contactName}
                    onChange={(event) => updateCompanyDraft(company.id, { contactName: event.target.value })}
                  />
                </label>
                <label>
                  <span>Email</span>
                  <input value={currentDraft.email} onChange={(event) => updateCompanyDraft(company.id, { email: event.target.value })} />
                </label>
                <label>
                  <span>Телефон</span>
                  <input value={currentDraft.phone} onChange={(event) => updateCompanyDraft(company.id, { phone: event.target.value })} />
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
                  <span>Адрес</span>
                  <input value={currentDraft.address} onChange={(event) => updateCompanyDraft(company.id, { address: event.target.value })} />
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
                <button className={savedCompanyId === company.id ? styles.savedButton : ''} disabled={busy} onClick={() => saveCompany(company.id)}>
                  {savedCompanyId === company.id ? 'Сохранено' : 'Сохранить'}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
