'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';

import { AdminClientCompanyCard } from './AdminClientCompanyCard';
import { AdminClientCreateForm } from './AdminClientCreateForm';
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
  const [companies, setCompanies] = useState<ClientCompany[]>([]);
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

  const loadUnreadCounts = useCallback(async () => {
    const response = await fetch('/api/admin/clients/chat-unread', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    const counts = new Map<number, number>(
      Array.isArray(data.clients)
        ? data.clients.map((client: { companyId: number; unreadCount: number }) => [client.companyId, Number(client.unreadCount || 0)])
        : [],
    );
    setCompanies((current) =>
      current.map((company) => ({
        ...company,
        chatUnreadCount: counts.get(company.id) ?? 0,
      })),
    );
  }, []);

  useEffect(() => {
    void Promise.all([loadClients(), loadManagers()]).catch((error) => {
      showStatus(readApiErrorFallback(error, 'Не удалось загрузить клиентов'));
    });
  }, []);

  useEffect(() => {
    void loadUnreadCounts();
    const events = new EventSource('/api/admin/clients/events');
    events.addEventListener('chat.updated', () => {
      void loadUnreadCounts();
    });
    events.addEventListener('client.updated', () => {
      void loadClients().catch(() => {
        showStatus('РќРµ СѓРґР°Р»РѕСЃСЊ РѕР±РЅРѕРІРёС‚СЊ РєР»РёРµРЅС‚РѕРІ');
      });
    });

    return () => {
      events.close();
    };
  }, [loadUnreadCounts]);

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
    showStatus('Клиент удален');
    await loadClients();
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
