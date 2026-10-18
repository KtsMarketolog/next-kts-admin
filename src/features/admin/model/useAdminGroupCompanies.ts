'use client';

import { useState } from 'react';

import { emptyGroupCompany } from '@/features/admin/model/defaults';
import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import { reorderByDrop } from '@/features/admin/model/reorder';
import { useAdminContentAction } from '@/features/admin/model/useAdminContentAction';
import type { GroupCompany } from '@/features/admin/types';

export function useAdminGroupCompanies(options: AdminCrudHookOptions) {
  const { showStatus } = options;
  const perform = useAdminContentAction(options);
  const [groupCompanies, setGroupCompanies] = useState<GroupCompany[]>([]);
  const [groupCompanyDraft, setGroupCompanyDraft] = useState(emptyGroupCompany);
  const [groupCompanyCreated, setGroupCompanyCreated] = useState(false);
  const [savedGroupCompanyId, setSavedGroupCompanyId] = useState<number | null>(null);
  const [draggedGroupCompanyId, setDraggedGroupCompanyId] = useState<number | null>(null);

  const nextGroupCompanyOrder = groupCompanies.length + 1;

  const updateGroupCompany = (id: number, patch: Partial<GroupCompany>) => {
    setGroupCompanies((current) =>
      current.map((company) => (company.id === id ? { ...company, ...patch } : company)),
    );
  };

  const persistGroupCompanyOrder = async (orderedCompanies: GroupCompany[]) => {
    await perform({ requests: orderedCompanies.map((company) => ({ url: `/api/admin/group-companies/${company.id}`, init: {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(company),
        } })), success: 'Очередность группы компаний сохранена', failure: 'Не удалось сохранить очередность группы компаний' });
  };

  const moveGroupCompany = async (draggedId: number, targetId: number) => {
    if (options.actionLock?.current) return;
    const normalized = reorderByDrop(groupCompanies, draggedId, targetId);
    if (!normalized) return;
    setGroupCompanies(normalized);
    await persistGroupCompanyOrder(normalized);
  };

  const createGroupCompany = async () => {
    if (!groupCompanyDraft.imageUrl) {
      showStatus('Добавьте картинку для группы компаний');
      return;
    }

    await perform({ requests: [{ url: '/api/admin/group-companies', init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...groupCompanyDraft, sortOrder: nextGroupCompanyOrder }),
    } }], success: 'Компания добавлена', failure: 'Не удалось добавить компанию', onSaved: () => {
      setGroupCompanyCreated(true);
      window.setTimeout(() => setGroupCompanyCreated(false), 2000);
      setGroupCompanyDraft(emptyGroupCompany);
    } });
  };

  const saveGroupCompany = async (company: GroupCompany) => {
    await perform({ requests: [{ url: `/api/admin/group-companies/${company.id}`, init: {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(company),
    } }], success: 'Компания сохранена', failure: 'Не удалось сохранить компанию', onSaved: () => {
      setSavedGroupCompanyId(company.id);
      window.setTimeout(() => setSavedGroupCompanyId((current) => (current === company.id ? null : current)), 2000);
    } });
  };

  const deleteGroupCompany = async (id: number) => {
    if (!confirm('Удалить компанию из группы компаний?')) return;
    await perform({ requests: [{ url: `/api/admin/group-companies/${id}`, init: { method: 'DELETE' } }],
      success: 'Компания удалена', failure: 'Не удалось удалить компанию' });
  };

  return {
    groupCompanies,
    setGroupCompanies,
    groupCompanyDraft,
    setGroupCompanyDraft,
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
