'use client';

import { useEffect, useRef, useState } from 'react';
import { adminRequest } from '../shared/adminRequest';
import styles from './dashboard-usage.module.scss';

/** Cancel on filter/tab change; a late response must not download the wrong selection. */
export function UsageExport({ url, disabled }: { url: string; disabled: boolean }) {
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => () => controller.current?.abort(), []);
  const download = async () => {
    if (controller.current) return;
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError('');
    try {
      const response = await adminRequest(url, { credentials: 'same-origin', signal: current.signal }, { timeoutMs: 30_000 });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || 'Не удалось выгрузить журнал');
      }
      if (!response.headers.get('content-type')?.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) throw new Error('Сервер не вернул Excel-файл. Обновите страницу и повторите.');
      const blob = await response.blob();
      if (current.signal.aborted) return;
      const objectUrl = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = objectUrl; link.download = `journal-${new URL(url, location.origin).searchParams.get('view')}.xlsx`;
      document.body.append(link); link.click(); link.remove();
      // WebKit may consume the blob after the click handler has returned.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (cause) {
      if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось выгрузить журнал');
    } finally { if (!current.signal.aborted) { controller.current = null; setBusy(false); } }
  };
  return <div className={styles.exportArea}>
    <button className={styles.primaryButton} type="button" disabled={disabled || busy} onClick={() => void download()}>{busy ? 'Готовим Excel…' : 'Выгрузить в Excel'}</button>
    <span className={styles.notice}>Вся выбранная вкладка по фильтрам, не только страница. До 5 000 строк.</span>
    {error && <p className={styles.error} role="alert">{error}</p>}
  </div>;
}
