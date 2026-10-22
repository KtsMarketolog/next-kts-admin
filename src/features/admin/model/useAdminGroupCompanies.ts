'use client';

import { useMemo, useState } from 'react';

import { emptyGroupCompany } from '@/features/admin/model/defaults';
import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import { readConfirmedOrder, reorderByDrop, reorderRequest } from '@/features/admin/model/reorder';
import { useAdminContentAction } from '@/features/admin/model/useAdminContentAction';
import { readContentMutationItem, readSavedContentItem } from '@/features/admin/model/adminContentRead';
import { useAdminContentRevision } from '@/features/admin/model/useAdminContentRevision';
import { useAdminDraft, useAdminDraftCollection } from '@/features/admin/model/useAdminDraftState';
import type { GroupCompany } from '@/features/admin/types';

const companyKey = (company: GroupCompany) => company.id;

export function useAdminGroupCompanies(options: AdminCrudHookOptions) {
  const { showStatus } = options;
  const perform = useAdminContentAction(options);
  const collection = useAdminDraftCollection(companyKey, options.draftScope && `${options.draftScope}:companies`);
  const revision = useAdminContentRevision(collection, options, '/api/admin/group-companies', 'companies');
  const creation = useAdminDraft(emptyGroupCompany, options.draftScope && `${options.draftScope}:new-company`);
  const groupCompanies = useMemo(() => [...collection.items].sort((a, b) => a.sortOrder - b.sortOrder), [collection.items]);
  const groupCompanyDraft = creation.value;
  const [groupCompanyCreated, setGroupCompanyCreated] = useState(false);
  const [savedGroupCompanyId, setSavedGroupCompanyId] = useState<number | null>(null);
  const [draggedGroupCompanyId, setDraggedGroupCompanyId] = useState<number | null>(null);

  const nextGroupCompanyOrder = groupCompanies.length + 1;

  const updateGroupCompany = (id: number, patch: Partial<GroupCompany>) => {
    collection.update(id, patch);
  };

  const persistGroupCompanyOrder = async (orderedCompanies: GroupCompany[]) => {
    await perform({ requests: [reorderRequest('/api/admin/group-companies', orderedCompanies)], success: 'Очередность группы компаний сохранена', failure: 'Не удалось сохранить очередность группы компаний',
      onSaved: async (responses, signal) => {
        const warnings = await readConfirmedOrder(responses[0], orderedCompanies, signal);
        for (const saved of orderedCompanies) {
          const submitted = groupCompanies.find((item) => item.id === saved.id);
          if (submitted) collection.accept(submitted, saved, ['sortOrder']);
        }
        if (warnings.length) return `Очередность группы компаний сохранена. ${warnings.join(' ')}`;
      } });
  };

  const moveGroupCompany = async (draggedId: number, targetId: number) => {
    if (options.actionLock?.current) return;
    const normalized = reorderByDrop(groupCompanies, draggedId, targetId);
    if (!normalized) return;
    await persistGroupCompanyOrder(normalized);
  };

  const createGroupCompany = async () => {
    if (!groupCompanyDraft.imageUrl) {
      showStatus('Добавьте картинку для группы компаний');
      return;
    }

    const submitted = groupCompanyDraft;
    await perform({ requests: [{ url: '/api/admin/group-companies', init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...submitted, sortOrder: nextGroupCompanyOrder }),
    } }], success: 'Компания добавлена', failure: 'Не удалось добавить компанию', onSaved: async (responses, signal) => {
      const result = await responses[0].json();
      if (!Number.isSafeInteger(result?.id) || result.id <= 0) throw new Error('Ответ не содержит номер созданной компании');
      const saved = await readSavedContentItem<GroupCompany>('/api/admin/group-companies', 'companies', (item) => item.id === result.id, signal);
      signal.throwIfAborted();
      collection.accept(saved, saved);
      creation.resetAfterSave(submitted);
      setGroupCompanyCreated(true);
      window.setTimeout(() => setGroupCompanyCreated(false), 2000);
    } });
  };

  const saveGroupCompany = async (company: GroupCompany) => {
    await perform({ requests: [{ url: `/api/admin/group-companies/${company.id}`, init: {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(company),
    } }], success: 'Компания сохранена', failure: 'Не удалось сохранить компанию', onConflict: () => revision.flag(company.id), onSaved: async (responses, signal) => {
      const saved = await readContentMutationItem<GroupCompany>(responses[0], company.id);
      signal.throwIfAborted();
      collection.accept(company, saved);
      revision.clear(company.id);
      setSavedGroupCompanyId(company.id);
      window.setTimeout(() => setSavedGroupCompanyId((current) => (current === company.id ? null : current)), 2000);
    } });
  };

  const deleteGroupCompany = async (id: number) => {
    if (!confirm('Удалить компанию из группы компаний?')) return;
    await perform({ requests: [{ url: `/api/admin/group-companies/${id}`, init: { method: 'DELETE' } }],
      success: 'Компания удалена', failure: 'Не удалось удалить компанию',
      onSaved: () => { collection.remove(id); } });
  };

  return {
    groupCompanies,
    setGroupCompanies: collection.hydrate,
    groupCompanyDraft,
    setGroupCompanyDraft: creation.setValue,
    dirtyCount: collection.dirtyKeys.size + Number(creation.dirty),
    dirtyKeys: collection.dirtyKeys,
    conflictIds: revision.conflicts,
    reloadGroupCompany: revision.reload,
    nextGroupCompanyOrder,
    draggedGroupCompanyId,
    setDraggedGroupCompanyId,
    groupCompanyCreated,
    savedGroupCompanyId,
    updateGroupCompany,
    moveGroupCompany,
    createGroupCompany,
    saveGroupCompany,
    deleteGroupCompany,
  };
}
