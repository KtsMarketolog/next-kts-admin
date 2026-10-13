import type { UsagePagePosition } from './usage-journal-shared';
import styles from './dashboard-usage.module.scss';

export function UsagePagination({ pages, nextCursor, busy, count, onChange }: {
  pages: UsagePagePosition; nextCursor?: string | null; busy: boolean; count?: number;
  onChange: (pages: UsagePagePosition) => void;
}) {
  return <nav className={styles.pagination} aria-label="Страницы результатов">
    <span aria-live="polite">Страница {pages.length}{count !== undefined ? ` · записей: ${count}` : ''}</span>
    <div>
      <button type="button" disabled={busy || pages.length === 1} onClick={() => onChange(pages.slice(0, -1))}>Назад</button>
      <button type="button" disabled={busy || !nextCursor} onClick={() => nextCursor && onChange([...pages, nextCursor])}>Далее</button>
    </div>
  </nav>;
}
