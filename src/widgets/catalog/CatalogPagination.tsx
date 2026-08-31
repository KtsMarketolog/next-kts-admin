import Link from 'next/link';

import { catalogPagePath } from '@/entities/catalog/api/catalogSeo';
import styles from './CatalogPagination.module.scss';

type Props = {
  basePath: string;
  currentPage: number;
  totalPages: number;
};

export function CatalogPagination({ basePath, currentPage, totalPages }: Props) {
  if (totalPages <= 1) return null;

  const previousPath = currentPage > 1 ? catalogPagePath(basePath, currentPage - 1) : null;
  const nextPath = currentPage < totalPages ? catalogPagePath(basePath, currentPage + 1) : null;

  return (
    <nav className={styles.pagination} aria-label="Страницы каталога">
      {previousPath ? (
        <Link className={styles.link} href={previousPath} rel="prev">
          Назад
        </Link>
      ) : (
        <span className={`${styles.link} ${styles.disabled}`} aria-hidden="true">
          Назад
        </span>
      )}

      <span className={styles.status}>
        Страница {currentPage} из {totalPages}
      </span>

      {nextPath ? (
        <Link className={styles.link} href={nextPath} rel="next">
          Вперёд
        </Link>
      ) : (
        <span className={`${styles.link} ${styles.disabled}`} aria-hidden="true">
          Вперёд
        </span>
      )}
    </nav>
  );
}
