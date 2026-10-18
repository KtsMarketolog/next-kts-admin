'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import adminStyles from '@/app/admin/admin.module.scss';
import { useAdminRequestScope } from '@/features/admin/shared/useAdminRequestScope';
import { ADMIN_SNAPSHOT_TIMEOUT_MS, ADMIN_UPLOAD_TIMEOUT_MS } from '@/features/admin/shared/adminRequest';
import { MANAGER_DASHBOARD_TITLES, type PersonalDashboardAudience } from '@/shared/lib/managerDashboardAudience';

import { ManagerDashboardManagement } from './ManagerDashboardManagement';
import { ManagerDashboardViewer, managerDashboardViewIdentity } from './ManagerDashboardViewer';
import { RoutePlannerDashboard } from './RoutePlannerDashboard';
import type { ManagerDashboardMutationResult, ManagerDashboardOverview } from './types';
import styles from './ManagerDashboard.module.scss';

const API_PATH = '/api/admin/manager-dashboard';

function reportVersionsChanged(next: Extract<ManagerDashboardOverview, { mode: 'view' }>, current: Extract<ManagerDashboardOverview, { mode: 'view' }>) {
  return next.htmlVersion?.id !== current.htmlVersion?.id || next.snapshot?.id !== current.snapshot?.id;
}

async function readResponse(response: Response) {
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error : 'Не удалось выполнить запрос. Попробуйте ещё раз.';
    throw new Error(message);
  }
  if (!data || typeof data !== 'object') throw new Error('Сервер вернул некорректный ответ.');
  return data;
}

type PersonalDashboardProps = {
  mode: 'manage' | 'view';
  audience?: PersonalDashboardAudience | null;
  canAssignAccess?: boolean;
  canViewOwn?: boolean;
  own?: boolean;
  ownReturn?: 'team' | 'manage';
};

export function ManagerDashboard(props: PersonalDashboardProps & { section?: 'personal' | 'shared' }) {
  return props.section === 'shared' ? <RoutePlannerDashboard mode={props.mode} canAssignAccess={props.canAssignAccess} /> : <PersonalManagerDashboard key={props.own ? 'own' : 'manager'} {...props} />;
}

