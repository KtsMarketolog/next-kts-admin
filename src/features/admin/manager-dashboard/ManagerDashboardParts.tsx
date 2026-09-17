import { useState } from 'react';

import { useTopDashboardDownloadBridge } from '@/features/admin/top-dashboard/useTopDashboardDownloadBridge';
import type { PersonalDashboardAudience } from '@/shared/lib/managerDashboardAudience';

import type { ManagerDashboardImport, ManagerDashboardSnapshot, ManagerDashboardSnapshotStatus } from './types';
import styles from './ManagerDashboard.module.scss';

export function formatDashboardDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('ru-RU', {
      dateStyle: 'short', ...(/^\d{4}-\d{2}-\d{2}$/.test(value) ? {} : { timeStyle: 'short' as const }), timeZone: 'Europe/Moscow',
    }).format(date)
    : '—';
}

export function isSnapshotExpired(expires: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
    return expires < today;
  }
  return Date.parse(expires) <= Date.now();
}

export function SnapshotStatus({
  snapshot, status, expectedIssuedAfter,
}: {
  snapshot: ManagerDashboardSnapshot | null;
  status?: ManagerDashboardSnapshotStatus;
  expectedIssuedAfter?: string | null;
}) {
  const resolved = !snapshot ? 'missing' : status
    ?? (isSnapshotExpired(snapshot.expires) ? 'expired'
      : expectedIssuedAfter && Date.parse(snapshot.issued) < Date.parse(expectedIssuedAfter) ? 'stale' : 'current');
  const label = {
    current: 'Данные получены',
    missing: 'Данные ещё не поступили',
    stale: 'Ожидается свежий файл',
    expired: 'Срок доступа истёк',
  }[resolved];
  return <span className={styles.badge} data-status={resolved}>{label}</span>;
}

const IMPORT_STATUS_LABELS: Record<string, string> = {
  imported: 'Загружен',
  activated: 'Опубликован',
  accepted: 'Принят',
  duplicate: 'Уже загружен',
  skipped: 'Пропущен',
  rejected: 'Отклонён',
  error: 'Ошибка',
  quarantined: 'Нужна проверка',
  outdated: 'Более старый файл',
  stale: 'Более старый файл',
  failed: 'Ошибка',
  unknown: 'Менеджер не найден',
  ambiguous: 'Неоднозначный получатель',
  expired: 'Срок доступа истёк',
  conflict: 'Нужна проверка',
  invalid: 'Некорректный файл',
  quota: 'Лимит хранения',
};

export function ImportResults({ results, title }: { results: ManagerDashboardImport[]; title: string }) {
  if (results.length === 0) return null;
  return (
    <div className={styles.results} aria-live="polite">
      <h3>{title}</h3>
      <ul>
        {results.map((result, index) => (
          <li key={result.id ?? `${result.originalName}:${index}`}>
            <div><strong>{result.originalName || 'Импорт файла'}</strong><span>{IMPORT_STATUS_LABELS[result.status] ?? result.status}</span></div>
            {result.message ? <p>{result.message}</p> : null}
            {result.receivedAt || result.createdAt ? <small>{formatDashboardDate(result.receivedAt ?? result.createdAt)} МСК</small> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DashboardFrame({
  versionId, snapshotId, preview = false, revision = 0, audience = 'development',
}: {
  versionId: number;
  snapshotId?: number;
  preview?: boolean;
  revision?: number;
  audience?: PersonalDashboardAudience;
}) {
  const [downloadStatus, setDownloadStatus] = useState('');
  const frameRef = useTopDashboardDownloadBridge(setDownloadStatus);
  const params = new URLSearchParams({ version: String(versionId), revision: String(revision), audience });
  if (snapshotId) params.set('snapshot', String(snapshotId));
  if (preview) params.set('preview', '1');
  return (
    <>
      {downloadStatus ? <p className={styles.notice} role="status">{downloadStatus}</p> : null}
      <iframe
        ref={frameRef}
        className={styles.frame}
        key={params.toString()}
        src={`/api/admin/manager-dashboard/frame?${params.toString()}`}
        title={preview ? 'Предпросмотр HTML личного дашборда' : 'Личный дашборд менеджера'}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="same-origin"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; fullscreen *"
        allowFullScreen
      />
    </>
  );
}

export function SharedDashboardFrame({
  versionId, snapshotId, preview = false, revision = 0,
}: {
  versionId: number;
  snapshotId?: number;
  preview?: boolean;
  revision?: number;
}) {
  const [downloadStatus, setDownloadStatus] = useState('');
  const frameRef = useTopDashboardDownloadBridge(setDownloadStatus);
  const params = new URLSearchParams({ version: String(versionId), revision: String(revision) });
  if (snapshotId && !preview) params.set('snapshot', String(snapshotId));
  if (preview) params.set('preview', '1');
  return (
    <>
      {downloadStatus ? <p className={styles.notice} role="status">{downloadStatus}</p> : null}
      <iframe
        ref={frameRef}
        className={styles.frame}
        key={params.toString()}
        src={`/api/admin/manager-dashboard/shared/frame?${params.toString()}`}
        title={preview ? 'Предпросмотр HTML общего дашборда' : 'Общий дашборд сопровождения'}
        sandbox="allow-scripts allow-same-origin allow-modals"
        referrerPolicy="same-origin"
        allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; fullscreen *"
        allowFullScreen
      />
    </>
  );
}
