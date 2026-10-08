'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DASHBOARD_AUDIENCE_ROLES,
  dashboardAudienceRoleEmployeeIds,
  dashboardAudienceRoleLabel,
  filterDashboardAudience,
  selectDashboardAudienceEmployees,
  selectAllDashboardAudience,
  type DashboardAudienceMode,
  type DashboardAudienceEmployee,
} from './DashboardAudienceSelection';
import styles from './DashboardAudienceEditor.module.scss';

type Audience = { users: DashboardAudienceEmployee[]; version: string; key: string; mode: DashboardAudienceMode };

export function DashboardAudienceEditor({ dashboardKey }: { dashboardKey: string }) {
  const [data, setData] = useState<Audience | null>(null);
  const [hidden, setHidden] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedRole, setSelectedRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const requestGeneration = useRef(0);
  const currentData = data?.key === dashboardKey ? data : null;

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setBusy(true);
    setMessage('');
    setHidden(false);
    try {
      const response = await fetch(`/api/admin/dashboard-access?key=${encodeURIComponent(dashboardKey)}`, { cache: 'no-store' });
      if (generation !== requestGeneration.current) return;
      if (response.status === 401 || response.status === 403) {
        setHidden(true);
        return;
      }
      if (!response.ok) throw new Error('Не удалось загрузить сотрудников.');
      const result = await response.json();
      if (generation === requestGeneration.current) setData({ ...result, mode: result.mode ?? 'individual', key: dashboardKey });
    } catch (error) {
      if (generation === requestGeneration.current) setMessage(error instanceof Error ? error.message : 'Не удалось загрузить сотрудников.');
    } finally {
      if (generation === requestGeneration.current) setBusy(false);
    }
  }, [dashboardKey]);

  useEffect(() => {
    void load();
    // Ignore an old dashboard's response after navigation or unmount.
    return () => { requestGeneration.current += 1; };
  }, [load]);

  const visible = useMemo(() => filterDashboardAudience(currentData?.users ?? [], selectedRole, search), [currentData, selectedRole, search]);
  const roleEmployeeIds = useMemo(() => dashboardAudienceRoleEmployeeIds(currentData?.users ?? [], selectedRole), [currentData, selectedRole]);

  const select = (ids: string[], checked: boolean) => {
    setData((current) => current?.key === dashboardKey ? {
      ...current,
      users: selectDashboardAudienceEmployees(current.users, ids, checked),
    } : current);
  };

  const save = async () => {
    if (!currentData) return;
    const generation = ++requestGeneration.current;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/admin/dashboard-access', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: dashboardKey,
          version: currentData.version,
          mode: currentData.mode,
          userIds: currentData.users.filter((user) => user.checked && user.eligible).map((user) => user.id),
        }),
      });
      const result = await response.json();
      if (generation !== requestGeneration.current) return;
      if (!response.ok) throw new Error(result.error || 'Не удалось сохранить доступы');
      setData({ ...result, mode: result.mode ?? 'individual', key: dashboardKey });
      setMessage('Доступы сохранены.');
    } catch (error) {
      if (generation === requestGeneration.current) setMessage(error instanceof Error ? error.message : 'Не удалось сохранить доступы');
    } finally {
      if (generation === requestGeneration.current) setBusy(false);
    }
  };

  if (hidden) return null;
  return <section className={styles.editor}>
    <h2>Кому доступен отчёт</h2>
    <p>Те же галочки доступны в карточке сотрудника. Загрузка файлов, публикация и назначение доступов регулируются отдельно. Личные снимки доступны только их владельцам.</p>
    <div className={styles.roleToolbar}>
      <label>
        <span>Роль сотрудников</span>
        <select aria-label="Роль сотрудников" value={selectedRole} onChange={(event) => setSelectedRole(event.target.value)}>
          <option value="">Все роли</option>
          {DASHBOARD_AUDIENCE_ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
        </select>
      </label>
      <button type="button" disabled={busy || !roleEmployeeIds.length} onClick={() => select(roleEmployeeIds, true)}>Выбрать сотрудников роли</button>
      <button type="button" disabled={busy || !roleEmployeeIds.length} onClick={() => select(roleEmployeeIds, false)}>Снять выбор роли</button>
    </div>
    <p>Выбор по роли отмечает только текущих активных сотрудников этой роли, независимо от поиска. После этого можно изменить галочки по одному. Сам выбор роли не добавляет будущих сотрудников.</p>
    <div className={styles.toolbar}>
      <input aria-label="Поиск сотрудников" placeholder="Имя или логин сотрудника" value={search} onChange={(event) => setSearch(event.target.value)} />
      <button type="button" disabled={busy || !currentData} onClick={() => setData((current) => current?.key === dashboardKey ? {...current, mode: 'all', users: selectAllDashboardAudience(current.users)} : current)}>Выбрать всех</button>
      <button type="button" disabled={busy || !currentData} onClick={() => setData((current) => current?.key === dashboardKey ? {...current, mode: 'individual', users: selectDashboardAudienceEmployees(current.users, current.users.map((user) => user.id), false)} : current)}>Снять выбор</button>
      <button type="button" disabled={busy} onClick={() => void load()}>Обновить список</button>
    </div>
    <p>«Выбрать всех» включает доступ всем нынешним и будущим сотрудникам, независимо от фильтров. Неактивные сотрудники получат доступ только после активации. Личные отчёты — только своей группы и со своим снимком.</p>
    {currentData && <p>{currentData.mode === 'all' ? 'Режим: все сотрудники, включая будущих. Снятая галочка — персональное исключение.' : 'Режим: только выбранные сотрудники. Новым сотрудникам доступ автоматически не добавляется.'}</p>}
    {currentData?.mode === 'all' && <button type="button" disabled={busy} onClick={() => setData((current) => current?.key === dashboardKey ? {...current, mode: 'individual'} : current)}>Оставить только текущий выбор</button>}
    <p>Изменения применяются после нажатия «Сохранить доступы».</p>
    <div className={styles.employees}>{visible.map((user) => <label key={user.id}>
      <input type="checkbox" checked={user.checked} disabled={busy || user.locked || !user.eligible} onChange={(event) => select([user.id], event.target.checked)} />
      <span><strong>{user.name}</strong><small>{user.login} · {dashboardAudienceRoleLabel(user.role)}{!user.isActive ? ' · Неактивен' : ''}{user.locked ? ' · Доступ по правам управления' : !user.eligible ? ' · Нет собственного личного отчёта этой группы' : ''}</small></span>
    </label>)}</div>
    {currentData && visible.length === 0 && <p>Сотрудники не найдены.</p>}
    <button type="button" disabled={busy || !currentData} onClick={() => void save()}>{busy ? 'Подождите…' : 'Сохранить доступы'}</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
