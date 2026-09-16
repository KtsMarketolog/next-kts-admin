'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import adminStyles from '@/app/admin/admin.module.scss';

import { ManagerDashboardManagement } from './ManagerDashboardManagement';
import { ManagerDashboardViewer, managerDashboardViewIdentity } from './ManagerDashboardViewer';
import type { ManagerDashboardMutationResult, ManagerDashboardOverview } from './types';
import styles from './ManagerDashboard.module.scss';

const API_PATH = '/api/admin/manager-dashboard';

function reportVersionsChanged(next: Extract<ManagerDashboardOverview, { mode: 'view' }>, current: Extract<ManagerDashboardOverview, { mode: 'view' }>) {
  return next.htmlVersion?.id !== current.htmlVersion?.id || next.snapshot?.id !== current.snapshot?.id
    || next.supportShared?.activeHtmlVersionId !== current.supportShared?.activeHtmlVersionId
    || next.supportShared?.snapshot?.id !== current.supportShared?.snapshot?.id;
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

export function ManagerDashboard({ mode }: { mode: 'manage' | 'view' }) {
  const router = useRouter();
  const [overview, setOverview] = useState<ManagerDashboardOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const requestRevision = useRef(0);
  const busyRef = useRef(false);

  const load = useCallback(async (report?: 'personal' | 'shared', previous?: ManagerDashboardOverview | null) => {
    const revision = ++requestRevision.current;
    setLoading(true);
    try {
      const response = await fetch(API_PATH, { cache: 'no-store', credentials: 'same-origin' });
      if (response.status === 401 || response.status === 403) {
        setOverview(null);
        router.replace('/admin');
      }
      const next = await readResponse(response) as ManagerDashboardOverview;
      if (next.mode !== mode) throw new Error('Права доступа изменились. Откройте раздел заново.');
      if (revision === requestRevision.current) {
        let updated = next;
        if (previous?.mode === 'view' && next.mode === 'view' && previous.audience === 'support' && next.audience === 'support') {
          if (report === 'shared' && managerDashboardViewIdentity(previous) === managerDashboardViewIdentity(next)) {
            updated = { ...previous, supportShared: next.supportShared };
          } else if (report === 'personal') {
            updated = { ...next, supportShared: previous.supportShared };
          }
        }
        setOverview(updated);
        setUpdateAvailable(next.mode === 'view' && updated.mode === 'view' && reportVersionsChanged(next, updated));
      }
    } finally {
      if (revision === requestRevision.current) setLoading(false);
    }
  }, [mode, router]);

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
        const response = await fetch(API_PATH, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (disposed) return;
        if (response.status === 401 || response.status === 403) {
          setOverview(null);
          router.replace('/admin');
          return;
        }
        const next = await readResponse(response) as ManagerDashboardOverview;
        if (!disposed && next.mode === 'view') {
          const sharedChanged = next.supportShared?.activeHtmlVersionId !== overview.supportShared?.activeHtmlVersionId
            || next.supportShared?.snapshot?.id !== overview.supportShared?.snapshot?.id;
          if (managerDashboardViewIdentity(next) !== managerDashboardViewIdentity(overview)) {
            // Clear personal data immediately when its recipient changes. A support
            // manager's open shared report keeps its own explicit refresh boundary.
            const keepShared = next.audience === 'support' && overview.audience === 'support';
            setOverview(keepShared ? { ...next, supportShared: overview.supportShared } : next);
            setUpdateAvailable(keepShared && sharedChanged);
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
  }, [overview, router]);

  async function refresh(report?: 'personal' | 'shared') {
    setError('');
    try {
      await load(report, overview);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось обновить данные.');
      return false;
    }
  }

  async function mutate(path: string, init: RequestInit, successMessage: string): Promise<ManagerDashboardMutationResult | null> {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await fetch(`${API_PATH}${path}`, { ...init, credentials: 'same-origin' });
      if (response.status === 401 || response.status === 403) {
        setOverview(null);
        router.replace('/admin');
      }
      const result = await readResponse(response) as ManagerDashboardMutationResult;
      setMessage(result.message || successMessage);
      try { await load(); } catch { setError('Операция выполнена, но список не удалось обновить. Нажмите «Обновить».'); }
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось выполнить операцию.');
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <main className={`${adminStyles.page} ${styles.dashboardPage}`}>
      <div className={adminStyles.topbar}>
        <div><p>Панель управления</p><h1>{mode === 'manage' ? 'Дашборды менеджеров' : overview?.mode === 'view' && overview.audience === 'support' ? 'Дашборды' : 'Личный дашборд'}</h1></div>
        <div className={adminStyles.topbarActions}>
          <Link className={styles.secondary} href="/admin">В панель управления</Link>
          <button className={styles.secondary} type="button" disabled={loading || busy} onClick={() => void refresh()}>{loading ? 'Обновляем…' : 'Обновить'}</button>
        </div>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {message ? <p className={styles.notice} role="status">{message}</p> : null}
      {updateAvailable ? <div className={styles.notice} role="status">
        <p>Доступна новая версия дашборда или данных. Обновите отчёт, когда будете готовы; пароль снимка потребуется ввести снова.</p>
        <button className={styles.secondary} type="button" disabled={loading || busy} onClick={() => void refresh()}>Открыть обновление</button>
      </div> : null}
      {busy ? <p className={styles.muted} role="status">Выполняем операцию…</p> : null}
      {loading && !overview ? <section className={styles.panel} aria-busy="true"><p>Загружаем дашборд…</p></section> : null}
      {overview?.mode === 'manage' ? <ManagerDashboardManagement overview={overview} busy={busy || loading} mutate={mutate} onAccessDenied={() => {
        requestRevision.current += 1;
        setOverview(null);
        router.replace('/admin');
      }} /> : null}
      {overview?.mode === 'view' ? <ManagerDashboardViewer key={overview.audience} overview={overview} loading={loading} onReload={refresh} /> : null}
    </main>
  );
}
