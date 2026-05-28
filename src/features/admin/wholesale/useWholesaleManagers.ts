'use client';

import { useCallback, useMemo, useState } from 'react';

import {
  removeWholesaleManagerPassword as removeManagerPassword,
  saveWholesaleManagerPassword as saveManagerPassword,
} from '@/shared/lib/adminPasswordStorage';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';

import {
  attachManagerPasswords,
  emptyManager,
  readApiError,
  readManagerRoleTab,
  type Manager,
  type ManagerRole,
} from './AdminWholesaleModel';

type UseWholesaleManagersOptions = {
  showStatus: (message: string) => void;
};

export function useWholesaleManagers({ showStatus }: UseWholesaleManagersOptions) {
  const [managers, setManagers] = useState<Manager[]>([]);
  const [managerDraft, setManagerDraft] = useState(emptyManager);
  const [managerBusy, setManagerBusy] = useState(false);
  const [savedManagerId, setSavedManagerId] = useState<number | null>(null);
  const [managerCreated, setManagerCreated] = useState(false);
  const [managerRoleTab, setManagerRoleTab] = useState<ManagerRole>(() => readManagerRoleTab());
  const [managerPasswordDrafts, setManagerPasswordDrafts] = useState<Record<number, string>>({});
  const [managerPasswordEditIds, setManagerPasswordEditIds] = useState<Record<number, boolean>>({});

  const supportManagers = useMemo(
    () =>
      managers
        .filter((manager) => manager.role === 'support_manager' && manager.isActive)
        .sort((first, second) => Number(second.isActive) - Number(first.isActive) || first.name.localeCompare(second.name, 'ru')),
    [managers],
  );
  const developmentManagers = useMemo(() => managers.filter((manager) => manager.role === 'manager'), [managers]);
  const supportManagerRows = useMemo(() => managers.filter((manager) => manager.role === 'support_manager'), [managers]);
  const managerRoleLabel = managerRoleTab === 'support_manager' ? 'менеджера по сопровождению' : 'менеджера по развитию';
  const managerRoleTitle = managerRoleTab === 'support_manager' ? 'Менеджер по сопровождению' : 'Менеджер по развитию';
  const managerRoleRows = managerRoleTab === 'support_manager' ? supportManagerRows : developmentManagers;

  const loadManagers = useCallback(async () => {
    const res = await fetch('/api/admin/wholesale/managers', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    setManagers(attachManagerPasswords(Array.isArray(data.managers) ? data.managers : []));
  }, []);

  const validateManagerPassword = useCallback(
    (password: string) => {
      const passwordPolicy = validatePasswordPolicy(password);
      if (!passwordPolicy.ok) {
        showStatus(passwordPolicy.error || 'Пароль не подходит. Измените пароль и сохраните снова.');
        return false;
      }
      return true;
    },
    [showStatus],
  );

  const copyManagerPassword = useCallback(
    async (password?: string) => {
      if (!password) return;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(password);
        } else {
          const textarea = document.createElement('textarea');
          textarea.value = password;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          document.execCommand('copy');
          textarea.remove();
        }
        showStatus('Пароль скопирован');
      } catch {
        showStatus('Не удалось скопировать пароль');
      }
    },
    [showStatus],
  );

  const createManager = useCallback(async () => {
    if (!managerDraft.name.trim() || !managerDraft.login.trim() || !managerDraft.password.trim()) {
      showStatus(`Заполните имя, логин и пароль ${managerRoleLabel}`);
      return;
    }
    if (!validateManagerPassword(managerDraft.password.trim())) return;

    setManagerBusy(true);
    const res = await fetch('/api/admin/wholesale/managers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...managerDraft,
        name: managerDraft.name.trim(),
        login: managerDraft.login.trim(),
        email: managerDraft.email.trim(),
        phone: managerDraft.phone.trim(),
        role: managerRoleTab,
        supportManagerId: null,
        password: managerDraft.password.trim(),
      }),
    });
    setManagerBusy(false);
    if (!res.ok) {
      showStatus(await readApiError(res, 'Не удалось добавить менеджера'));
      return;
    }

    const data = await res.json().catch(() => ({}));
    const createdId = Number(data.id);
    if (Number.isInteger(createdId) && createdId > 0) saveManagerPassword(createdId, managerDraft.password.trim());
    showStatus(`${managerRoleTitle} добавлен`);
    setManagerCreated(true);
    setManagerDraft(emptyManager);
    await loadManagers();
    window.setTimeout(() => setManagerCreated(false), 2200);
  }, [loadManagers, managerDraft, managerRoleLabel, managerRoleTab, managerRoleTitle, showStatus, validateManagerPassword]);

  const saveManager = useCallback(
    async (manager: Manager) => {
      const passwordIsEdited = Boolean(managerPasswordEditIds[manager.id]);
      const nextPassword = passwordIsEdited ? (managerPasswordDrafts[manager.id] || '').trim() : '';
      if (passwordIsEdited && !nextPassword) {
        showStatus('Введите новый пароль или нажмите «Отменить пароль»');
        return;
      }
      if (nextPassword && !validateManagerPassword(nextPassword)) return;

      setManagerBusy(true);
      const res = await fetch(`/api/admin/wholesale/managers/${manager.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...manager,
          name: manager.name.trim(),
          login: manager.login.trim(),
          email: manager.email.trim(),
          phone: manager.phone.trim(),
          password: nextPassword,
          supportManagerId: null,
        }),
      });
      setManagerBusy(false);
      if (!res.ok) {
        showStatus(await readApiError(res, 'Не удалось сохранить менеджера'));
        return;
      }

      if (nextPassword) saveManagerPassword(manager.id, nextPassword);
      setManagerPasswordDrafts((current) => {
        const next = { ...current };
        delete next[manager.id];
        return next;
      });
      setManagerPasswordEditIds((current) => {
        const next = { ...current };
        delete next[manager.id];
        return next;
      });
      showStatus('Менеджер сохранён');
      setSavedManagerId(manager.id);
      await loadManagers();
      window.setTimeout(() => {
        setSavedManagerId((current) => (current === manager.id ? null : current));
      }, 2200);
    },
    [loadManagers, managerPasswordDrafts, managerPasswordEditIds, showStatus, validateManagerPassword],
  );

  const deleteManager = useCallback(
    async (id: number) => {
      if (!confirm('Удалить менеджера? Его прайсы останутся без менеджера.')) return;
      setManagerBusy(true);
      const res = await fetch(`/api/admin/wholesale/managers/${id}`, { method: 'DELETE' });
      setManagerBusy(false);
      showStatus(res.ok ? 'Менеджер удалён' : 'Не удалось удалить менеджера');
      if (res.ok) {
        removeManagerPassword(id);
        await loadManagers();
      }
    },
    [loadManagers, showStatus],
  );

  return {
    managers,
    setManagers,
    managerDraft,
    setManagerDraft,
    managerBusy,
    savedManagerId,
    managerCreated,
    setManagerCreated,
    managerRoleTab,
    setManagerRoleTab,
    managerPasswordDrafts,
    setManagerPasswordDrafts,
    managerPasswordEditIds,
    setManagerPasswordEditIds,
    supportManagers,
    developmentManagers,
    managerRoleLabel,
    managerRoleTitle,
    managerRoleRows,
    loadManagers,
    copyManagerPassword,
    createManager,
    saveManager,
    deleteManager,
  };
}
