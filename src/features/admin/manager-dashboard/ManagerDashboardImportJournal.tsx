import { useEffect, useRef, useState } from 'react';

import { isPersonalDashboardImportCursor, PERSONAL_DASHBOARD_IMPORT_PAGE_SIZE } from '@/shared/lib/managerDashboardImportPagination';

import { ImportResults } from './ManagerDashboardParts';
import type { ManagerDashboardImport } from './types';
import styles from './ManagerDashboard.module.scss';

type JournalProps = {
  imports: ManagerDashboardImport[];
  nextCursor: string | null;
  busy: boolean;
  onAccessDenied?: () => void;
};

function isImportId(value: unknown): boolean {
  return typeof value === 'number' ? Number.isSafeInteger(value) && value > 0
    : isPersonalDashboardImportCursor(value);
}

function isPage(value: unknown): value is { imports: ManagerDashboardImport[]; nextCursor: string | null } {
  if (!value || typeof value !== 'object' || !('imports' in value) || !('nextCursor' in value)) return false;
  return Array.isArray(value.imports) && value.imports.length <= PERSONAL_DASHBOARD_IMPORT_PAGE_SIZE && value.imports.every((row: unknown) =>
    !!row && typeof row === 'object' && 'id' in row && isImportId(row.id)
    && 'originalName' in row && typeof row.originalName === 'string' && 'status' in row && typeof row.status === 'string')
    && (value.nextCursor === null || (typeof value.nextCursor === 'string' && isImportId(value.nextCursor) && value.imports.length > 0));
}

// Parent keys this component by the initial page. A refreshed first page starts
// a new journal session and aborts any pending request from the old one.
export function ManagerDashboardImportJournal({ imports, nextCursor: initialCursor, busy, onAccessDenied }: JournalProps) {
  const [rows, setRows] = useState(imports);
  const [nextCursor, setNextCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, []);

  async function loadMore() {
    if (busy || loading || request.current || !nextCursor) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/admin/manager-dashboard/imports?before=${encodeURIComponent(nextCursor)}`, {
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (response.status === 401 || response.status === 403) {
        setRows([]);
        setNextCursor(null);
        setError('Доступ к журналу истёк. Войдите в кабинет заново.');
        onAccessDenied?.();
        return;
      }
      if (!response.ok) throw new Error('IMPORT_PAGE_FAILED');
      const page: unknown = await response.json();
      if (controller.signal.aborted) return;
      if (!isPage(page) || (page.nextCursor !== null && BigInt(page.nextCursor) >= BigInt(nextCursor))) {
        throw new Error('INVALID_IMPORT_PAGE');
      }
      setRows((previous) => {
        const known = new Set(previous.map((row) => String(row.id)));
        return [...previous, ...page.imports.filter((row) => {
          const id = String(row.id);
          if (known.has(id)) return false;
          known.add(id);
          return true;
        })];
      });
      setNextCursor(page.nextCursor);
    } catch {
      if (!controller.signal.aborted) setError('Не удалось загрузить записи. Нажмите «Показать ещё», чтобы повторить.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (request.current === controller) request.current = null;
    }
  }

  return (
    <section id="manager-dashboard-import-journal" className={styles.panel} aria-labelledby="manager-dashboard-import-heading" aria-busy={loading}>
      <h2 id="manager-dashboard-import-heading">Журнал импорта</h2>
      {rows.length === 0 && !error ? <p className={styles.empty}>Загрузок пока не было.</p> : <ImportResults results={rows} title="Последние файлы" />}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {nextCursor ? <div className={styles.journalActions}>
        <button className={styles.secondary} type="button" disabled={busy || loading} onClick={() => void loadMore()}>{loading ? 'Загружаем…' : 'Показать ещё'}</button>
      </div> : null}
    </section>
  );
}
