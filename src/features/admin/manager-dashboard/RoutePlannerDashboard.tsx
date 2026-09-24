'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import adminStyles from '@/app/admin/admin.module.scss';

import { ManagerDashboardManagement } from './ManagerDashboardManagement';
import { RoutePlannerViewer } from './ManagerDashboardViewer';
import type { ManagerDashboardMutationResult, RoutePlannerOverview } from './types';
import styles from './ManagerDashboard.module.scss';

const API_PATH = '/api/admin/manager-dashboard/shared';

function reportIdentity(overview: RoutePlannerOverview) {
  const shared = overview.supportShared;
  return JSON.stringify([shared?.activeHtmlVersionId, shared?.snapshot?.id, shared?.jsonSnapshot?.id]);
}

export function RoutePlannerDashboard({ mode }: { mode: 'manage' | 'view' }) {
  const router = useRouter();
  const [overview, setOverview] = useState<RoutePlannerOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const revision = useRef(0);
  const mutating = useRef(false);

  const read = useCallback(async (response: Response) => {
    if (response.status === 401 || response.status === 403) {
      revision.current += 1;
      setOverview(null);
      router.replace('/admin/top');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || 'Не удалось выполнить запрос.');
    if (!data || typeof data !== 'object') throw new Error('Сервер вернул некорректный ответ.');
    return data;
  }, [router]);

  const load = useCallback(async () => {
    const current = ++revision.current;
    setLoading(true);
    try {
      const next = await read(await fetch(API_PATH, {cache: 'no-store', credentials: 'same-origin'})) as RoutePlannerOverview;
      if (next.mode !== mode) throw new Error('Права доступа изменились. Откройте раздел заново.');
      if (revision.current === current) {
        setOverview(next);
        setUpdateAvailable(false);
      }
    } finally {
      if (revision.current === current) setLoading(false);
    }
  }, [mode, read]);

  useEffect(() => {
    void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Не удалось открыть компоновщик.'));
    return () => { revision.current += 1; };
  }, [load]);

  useEffect(() => {
    if (overview?.mode !== 'view') return;
    const controller = new AbortController();
    let checking = false;
    const check = async () => {
      if (checking || document.visibilityState === 'hidden') return;
      checking = true;
      try {
        const next = await read(await fetch(API_PATH, {cache: 'no-store', credentials: 'same-origin', signal: controller.signal})) as RoutePlannerOverview;
        if (!controller.signal.aborted) setUpdateAvailable(reportIdentity(next) !== reportIdentity(overview));
      } catch { /* A temporary network error must not interrupt the open report. */ }
      finally { checking = false; }
    };
    const onFocus = () => { void check(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const timer = window.setInterval(onFocus, 60_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [overview, read]);

  async function refresh() {
    setError('');
    try { await load(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось обновить отчёт.'); return false; }
  }

  async function mutate(path: string, init: RequestInit, successMessage: string): Promise<ManagerDashboardMutationResult | null> {
    if (mutating.current || !path.startsWith('/shared/')) return null;
    mutating.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await read(await fetch(`/api/admin/manager-dashboard${path}`, {...init, credentials: 'same-origin'})) as ManagerDashboardMutationResult;
      setMessage(result.message || successMessage);
      try { await load(); } catch { setError('Операция выполнена, но список не удалось обновить. Нажмите «Обновить».'); }
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось выполнить операцию.');
      return null;
    } finally { mutating.current = false; setBusy(false); }
  }

  return <main className={`${adminStyles.page} ${styles.dashboardPage}`}>
    <div className={adminStyles.topbar}>
      <div><p>HTML-страницы и отчёты</p><h1>Компоновщик рейсов</h1></div>
      <div className={adminStyles.topbarActions}>
        <Link className={styles.secondary} href="/admin/top">К списку отчётов</Link>
        <button className={styles.secondary} type="button" disabled={loading || busy} onClick={() => void refresh()}>{loading ? 'Обновляем…' : 'Обновить'}</button>
      </div>
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {message ? <p className={styles.notice} role="status">{message}</p> : null}
    {updateAvailable ? <div className={styles.notice} role="status"><p>Опубликовано обновление компоновщика или его данных.</p><button className={styles.secondary} disabled={loading || busy} type="button" onClick={() => void refresh()}>Открыть обновление</button></div> : null}
    {loading && !overview ? <section className={styles.panel} aria-busy="true"><p>Загружаем компоновщик…</p></section> : null}
    {overview?.mode === 'manage' ? <ManagerDashboardManagement section="shared" overview={overview} busy={busy || loading} mutate={mutate} /> : null}
    {overview?.mode === 'view' ? <RoutePlannerViewer shared={overview.supportShared} loading={loading} onReload={refresh} /> : null}
  </main>;
}
