'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { startClientRealtimeSync } from '@/shared/lib/clientRealtimeSync';

import { AdminClientCompanyCard } from './AdminClientCompanyCard';
import { AdminClientCreateForm } from './AdminClientCreateForm';
import { AdminClientDeletionDialog } from './AdminClientDeletionDialog';
import { submitClientMutation } from './clientMutation';
import { useAdminRequestScope } from '../shared/useAdminRequestScope';
import {
  emptyDraft,
  archiveClientConfirmation,
  clientMatchesScope,
  mergeClientDrafts,
  readClientDeletionPreview,
  readApiError,
  readApiErrorFallback,
  toDraft,
  type AdminClientsSectionProps,
  type ClientCompany,
  type ClientDraft,
  type Manager,
  type ClientListScope,
  type ClientDeletionPreview,
} from './AdminClientsModel';

export function AdminClientsSection({ onBack }: AdminClientsSectionProps) {
  const { request, cancelAll, isActive } = useAdminRequestScope();
  const [companies, setCompanies] = useState<ClientCompany[]>([]);
  const companiesRef = useRef<ClientCompany[]>([]);
  const companyBaselines = useRef(new Map<number, ClientCompany>());
  const [scope, setScope] = useState<ClientListScope>('active');
  const scopeRef = useRef<ClientListScope>('active');
  const loadSequence = useRef(0);
  const [loading, setLoading] = useState(true);
  const [canPermanentlyDelete, setCanPermanentlyDelete] = useState(false);
  const [deletionPreview, setDeletionPreview] = useState<ClientDeletionPreview | null>(null);
  const [deletionError, setDeletionError] = useState('');
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
    const sequence = ++loadSequence.current;
    try {
      const response = await request(scope === 'archived' ? '/api/admin/clients?scope=archived' : '/api/admin/clients', { cache: 'no-store', signal });
      if (!response.ok) throw new Error(await readApiError(response, 'Не удалось загрузить клиентов'));
      const data = await response.json();
      if (signal?.aborted || generation !== dataGeneration.current || sequence !== loadSequence.current || scope !== scopeRef.current) return;
      if (!Array.isArray(data.companies)) throw new Error('Получен неполный список клиентов. Обновите список.');
      setCanPermanentlyDelete(data.canPermanentlyDelete === true);
      const nextCompanies = (data.companies as ClientCompany[]).filter((company) => clientMatchesScope(company, scope));
      const previousCompanies = new Map(companyBaselines.current);
      for (const company of nextCompanies) companyBaselines.current.set(company.id, company);
      companiesRef.current = nextCompanies;
      setCompanies(nextCompanies);
      setCompanyDrafts((current) => preserveDrafts
        ? mergeClientDrafts(current, nextCompanies, previousCompanies)
        : { ...current, ...Object.fromEntries(nextCompanies.map((company) => [company.id, toDraft(company)])) });
    } finally {
      if (sequence === loadSequence.current && scope === scopeRef.current && isActive()) setLoading(false);
    }
  }, [request, scope, isActive]);

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
    companyBaselines.current.set(company.id, company);
    companiesRef.current = nextCompanies.filter((item) => clientMatchesScope(item, scopeRef.current));
    setCompanies(companiesRef.current);
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

  const archiveCompany = async (company: ClientCompany) => {
    const confirmed = window.confirm(archiveClientConfirmation(company));
    if (!confirmed) return;

    if (!startMutation()) return;
    try {
      const result = await submitClientMutation(`/api/admin/clients/${company.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: company.updatedAt }),
      }, request);
      if (!isActive()) return;
      if (!result.company?.archivedAt) throw new Error('Не удалось подтвердить архивирование. Обновите список перед повторной попыткой.');
      companyBaselines.current.set(company.id, result.company);
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
      setStatus(['Клиент перенесён в архив. Данные и файлы сохранены, вход закрыт. Публичные ссылки на прайсы не отключены.', ...result.warnings].join(' '));
    } catch (error) {
      if (isActive()) setStatus(readApiErrorFallback(error, 'Не удалось подтвердить архивирование клиента'));
    } finally {
      finishMutation();
    }
  };

  const restoreCompany = async (company: ClientCompany) => {
    if (!window.confirm(`Восстановить клиента «${company.title || 'Без названия'}» из архива? Доступ останется отключённым. Включить его можно отдельно в карточке клиента после проверки данных.`)) return;
    if (!startMutation()) return;
    try {
      const result = await submitClientMutation(`/api/admin/clients/${company.id}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: company.updatedAt }),
      }, request);
      if (!isActive()) return;
      if (!result.company || result.company.archivedAt || result.company.isActive) throw new Error('Не удалось подтвердить восстановление. Обновите список перед повторной попыткой.');
      acceptSavedCompany(result.company);
      setStatus(['Клиент восстановлен. Он находится во вкладке «Клиенты», доступ остаётся отключённым.', ...result.warnings].join(' '));
    } catch (error) {
      if (isActive()) setStatus(readApiErrorFallback(error, 'Не удалось подтвердить восстановление клиента'));
    } finally {
      finishMutation();
    }
  };

  const selectScope = (nextScope: ClientListScope) => {
    if (nextScope === scopeRef.current || mutationRef.current) return;
    dataGeneration.current += 1;
    scopeRef.current = nextScope;
    companiesRef.current = [];
    setCompanies([]);
    setStatus('');
    setLoading(true);
    setScope(nextScope);
  };

  const previewPermanentDeletion = async (company: ClientCompany) => {
    if (!canPermanentlyDelete || !company.archivedAt || !startMutation()) return;
    setDeletionError('');
    try {
      const response = await request(`/api/admin/clients/${company.id}/deletion-preview`, { cache: 'no-store' });
      if (!response.ok) throw new Error(await readApiError(response, 'Не удалось проверить состав удаляемых данных'));
      const data = await response.json();
      const preview = readClientDeletionPreview(data?.preview, company.id);
      if (isActive()) setDeletionPreview(preview);
    } catch (error) {
      if (isActive()) setStatus(readApiErrorFallback(error, 'Не удалось проверить состав удаляемых данных'));
    } finally {
      finishMutation();
    }
  };

  const permanentlyDeleteCompany = async (confirmationTitle: string) => {
    const preview = deletionPreview;
    if (!canPermanentlyDelete || !preview || confirmationTitle !== preview.title || !startMutation()) return;
    setDeletionError('');
    try {
      const response = await request(`/api/admin/clients/${preview.id}/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: preview.updatedAt, expectedRevision: preview.revision, confirmationTitle }),
      });
      if (!response.ok) throw new Error(await readApiError(response, 'Не удалось подтвердить удаление. Обновите список перед повтором.'));
      const data = await response.json().catch(() => null);
      if (!data || data.ok !== true || data.saved !== true) throw new Error('Не удалось подтвердить удаление. Обновите список перед повтором.');
      if (!isActive()) return;
      companiesRef.current = companiesRef.current.filter((item) => item.id !== preview.id);
      companyBaselines.current.delete(preview.id);
      setCompanies(companiesRef.current);
      setCompanyDrafts((current) => { const next = { ...current }; delete next[preview.id]; return next; });
      setClientPasswordDrafts((current) => { const next = { ...current }; delete next[preview.id]; return next; });
      setClientPasswordEditIds((current) => { const next = { ...current }; delete next[preview.id]; return next; });
      setExpandedCompanyIds((current) => { const next = { ...current }; delete next[preview.id]; return next; });
      setDeletionPreview(null);
      const warnings = Array.isArray(data.warnings) ? data.warnings.flatMap((warning: { message?: unknown }) => typeof warning?.message === 'string' ? [warning.message] : []) : [];
      const fileStatus = !Number.isSafeInteger(data.cleanupPending) || data.cleanupPending < 0
        ? 'Статус очистки файлов не получен; его нужно проверить отдельно.'
        : data.cleanupPending > 0 ? `Заданий очистки файлов, ожидающих отдельного подтверждения: ${data.cleanupPending}.` : 'Ожидающих заданий очистки файлов нет.';
      setStatus([`Клиент удалён навсегда. Прайсы и их товары сохранены, привязки к клиенту сняты. ${fileStatus}`, ...warnings].join(' '));
    } catch (error) {
      if (isActive()) setDeletionError(readApiErrorFallback(error, 'Не удалось подтвердить удаление. Обновите список перед повтором.'));
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

      <div className={styles.userRoleTabs} aria-label="Список клиентов">
        <button type="button" aria-pressed={scope === 'active'} disabled={busy} onClick={() => selectScope('active')}>Клиенты</button>
        <button type="button" aria-pressed={scope === 'archived'} disabled={busy} onClick={() => selectScope('archived')}>Архив</button>
      </div>
      {scope === 'archived' ? <p className={styles.mutedText}>Данные и файлы хранятся в архиве до явного ручного удаления администратором, без автоматического удаления по сроку. Восстановление не включает доступ в кабинет. Публичные ссылки на прайсы не отключаются архивированием, заявки по ним могут продолжать поступать.</p> : null}

      {scope === 'active' ? <AdminClientCreateForm
        draft={draft}
        developmentManagers={developmentManagers}
        supportManagers={supportManagers}
        busy={busy || loading}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        onCreate={createCompany}
      /> : null}

      <div className={styles.clientCompanyList}>
        {loading ? <p className={styles.mutedText}>Загружаем список клиентов...</p> : companies.length === 0 ? <p className={styles.mutedText}>{scope === 'archived' ? 'Архив пуст.' : 'Клиенты пока не добавлены.'}</p> : null}
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
            busy={busy || loading}
            isExpanded={Boolean(expandedCompanyIds[company.id])}
            isSaved={savedCompanyId === company.id}
            canPermanentlyDelete={canPermanentlyDelete}
            onDraftChange={updateCompanyDraft}
            onCopyPassword={copyClientPassword}
            onToggleExpanded={toggleCompanyExpanded}
            onTogglePasswordEdit={toggleClientPasswordEdit}
            onPasswordDraftChange={(id, value) => setClientPasswordDrafts((current) => ({ ...current, [id]: value }))}
            onSave={saveCompany}
            onArchive={archiveCompany}
            onRestore={restoreCompany}
            onPermanentDelete={previewPermanentDeletion}
          />
        ))}
      </div>
      {deletionPreview ? <AdminClientDeletionDialog key={`${deletionPreview.id}:${deletionPreview.revision}`} preview={deletionPreview}
        busy={busy} error={deletionError} onCancel={() => setDeletionPreview(null)} onConfirm={permanentlyDeleteCompany} /> : null}
    </section>
  );
}