function PersonalManagerDashboard({ mode, audience = null, canAssignAccess = false, canViewOwn = false, own = false, ownReturn = 'manage' }: PersonalDashboardProps) {
  const router = useRouter();
  const apiPath = own ? `${API_PATH}/own` : API_PATH;
  const [overview, setOverview] = useState<ManagerDashboardOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const requestRevision = useRef(0);
  const busyRef = useRef(false);
  const mutationController = useRef<AbortController | null>(null);
  const { request, cancelAll } = useAdminRequestScope();
  useEffect(() => () => { mutationController.current?.abort(); }, []);
  const cancelMutation = () => { mutationController.current?.abort(); cancelAll(); };

  const load = useCallback(async (signal?: AbortSignal) => {
    const revision = ++requestRevision.current;
    setLoading(true);
    try {
      const response = await request(apiPath, { cache: 'no-store', credentials: 'same-origin', signal });
      if (response.status === 401 || response.status === 403) {
        setOverview(null);
        router.replace('/admin');
      }
      const next = await readResponse(response) as ManagerDashboardOverview;
      if (next.mode !== mode) throw new Error('Права доступа изменились. Откройте раздел заново.');
      if (revision === requestRevision.current) {
        setOverview(next);
        setUpdateAvailable(false);
      }
    } finally {
      if (revision === requestRevision.current) setLoading(false);
    }
  }, [apiPath, mode, router, request]);

  useEffect(() => {
    void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Не удалось загрузить дашборд.'));
    return () => { requestRevision.current += 1; };
  }, [load]);

  useEffect(() => {
    if (overview?.mode !== 'view') return;
    const controller = new AbortController();
    let disposed = false;
    let checking = false;
    const check = async () => {
      if (checking || document.visibilityState === 'hidden') return;
      checking = true;
      try {
        const response = await request(apiPath, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (disposed) return;
        if (response.status === 401 || response.status === 403) {
          setOverview(null);
          router.replace('/admin');
          return;
        }
        const next = await readResponse(response) as ManagerDashboardOverview;
        if (!disposed && next.mode === 'view') {
          if (managerDashboardViewIdentity(next) !== managerDashboardViewIdentity(overview)) {
            // Clear personal data immediately when its recipient changes.
            setOverview(next);
            setUpdateAvailable(false);
            return;
          }
          setUpdateAvailable(reportVersionsChanged(next, overview));
        }
      } catch {
        // A background check must not interrupt an already decrypted report.
      } finally {
        checking = false;
      }
    };
    const onFocus = () => { void check(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const interval = window.setInterval(onFocus, 60_000);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [apiPath, overview, router, request]);

  async function refresh() {
    setError('');
    try {
      await load();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось обновить данные.');
      return false;
    }
  }

  async function mutate(path: string, init: RequestInit, successMessage: string): Promise<ManagerDashboardMutationResult | null> {
    if (own || busyRef.current) return null;
    busyRef.current = true;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    mutationController.current = controller;
    init.signal?.addEventListener('abort', cancel, { once: true });
    if (init.signal?.aborted) controller.abort();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await request(`${API_PATH}${path}`, { ...init, credentials: 'same-origin', signal: controller.signal }, {
        timeoutMs: path.includes('snapshots') || path === '/shared/json' ? ADMIN_SNAPSHOT_TIMEOUT_MS
          : init.body instanceof FormData ? ADMIN_UPLOAD_TIMEOUT_MS : undefined,
      });
      if (response.status === 401 || response.status === 403) {
        setOverview(null);
        router.replace('/admin');
      }
      const result = await readResponse(response) as ManagerDashboardMutationResult;
      setMessage(result.message || successMessage);
      try { await load(controller.signal); } catch { setError('Операция выполнена, но список не удалось обновить. Нажмите «Обновить».'); }
      if (controller.signal.aborted) {
        setMessage('Текущая операция сохранена. Дальнейшая отправка остановлена.');
        return { ...result, cancelledAfterSave: true };
      }
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось выполнить операцию.');
      return null;
    } finally {
      init.signal?.removeEventListener('abort', cancel);
      mutationController.current = null;
      busyRef.current = false;
      setBusy(false);
    }
  }

  const displayedAudience = mode === 'manage' ? audience : overview?.mode === 'view' ? overview.audience : audience;

  return (
    <main className={`${adminStyles.page} ${styles.dashboardPage}`}>
      <div className={adminStyles.topbar}>
        <div><p>Панель управления</p><h1>{own ? 'Мой личный дашборд МР' : displayedAudience ? MANAGER_DASHBOARD_TITLES[displayedAudience] : mode === 'manage' ? 'Дашборды менеджеров' : 'Личный дашборд'}</h1></div>
        <div className={adminStyles.topbarActions}>
          {own ? <Link className={styles.secondary} href={ownReturn === 'team' ? '/admin/manager-dashboard?view=team&audience=development' : '/admin/manager-dashboard?audience=development'}>{ownReturn === 'team' ? 'Отчёты менеджеров МР' : 'Управление дашбордами МР'}</Link>
            : canViewOwn ? <Link className={styles.secondary} href="/admin/manager-dashboard?view=personal&audience=development">Мой личный отчёт</Link> : null}
          <Link className={styles.secondary} href="/admin/top">К списку отчётов</Link>
          <button className={styles.secondary} type="button" disabled={loading || busy} onClick={() => void refresh()}>{loading ? 'Обновляем…' : 'Обновить'}</button>
        </div>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {message ? <p className={styles.notice} role="status">{message}</p> : null}
      {updateAvailable ? <div className={styles.notice} role="status">
        <p>Доступна новая версия дашборда или данных. Обновите отчёт, когда будете готовы. Для зашифрованного .ktsp пароль потребуется ввести снова.</p>
        <button className={styles.secondary} type="button" disabled={loading || busy} onClick={() => void refresh()}>Открыть обновление</button>
      </div> : null}
      {busy ? <p className={styles.muted} role="status">Выполняем операцию… <button type="button" className={styles.secondary} onClick={cancelMutation}>Прервать ожидание</button></p> : null}
      {loading && !overview ? <section className={styles.panel} aria-busy="true"><p>Загружаем дашборд…</p></section> : null}
      {!own && overview?.mode === 'manage' ? <ManagerDashboardManagement key={audience ?? 'all'} audience={audience} overview={overview} canAssignAccess={canAssignAccess} busy={busy || loading} mutate={mutate} onReload={refresh} onAccessDenied={() => {
        requestRevision.current += 1;
        setOverview(null);
        router.replace('/admin');
      }} /> : null}
      {overview?.mode === 'view' ? <ManagerDashboardViewer key={`${own ? 'own' : 'manager'}:${overview.audience}`} own={own} overview={overview} loading={loading} onReload={refresh} /> : null}
    </main>
  );
}
