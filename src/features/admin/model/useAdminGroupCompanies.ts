'use client';

import { useState } from 'react';

import { emptyGroupCompany } from '@/features/admin/model/defaults';
import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import { reorderByDrop } from '@/features/admin/model/reorder';
import type { GroupCompany } from '@/features/admin/types';

export function useAdminGroupCompanies({ setBusy, showStatus, reloadAdminData }: AdminCrudHookOptions) {
  const [groupCompanies, setGroupCompanies] = useState<GroupCompany[]>([]);
  const [groupCompanyDraft, setGroupCompanyDraft] = useState(emptyGroupCompany);
  const [groupCompanyCreated, setGroupCompanyCreated] = useState(false);
  const [draggedGroupCompanyId, setDraggedGroupCompanyId] = useState<number | null>(null);

  const nextGroupCompanyOrder = groupCompanies.length + 1;

  const updateGroupCompany = (id: number, patch: Partial<GroupCompany>) => {
    setGroupCompanies((current) =>
      current.map((company) => (company.id === id ? { ...company, ...patch } : company)),
    );
  };

  const persistGroupCompanyOrder = async (orderedCompanies: GroupCompany[]) => {
    setBusy(true);
    const responses = await Promise.all(
      orderedCompanies.map((company) =>
        fetch(`/api/admin/group-companies/${company.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(company),
        }),
      ),
    );
    setBusy(false);

    const saved = responses.every((res) => res.ok);
    showStatus(saved ? 'Очередность группы компаний сохранена' : 'Не удалось сохранить очередность группы компаний');
    if (saved) await reloadAdminData();
  };

  const moveGroupCompany = async (draggedId: number, targetId: number) => {
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

    setBusy(true);
    const res = await fetch('/api/admin/group-companies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...groupCompanyDraft, sortOrder: nextGroupCompanyOrder }),
    });
    setBusy(false);
    showStatus(res.ok ? 'Компания добавлена' : 'Не удалось добавить компанию');
    if (res.ok) {
      setGroupCompanyCreated(true);
      window.setTimeout(() => setGroupCompanyCreated(false), 2000);
      setGroupCompanyDraft(emptyGroupCompany);
      await reloadAdminData();
    }
  };

  const saveGroupCompany = async (company: GroupCompany) => {
    setBusy(true);
    const res = await fetch(`/api/admin/group-companies/${company.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(company),
    });
    setBusy(false);
    showStatus(res.ok ? 'Компания сохранена' : 'Не удалось сохранить компанию');
    if (res.ok) await reloadAdminData();
  };

  const deleteGroupCompany = async (id: number) => {
    if (!confirm('Удалить компанию из группы компаний?')) return;
    setBusy(true);
    const res = await fetch(`/api/admin/group-companies/${id}`, { method: 'DELETE' });
    setBusy(false);
    showStatus(res.ok ? 'Компания удалена' : 'Не удалось удалить компанию');
    if (res.ok) await reloadAdminData();
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
    updateGroupCompany,
    moveGroupCompany,
    createGroupCompany,
    saveGroupCompany,
    deleteGroupCompany,
  };
}
