'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { startClientRealtimeSync } from '@/shared/lib/clientRealtimeSync';

import { AdminClientCompanyCard } from './AdminClientCompanyCard';
import { AdminClientCreateForm } from './AdminClientCreateForm';
import { submitClientMutation } from './clientMutation';
import { useAdminRequestScope } from '../shared/useAdminRequestScope';
import {
  emptyDraft,
  readApiError,
  readApiErrorFallback,
  toDraft,
  type AdminClientsSectionProps,
  type ClientCompany,
  type ClientDraft,
  type Manager,
} from './AdminClientsModel';

export function AdminClientsSection({ onBack }: AdminClientsSectionProps) {
  const { request, cancelAll, isActive } = useAdminRequestScope();
  const [companies, setCompanies] = useState<ClientCompany[]>([]);
  const companiesRef = useRef<ClientCompany[]>([]);
  const mutationRef = useRef(false);
  const dataGeneration = useRef(0);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [draft, setDraft] = useState<ClientDraft>(emptyDraft);
  const [companyDrafts, setCompanyDrafts] = useState<Record<number, ClientDraft>>({});
  const [clientPasswordEditIds, setClientPasswordEditIds] = useState<Record<number, boolean>>({});
  const [clientPasswordDrafts, setClientPasswordDrafts] = useState<Record<number, string>>({});
  const [expandedCompanyIds, setExpandedCompanyIds] = useState<Record<number, boolean>>({});
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

  const loadClients = useCallback(async (preserveDrafts = false, signal?: AbortSignal) => {
    if (mutationRef.current) return;
    const generation = dataGeneration.current;
    const response = await request('/api/admin/clients', { cache: 'no-store', signal });
    if (!response.ok) throw new Error(await readApiError(response, 'Не удалось загрузить клиентов'));
    const data = await response.json();
    if (signal?.aborted || generation !== dataGeneration.current) return;
    const nextCompanies = Array.isArray(data.companies) ? data.companies : [];
    const previousCompanies = new Map(companiesRef.current.map((company) => [company.id, company]));
    companiesRef.current = nextCompanies;
    setCompanies(nextCompanies);
    setCompanyDrafts((current) => Object.fromEntries(nextCompanies.map((company: ClientCompany) => {
      const previous = previousCompanies.get(company.id);
      const dirty = current[company.id] && (!previous || JSON.stringify(current[company.id]) !== JSON.stringify(toDraft(previous)));
      return [company.id, preserveDrafts && dirty ? current[company.id] : toDraft(company)];
    })));
  }, [request]);

  const loadManagers = async () => {
    const response = await request('/api/admin/wholesale/managers', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    setManagers(Array.isArray(data.managers) ? data.managers : []);
  };

  useEffect(() => {
    void loadManagers().catch((error) => {
      showStatus(readApiErrorFallback(error, 'Не удалось загрузить клиентов'));
    });
  }, []);

  useEffect(() => {
    return startClientRealtimeSync({
      eventsEndpoint: '/api/admin/clients/events',
      eventTypes: ['chat.updated', 'client.updated'],
      refresh: async (signal) => { await loadClients(true, signal); },
      onError: (error) => { setStatus(readApiErrorFallback(error, 'Не удалось обновить клиентов')); },
    });
  }, [loadClients]);

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

  // Use the transaction's returned row, not a second request that can fail after save.
  const acceptSavedCompany = (company: ClientCompany) => {
    const existing = companiesRef.current.some((item) => item.id === company.id);
    const nextCompanies = existing
      ? companiesRef.current.map((item) => item.id === company.id ? company : item)
      : [company, ...companiesRef.current];
    companiesRef.current = nextCompanies;
    setCompanies(nextCompanies);
    setCompanyDrafts((current) => ({ ...current, [company.id]: toDraft(company) }));
  };

  const startMutation = () => {
    if (mutationRef.current) return false;
    mutationRef.current = true;
    dataGeneration.current += 1;
    setBusy(true);
    return true;
  };

  const finishMutation = () => {
    dataGeneration.current += 1;
    mutationRef.current = false;
    setBusy(false);
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

    if (!startMutation()) return;
    try {
      const result = await submitClientMutation('/api/admin/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      }, request);
      if (!isActive()) return;
      setDraft(emptyDraft);
      if (result.company) acceptSavedCompany(result.company);
      setStatus(['Компания клиента добавлена.', ...result.warnings].join(' '));
    } catch (error) {
      if (isActive()) setStatus(readApiErrorFallback(error, 'Не удалось подтвердить добавление компании'));
    } finally {
      finishMutation();
    }
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

    if (!startMutation()) return;
    try {
      const result = await submitClientMutation(`/api/admin/clients/${companyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...nextDraft, password: nextPassword }),
      }, request);
      if (!isActive()) return;
      if (result.company) acceptSavedCompany(result.company);
      if (nextPassword) {
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
      setStatus(['Компания клиента сохранена.', ...result.warnings].join(' '));
      window.setTimeout(() => {
        setSavedCompanyId((current) => (current === companyId ? null : current));
      }, 2200);
    } catch (error) {
      if (isActive()) setStatus(readApiErrorFallback(error, 'Не удалось подтвердить сохранение компании'));
    } finally {
      finishMutation();
    }
  };

  const deleteCompany = async (company: ClientCompany) => {
    const confirmed = window.confirm(
      `Удалить клиента "${company.title || 'Без названия'}"? Пользователь личного кабинета и его сессии тоже будут удалены.`,
    );
    if (!confirmed) return;

    if (!startMutation()) return;
    try {
      const result = await submitClientMutation(`/api/admin/clients/${company.id}`, { method: 'DELETE' }, request);
      if (!isActive()) return;
      companiesRef.current = companiesRef.current.filter((item) => item.id !== company.id);
      setCompanies(companiesRef.current);
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
      setExpandedCompanyIds((current) => {
        const next = { ...current };
        delete next[company.id];
        return next;
      });
      setStatus(['Клиент удалён.', ...result.warnings].join(' '));
    } catch (error) {
      if (isActive()) setStatus(readApiErrorFallback(error, 'Не удалось подтвердить удаление клиента'));
    } finally {
      finishMutation();
    }
  };

  const toggleCompanyExpanded = (companyId: number) => {
    setExpandedCompanyIds((current) => ({ ...current, [companyId]: !current[companyId] }));
  };

  const toggleClientPasswordEdit = (companyId: number) => {
    setClientPasswordEditIds((current) => ({ ...current, [companyId]: !current[companyId] }));
    setClientPasswordDrafts((current) => {
      const next = { ...current };
      delete next[companyId];
      return next;
    });
  };

  const refreshClients = async () => {
    setBusy(true);
    try {
      await loadClients(true);
      setStatus('Список обновлён. Несохранённые изменения в формах оставлены.');
    } catch (error) {
      setStatus(readApiErrorFallback(error, 'Не удалось обновить список клиентов'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <p>Личный кабинет</p>
          <h2>Клиенты</h2>
        </div>
        <button className={styles.secondary} disabled={busy} onClick={refreshClients}>
          Обновить список
        </button>
        {busy ? <button className={styles.secondary} onClick={cancelAll}>Отменить ожидание</button> : null}
        <button className={styles.secondary} onClick={onBack}>
          Вернуться в панель управления
        </button>
      </div>

      {status ? <p role="status" className={styles.status}>{status}</p> : null}

      <AdminClientCreateForm
        draft={draft}
        developmentManagers={developmentManagers}
        supportManagers={supportManagers}
        busy={busy}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        onCreate={createCompany}
      />

      <div className={styles.clientCompanyList}>
        {companies.length === 0 ? <p className={styles.mutedText}>Клиенты пока не добавлены.</p> : null}
        {companies.map((company) => (
          <AdminClientCompanyCard
            key={company.id}
            company={company}
            currentDraft={companyDrafts[company.id] ?? toDraft(company)}
            displayPassword={company.displayPassword || ''}
            passwordIsEdited={Boolean(clientPasswordEditIds[company.id])}
            passwordDraft={clientPasswordDrafts[company.id] || ''}
            developmentManagers={developmentManagers}
            supportManagers={supportManagers}
            busy={busy}
            isExpanded={Boolean(expandedCompanyIds[company.id])}
            isSaved={savedCompanyId === company.id}
            onDraftChange={updateCompanyDraft}
            onCopyPassword={copyClientPassword}
            onToggleExpanded={toggleCompanyExpanded}
            onTogglePasswordEdit={toggleClientPasswordEdit}
            onPasswordDraftChange={(id, value) => setClientPasswordDrafts((current) => ({ ...current, [id]: value }))}
            onSave={saveCompany}
            onDelete={deleteCompany}
          />
        ))}
      </div>
    </section>
  );
}
