'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { startClientRealtimeSync } from '@/shared/lib/clientRealtimeSync';

import { AdminClientCompanyCard } from './AdminClientCompanyCard';
import { AdminClientCreateForm } from './AdminClientCreateForm';
import { AdminClientDeletionDialog } from './AdminClientDeletionDialog';
import { ClientMutationError, submitClientMutation } from './clientMutation';
import { buildClientConflict, reconcileClientDrafts, resolveClientConflict, type ClientConflictComparison, type ClientEditableField } from './clientConflict';
import { useAdminRequestScope } from '../shared/useAdminRequestScope';
import {
  emptyDraft,
  archiveClientConfirmation,
  clientMatchesScope,
  readClientDeletionPreview,
  readApiError,
  readApiErrorFallback,
  toDraft,
  withoutClientCredentials,
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
  const companyDraftsRef = useRef<Record<number, ClientDraft>>({});
  const [clientPasswordEditIds, setClientPasswordEditIds] = useState<Record<number, boolean>>({});
  const clientPasswordEditIdsRef = useRef<Record<number, boolean>>({});
  const [clientPasswordDrafts, setClientPasswordDrafts] = useState<Record<number, string>>({});
  const [companyConflicts, setCompanyConflicts] = useState<Record<number, { comparison: ClientConflictComparison | null; error: string }>>({});
  const [expandedCompanyIds, setExpandedCompanyIds] = useState<Record<number, boolean>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [savedCompanyId, setSavedCompanyId] = useState<number | null>(null);

  const replaceCompanyDrafts = useCallback((update: (current: Record<number, ClientDraft>) => Record<number, ClientDraft>) => {
    const next = update(companyDraftsRef.current);
    companyDraftsRef.current = next;
    setCompanyDrafts(next);
  }, []);

  const replacePasswordEditIds = (update: (current: Record<number, boolean>) => Record<number, boolean>) => {
    const next = update(clientPasswordEditIdsRef.current);
    clientPasswordEditIdsRef.current = next;
    setClientPasswordEditIds(next);
  };

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

  const loadClients = useCallback(async (signal?: AbortSignal) => {
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
      const nextCompanies = (data.companies as ClientCompany[]).map(withoutClientCredentials).filter((company) => clientMatchesScope(company, scope));
      // Baselines belong to drafts, not to the most recent list response. Moving
      // them underneath a dirty form makes a later three-way comparison unsafe.
      const reconciled = reconcileClientDrafts(companyDraftsRef.current, nextCompanies, companyBaselines.current, clientPasswordEditIdsRef.current);
      companyBaselines.current = reconciled.baselines;
      companiesRef.current = nextCompanies;
      setCompanies(nextCompanies);
      // Even a full list refresh must not discard edits. Explicit conflict
      // resolution below is the only path that replaces a dirty draft's base.
      replaceCompanyDrafts(() => reconciled.drafts);
    } finally {
      if (sequence === loadSequence.current && scope === scopeRef.current && isActive()) setLoading(false);
    }
  }, [request, scope, isActive, replaceCompanyDrafts]);

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
      refresh: async (signal) => { await loadClients(signal); },
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

  const updateCompanyDraft = (id: number, patch: Partial<ClientDraft>) => {
    replaceCompanyDrafts((current) => ({
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
    replaceCompanyDrafts((current) => ({ ...current, [company.id]: toDraft(company) }));
    setCompanyConflicts((current) => { const next = { ...current }; delete next[company.id]; return next; });
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
    const nextDraft = companyDraftsRef.current[companyId];
    const latest = companiesRef.current.find((company) => company.id === companyId);
    if (companyConflicts[companyId] || (latest && nextDraft?.expectedUpdatedAt !== latest.updatedAt)) {
      setCompanyConflicts((current) => ({ ...current, [companyId]: current[companyId] ?? { comparison: null, error: '' } }));
      setStatus('Сначала сравните свои правки с актуальной карточкой клиента. Повторное сохранение старой формы не отправлено.');
      return;
    }
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
        replacePasswordEditIds((current) => {
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
      if (isActive()) {
        if (error instanceof ClientMutationError && (error.status === 409 || error.status === 428)) {
          setCompanyConflicts((current) => ({ ...current, [companyId]: { comparison: null, error: '' } }));
          setExpandedCompanyIds((current) => ({ ...current, [companyId]: true }));
          setSavedCompanyId(null);
        }
        setStatus(readApiErrorFallback(error, 'Не удалось подтвердить сохранение компании'));
      }
    } finally {
      finishMutation();
    }
  };

  const loadCompanyConflict = async (companyId: number) => {
    if (!startMutation()) return;
    setCompanyConflicts((current) => ({ ...current, [companyId]: { comparison: null, error: '' } }));
    try {
      // Reuse the permission-filtered list, including archives so an archived
      // client is never mistaken for a writable card or silently reactivated.
      const response = await request('/api/admin/clients?scope=all', { cache: 'no-store' });
      if (!response.ok) throw new Error(await readApiError(response, 'Не удалось загрузить актуальную карточку'));
      const data = await response.json();
      if (!isActive()) return;
      if (!Array.isArray(data.companies)) throw new Error('Получены неполные данные. Ваши правки сохранены в форме; повторите загрузку актуальной карточки.');
      const latest = (data.companies as ClientCompany[]).find((company) => company?.id === companyId);
      if (!latest) throw new Error('Клиент удалён или больше недоступен. Ваши правки оставлены в форме; сохранение недоступно.');
      if (latest.archivedAt) throw new Error('Клиент уже в архиве. Сохранение этой формы недоступно. Ваши правки оставлены в форме; восстановление выполняется отдельно в архиве.');
      const base = companyBaselines.current.get(companyId);
      const local = companyDraftsRef.current[companyId];
      if (!base || !local) throw new Error('Не удалось определить исходную версию карточки. Ваши правки не изменены.');
      const comparison = buildClientConflict(base, local, withoutClientCredentials(latest));
      companiesRef.current = companiesRef.current.map((company) => company.id === companyId ? comparison.latest : company);
      setCompanies(companiesRef.current);
      setCompanyConflicts((current) => ({ ...current, [companyId]: { comparison, error: '' } }));
    } catch (error) {
      if (isActive()) setCompanyConflicts((current) => ({ ...current, [companyId]: { comparison: null, error: readApiErrorFallback(error, 'Не удалось загрузить актуальную карточку. Ваши правки не изменены.') } }));
    } finally {
      finishMutation();
    }
  };

  const applyCompanyConflict = (companyId: number, selectedFields: ClientEditableField[], discardAll = false) => {
    if (mutationRef.current) return;
    const comparison = companyConflicts[companyId]?.comparison;
    if (!comparison) return;
    const current = companiesRef.current.find((company) => company.id === companyId);
    if (!current || current.updatedAt !== comparison.latest.updatedAt || current.archivedAt) {
      setCompanyConflicts((conflicts) => ({ ...conflicts, [companyId]: { comparison: null, error: 'Карточка снова изменилась. Загрузите актуальную карточку ещё раз; ваши правки не изменены.' } }));
      return;
    }
    const passwordPending = Boolean(clientPasswordEditIdsRef.current[companyId]);
    const prompt = (discardAll ? 'Загрузить актуальную карточку и отказаться от собственных несохранённых правок?' : 'Перенести только отмеченные правки в актуальную карточку? Остальные поля будут взяты с сервера.')
      + (passwordPending ? '\nНовый пароль не будет перенесён — задайте его заново после сравнения.' : '')
      + '\nЭто обновит только вашу форму. Для записи потребуется нажать «Сохранить».';
    if (!window.confirm(prompt)) return;
    const resolved = resolveClientConflict(comparison, selectedFields);
    // Invalidate list requests begun before this explicit local rebase.
    dataGeneration.current += 1;
    companyBaselines.current.set(companyId, comparison.latest);
    replaceCompanyDrafts((drafts) => ({ ...drafts, [companyId]: resolved }));
    setClientPasswordDrafts((drafts) => { const next = { ...drafts }; delete next[companyId]; return next; });
    replacePasswordEditIds((ids) => { const next = { ...ids }; delete next[companyId]; return next; });
    setCompanyConflicts((conflicts) => { const next = { ...conflicts }; delete next[companyId]; return next; });
    setSavedCompanyId(null);
    setStatus(`Форма обновлена по актуальной карточке. Проверьте её и нажмите «Сохранить».${passwordPending ? ' Новый пароль при необходимости задайте заново.' : ''}`);
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
      replacePasswordEditIds((current) => {
        const next = { ...current };
        delete next[company.id];
        return next;
      });
      replaceCompanyDrafts((current) => {
        const next = { ...current };
        delete next[company.id];
        return next;
      });
      setCompanyConflicts((current) => { const next = { ...current }; delete next[company.id]; return next; });
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
      replaceCompanyDrafts((current) => { const next = { ...current }; delete next[preview.id]; return next; });
      setCompanyConflicts((current) => { const next = { ...current }; delete next[preview.id]; return next; });
      setClientPasswordDrafts((current) => { const next = { ...current }; delete next[preview.id]; return next; });
      replacePasswordEditIds((current) => { const next = { ...current }; delete next[preview.id]; return next; });
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
    replacePasswordEditIds((current) => ({ ...current, [companyId]: !current[companyId] }));
    setClientPasswordDrafts((current) => {
      const next = { ...current };
      delete next[companyId];
      return next;
    });
  };

  const refreshClients = async () => {
    setBusy(true);
    try {
      await loadClients();
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

      {status ? <p role="status" className={`${styles.status} ${styles.clientSectionStatus}`}>{status}</p> : null}

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
            passwordIsEdited={Boolean(clientPasswordEditIds[company.id])}
            passwordDraft={clientPasswordDrafts[company.id] || ''}
            developmentManagers={developmentManagers}
            supportManagers={supportManagers}
            busy={busy || loading}
            isExpanded={Boolean(expandedCompanyIds[company.id])}
            isSaved={savedCompanyId === company.id}
            canPermanentlyDelete={canPermanentlyDelete}
            conflict={companyConflicts[company.id] ?? (companyDrafts[company.id]?.expectedUpdatedAt && companyDrafts[company.id].expectedUpdatedAt !== company.updatedAt ? { comparison: null, error: '' } : null)}
            managers={managers}
            onLoadConflict={loadCompanyConflict}
            onCloseConflict={(id) => setCompanyConflicts((conflicts) => ({ ...conflicts, [id]: { comparison: null, error: '' } }))}
            onResolveConflict={applyCompanyConflict}
            onDraftChange={updateCompanyDraft}
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
