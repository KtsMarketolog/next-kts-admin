'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { startClientRealtimeSync } from '@/shared/lib/clientRealtimeSync';
import { reconcileClientDrafts } from './clientConflict';
import { clientMatchesScope, readApiError, readApiErrorFallback, toDraft, withoutClientCredentials, type ClientCompany, type ClientListScope, type Manager } from './AdminClientsModel';
import type { AdminClientDraftState } from './useAdminClientDrafts';
import type { AdminClientOperations } from './useAdminClientOperations';

/** Permission-filtered reads refresh only clean drafts and never move a dirty baseline. */
export function useAdminClientList(operations: AdminClientOperations, editor: AdminClientDraftState) {
  const { request, isActive, mutationRef, dataGeneration, showStatus, setStatus, setBusy } = operations;
  const { scope, scopeRef, setScope, companyBaselines, companyDraftsRef, clientPasswordEditIdsRef, replaceCompanyDrafts, setCompanyConflicts } = editor;
  const [companies, setCompanies] = useState<ClientCompany[]>([]);
  const companiesRef = useRef<ClientCompany[]>([]);
  const loadSequence = useRef(0);
  const [loading, setLoading] = useState(true);
  const [canPermanentlyDelete, setCanPermanentlyDelete] = useState(false);
  const [managers, setManagers] = useState<Manager[]>([]);

  const developmentManagers = useMemo(
    () => managers.filter((manager) => manager.role === 'manager' && manager.isActive),
    [managers],
  );
  const supportManagers = useMemo(
    () => managers.filter((manager) => manager.role === 'support_manager' && manager.isActive),
    [managers],
  );

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
  }, [request, scope, isActive, replaceCompanyDrafts, clientPasswordEditIdsRef, companyBaselines, companyDraftsRef, dataGeneration, mutationRef, scopeRef]);

  const loadManagers = useCallback(async () => {
    const response = await request('/api/admin/wholesale/managers', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    setManagers(Array.isArray(data.managers) ? data.managers : []);
  }, [request]);

  useEffect(() => {
    void loadManagers().catch((error) => {
      showStatus(readApiErrorFallback(error, 'Не удалось загрузить клиентов'));
    });
  }, [loadManagers, showStatus]);

  useEffect(() => {
    return startClientRealtimeSync({
      eventsEndpoint: '/api/admin/clients/events',
      eventTypes: ['chat.updated', 'client.updated'],
      refresh: async (signal) => { await loadClients(signal); },
      onError: (error) => { setStatus(readApiErrorFallback(error, 'Не удалось обновить клиентов')); },
    });
  }, [loadClients, setStatus]);

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


  return { companies, companiesRef, setCompanies, loading, canPermanentlyDelete, managers,
    developmentManagers, supportManagers, acceptSavedCompany, selectScope, refreshClients };
}

export type AdminClientListState = ReturnType<typeof useAdminClientList>;
