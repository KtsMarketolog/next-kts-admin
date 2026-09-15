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

  const load = useCallback(async () => {
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
        setOverview(next);
        setUpdateAvailable(false);
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
          if (managerDashboardViewIdentity(next) !== managerDashboardViewIdentity(overview)) {
            // A changed role/audience, recipient or binding clears the decrypted report.
            setOverview(next);
            setUpdateAvailable(false);
            return;
          }
          setUpdateAvailable(next.htmlVersion?.id !== overview.htmlVersion?.id || next.snapshot?.id !== overview.snapshot?.id);
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
    <main className={adminStyles.page}>
      <div className={adminStyles.topbar}>
        <div><p>Панель управления</p><h1>{mode === 'manage' ? 'Дашборды менеджеров' : 'Личный дашборд'}</h1></div>
        <div className={adminStyles.topbarActions}>
          <Link className={styles.secondary} href="/admin">В панель управления</Link>
          <button className={styles.secondary} type="button" disabled={loading || busy} onClick={() => void refresh()}>{loading ? 'Обновляем…' : 'Обновить'}</button>
        </div>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {message ? <p className={styles.notice} role="status">{message}</p> : null}
      {updateAvailable ? <div className={styles.notice} role="status">
        <p>Доступна новая версия дашборда или личных данных. Обновите отчёт, когда будете готовы; пароль снимка потребуется ввести снова.</p>
        <button className={styles.secondary} type="button" disabled={loading || busy} onClick={() => void refresh()}>Открыть обновление</button>
      </div> : null}
      {busy ? <p className={styles.muted} role="status">Выполняем операцию…</p> : null}
      {loading && !overview ? <section className={styles.panel} aria-busy="true"><p>Загружаем дашборд…</p></section> : null}
      {overview?.mode === 'manage' ? <ManagerDashboardManagement overview={overview} busy={busy || loading} mutate={mutate} onAccessDenied={() => {
        requestRevision.current += 1;
        setOverview(null);
        router.replace('/admin');
      }} /> : null}
      {overview?.mode === 'view' ? <ManagerDashboardViewer key={managerDashboardViewIdentity(overview)} overview={overview} loading={loading} onReload={refresh} /> : null}
    </main>
  );
}
