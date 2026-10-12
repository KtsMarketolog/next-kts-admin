'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import adminStyles from '@/app/admin/admin.module.scss';
import { formatDashboardTimestamp } from '@/shared/lib/dashboardDates';
import { DashboardFrame, formatDashboardDate, isSnapshotExpired, SnapshotStatus } from './ManagerDashboardParts';
import type { ManagerDashboardBindingStatus, ManagerDashboardHtmlVersion, ManagerDashboardSnapshot } from './types';
import styles from './ManagerDashboard.module.scss';

type ReviewOverview = {
  managers: Array<{ id: number; name: string; email: string }>;
  htmlVersion: Pick<ManagerDashboardHtmlVersion, 'id' | 'originalName' | 'audience' | 'firstPublishedAt'> | null;
  selected: null | {
    managerId: number; name: string; email: string; bindingStatus: ManagerDashboardBindingStatus;
    snapshot: ManagerDashboardSnapshot | null; history: ManagerDashboardSnapshot[];
  };
};

/** Separate reader: no management component, mutation callback or MS data. */
export function ManagerDashboardReview() {
  const router = useRouter();
  const [managerId, setManagerId] = useState<number | null>(null);
  const [overview, setOverview] = useState<ReviewOverview | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let pending = false;
    async function load(visible = false) {
      if (pending) return;
      pending = true;
      if (visible) setLoading(true);
      try {
        const response = await fetch(`/api/admin/manager-dashboard/review${managerId ? `?manager=${managerId}` : ''}`, {
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        });
        const data = await response.json();
        if (disposed) return;
        if (response.status === 401 || response.status === 403) {
          setOverview(null);
          router.replace('/admin');
          return;
        }
        if (!response.ok) {
          if (response.status === 404) { setOverview(null); setManagerId(null); }
          throw new Error(typeof data?.error === 'string' ? data.error : 'Не удалось загрузить отчёты МР.');
        }
        setOverview(data as ReviewOverview);
        setError('');
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить отчёты МР.');
      } finally {
        pending = false;
        if (!disposed) setLoading(false);
      }
    }
    void load(true);
    const check = () => { if (document.visibilityState !== 'hidden') void load(); };
    const interval = window.setInterval(check, 60_000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [managerId, revision, router]);

  const selected = overview?.selected?.managerId === managerId ? overview.selected : null;
  const identity = selected ? JSON.stringify([selected.managerId, selected.email, selected.bindingStatus]) : '';
  return (
    <main className={`${adminStyles.page} ${styles.dashboardPage}`}>
      <div className={adminStyles.topbar}>
        <div><p>Панель управления</p><h1>Дашборды МР</h1></div>
        <div className={adminStyles.topbarActions}>
          <Link className={styles.secondary} href="/admin/top">К списку отчётов</Link>
          <button className={styles.secondary} type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>{loading ? 'Обновляем…' : 'Обновить'}</button>
        </div>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <section className={styles.panel} aria-busy={loading}>
        <div className={styles.sectionHeading}><div><h2>Отчёты менеджеров по развитию</h2><p>Выберите менеджера для просмотра. Для открытия данных нужен пароль его снимка.</p></div></div>
        <div className={styles.actions}>
          <label className={styles.inlineLabel} htmlFor="mr-review-manager">Менеджер</label>
          <select id="mr-review-manager" value={managerId ?? ''} disabled={loading && !overview} onChange={(event) => {
            setOverview((current) => current ? { ...current, selected: null } : null);
            setError('');
            setManagerId(event.target.value ? Number(event.target.value) : null);
          }}>
            <option value="">Выберите менеджера</option>
            {overview?.managers.map((manager) => <option key={manager.id} value={manager.id}>{manager.name || manager.email || `Менеджер №${manager.id}`}</option>)}
          </select>
        </div>
        {!loading && overview && !overview.managers.length ? <p className={styles.empty}>Нет активных менеджеров с доступом к отчётам МР.</p> : null}
      </section>
      {selected ? <ReviewReport key={identity} selected={selected} htmlVersion={overview!.htmlVersion} revision={revision} /> : null}
    </main>
  );
}

function ReviewReport({ selected, htmlVersion, revision }: {
  selected: NonNullable<ReviewOverview['selected']>; htmlVersion: ReviewOverview['htmlVersion']; revision: number;
}) {
  const [historyId, setHistoryId] = useState<number | null>(null);
  const snapshot = selected.history.find((item) => item.id === historyId) ?? selected.snapshot;
  const expired = snapshot && isSnapshotExpired(snapshot.expires);
  return <div className={styles.stack}>
    <section className={styles.panel}>
      <div className={styles.sectionHeading}><div><h2>{selected.name || 'Личный отчёт МР'}</h2><p>{selected.email || 'Email не указан'}</p></div><SnapshotStatus snapshot={snapshot} /></div>
      {selected.bindingStatus === 'missing_email' ? <p className={styles.warning}>У менеджера не указан email для привязки личного снимка.</p>
        : selected.bindingStatus === 'ambiguous_email' ? <p className={styles.warning}>Email указан у нескольких менеджеров. Личный снимок недоступен до уточнения привязки.</p> : null}
      {snapshot ? <>
        <dl className={styles.metadata}>
          <div><dt>Файл</dt><dd>{snapshot.originalName}</dd></div>
          <div><dt>Данные на</dt><dd>{formatDashboardDate(snapshot.issued)}</dd></div>
          <div><dt>Данные загружены</dt><dd>{formatDashboardTimestamp(snapshot.receivedAt)}</dd></div>
          <div><dt>Доступ до, МСК</dt><dd>{formatDashboardDate(snapshot.expires)}</dd></div>
        </dl>
        <p className={expired ? styles.warning : styles.notice}>{expired ? 'Срок действия снимка истёк. Для просмотра данных нужен свежий файл.' : 'Введите пароль снимка внутри дашборда. Это пароль файла, а не учётной записи.'}</p>
      </> : <p className={styles.empty}>Личный снимок ещё не доступен.</p>}
      {selected.history.some((item) => item.id !== selected.snapshot?.id) ? <div className={styles.actions}>
        <label className={styles.inlineLabel} htmlFor="mr-review-history">Версия данных</label>
        <select id="mr-review-history" value={selected.history.some((item) => item.id === historyId) ? historyId! : ''} onChange={(event) => setHistoryId(event.target.value ? Number(event.target.value) : null)}>
          <option value="">Текущий файл</option>
          {selected.history.filter((item) => item.id !== selected.snapshot?.id).map((item) => <option key={item.id} value={item.id}>{formatDashboardDate(item.issued)} — {item.originalName}</option>)}
        </select>
      </div> : null}
    </section>
    <section className={styles.panel}>
      <h2>Личный дашборд</h2>
      {htmlVersion ? <DashboardFrame reviewManagerId={selected.managerId} audience="development" versionId={htmlVersion.id} snapshotId={snapshot?.id} revision={revision} />
        : <p className={styles.empty}>HTML дашборда МР ещё не опубликован.</p>}
    </section>
  </div>;
}
