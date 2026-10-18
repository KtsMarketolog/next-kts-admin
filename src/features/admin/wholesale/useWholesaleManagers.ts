'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { createEmployeeActionLock, employeeRequest, withoutEmployeePassword } from '../shared/employeeRequest';
import { normalizeManagers, emptyManager, readManagerRoleTab, type Manager, type ManagerRole } from './AdminWholesaleModel';

type UseWholesaleManagersOptions = { showStatus: (message: string) => void };

export function useWholesaleManagers({ showStatus }: UseWholesaleManagersOptions) {
  const [managers, setManagers] = useState<Manager[]>([]);
  const [managerDraft, setManagerDraft] = useState(emptyManager);
  const [managerBusy, setManagerBusy] = useState(false);
  const [managerRequestError, setManagerRequestError] = useState<string | null>(null);
  const [savedManagerId, setSavedManagerId] = useState<number | null>(null);
  const [managerCreated, setManagerCreated] = useState(false);
  const [managerRoleTab, setManagerRoleTab] = useState<ManagerRole>(() => readManagerRoleTab());
  const [managerPasswordDrafts, setManagerPasswordDrafts] = useState<Record<number, string>>({});
  const [managerPasswordEditIds, setManagerPasswordEditIds] = useState<Record<number, boolean>>({});
  const actionLock = useRef(createEmployeeActionLock());
  const statusRef = useRef(showStatus);
  useEffect(() => { statusRef.current = showStatus; }, [showStatus]);

  const supportManagers = useMemo(() => managers.filter((manager) => manager.role === 'support_manager' && manager.isActive)
    .sort((first, second) => first.name.localeCompare(second.name, 'ru')), [managers]);
  const developmentManagers = useMemo(() => managers.filter((manager) => manager.role === 'manager'), [managers]);
  const supportManagerRows = useMemo(() => managers.filter((manager) => manager.role === 'support_manager'), [managers]);
  const managerRoleLabel = managerRoleTab === 'support_manager' ? 'менеджера по сопровождению' : 'менеджера по развитию';
  const managerRoleTitle = managerRoleTab === 'support_manager' ? 'Менеджер по сопровождению' : 'Менеджер по развитию';
  const managerRoleRows = managerRoleTab === 'support_manager' ? supportManagerRows : developmentManagers;

  const readManagers = useCallback(async () => {
    const data = await employeeRequest<{ managers: Manager[] }>('/api/admin/wholesale/managers');
    return normalizeManagers(Array.isArray(data.managers) ? data.managers.map(withoutEmployeePassword) : []);
  }, []);

  const runAction = useCallback(async (action: (committed: () => void) => Promise<void>) => {
    if (!actionLock.current.acquire()) return;
    setManagerBusy(true);
    setManagerRequestError(null);
    let committed = false;
    try {
      await action(() => { committed = true; });
    } catch (error) {
      const message = committed ? 'Изменение сохранено, но обновить список не удалось. Обновите список перед следующей операцией.'
        : error instanceof Error ? error.message : 'Не удалось выполнить запрос';
      setManagerRequestError(message);
      statusRef.current(message);
    } finally {
      actionLock.current.release();
      setManagerBusy(false);
    }
  }, []);

  const loadManagers = useCallback(async () => runAction(async () => {
    setManagers(await readManagers());
    setManagerPasswordDrafts({});
    setManagerPasswordEditIds({});
  }), [readManagers, runAction]);

  const validateManagerPassword = (password: string) => {
    const policy = validatePasswordPolicy(password);
    if (!policy.ok) { statusRef.current(policy.error || 'Пароль не подходит'); return false; }
    return true;
  };

  const createManager = async () => {
    if (!managerDraft.name.trim() || !managerDraft.login.trim() || !managerDraft.password.trim()) {
      statusRef.current(`Заполните имя, логин и пароль ${managerRoleLabel}`); return;
    }
    if (!validateManagerPassword(managerDraft.password.trim())) return;
    await runAction(async (committed) => {
      const data = await employeeRequest<{ id: number }>('/api/admin/wholesale/managers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...managerDraft,
          name: managerDraft.name.trim(), login: managerDraft.login.trim(), email: managerDraft.email.trim(), phone: managerDraft.phone.trim(),
          role: managerRoleTab, supportManagerId: null, password: managerDraft.password.trim(),
        }),
      }, { mutation: true });
      committed();
      setManagerDraft(emptyManager);
      const fresh = (await readManagers()).find((manager) => manager.id === Number(data.id));
      if (!fresh) throw new Error('Created manager absent from list');
      setManagers((current) => [...current.filter((manager) => manager.id !== fresh.id), fresh]);
      setManagerCreated(true);
      statusRef.current(`${managerRoleTitle} добавлен`);
      window.setTimeout(() => setManagerCreated(false), 2200);
    });
  };

  const saveManager = async (manager: Manager) => {
    const edited = Boolean(managerPasswordEditIds[manager.id]);
    const password = edited ? (managerPasswordDrafts[manager.id] || '').trim() : '';
    if (edited && !password) { statusRef.current('Введите новый пароль или нажмите «Отменить пароль»'); return; }
    if (password && !validateManagerPassword(password)) return;
    await runAction(async (committed) => {
      await employeeRequest(`/api/admin/wholesale/managers/${manager.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...withoutEmployeePassword(manager),
          expectedRevision: manager.revision,
          name: manager.name.trim(), login: manager.login.trim(), email: manager.email.trim(), phone: manager.phone.trim(), password, supportManagerId: null,
        }),
      }, { mutation: true });
      committed();
      setManagerPasswordDrafts((current) => { const next = { ...current }; delete next[manager.id]; return next; });
      setManagerPasswordEditIds((current) => { const next = { ...current }; delete next[manager.id]; return next; });
      const fresh = (await readManagers()).find((item) => item.id === manager.id);
      if (!fresh) throw new Error('Saved manager absent from list');
      // Do not discard unsaved changes in other rows when refreshing this one.
      setManagers((current) => current.map((item) => item.id === manager.id ? fresh : item));
      statusRef.current('Менеджер сохранён');
      setSavedManagerId(manager.id);
      window.setTimeout(() => setSavedManagerId((current) => current === manager.id ? null : current), 2200);
    });
  };

  const deleteManager = async (id: number) => {
    if (actionLock.current.isBusy() || !confirm('Удалить менеджера? Его прайсы останутся без менеджера.')) return;
    await runAction(async () => {
      await employeeRequest(`/api/admin/wholesale/managers/${id}`, { method: 'DELETE' }, { mutation: true });
      setManagers((current) => current.filter((manager) => manager.id !== id));
      statusRef.current('Менеджер удалён');
    });
  };

  return { managers, setManagers, managerDraft, setManagerDraft, managerBusy, managerRequestError, savedManagerId, managerCreated, setManagerCreated,
    managerRoleTab, setManagerRoleTab, managerPasswordDrafts, setManagerPasswordDrafts, managerPasswordEditIds, setManagerPasswordEditIds,
    supportManagers, developmentManagers, managerRoleLabel, managerRoleTitle, managerRoleRows, loadManagers, createManager, saveManager, deleteManager };
}
