'use client';

import Link from 'next/link';

import styles from '@/app/admin/admin.module.scss';

const interactiveCardClassName = `${styles.dashboardCard} ${styles.dashboardCardInteractive}`;

type AdminDashboardProps = {
  canAccessSite: boolean;
  canAccessTopDashboard: boolean;
  isTopUser: boolean;
  wholesaleHref: '/admin/wholesale/admin' | '/admin/wholesale/manager';
};

export function AdminDashboard({
  canAccessSite,
  canAccessTopDashboard,
  isTopUser,
  wholesaleHref,
}: AdminDashboardProps) {
  if (isTopUser) {
    return (
      <section
        className={`${styles.dashboardGrid} ${styles.dashboardGridSingle}`}
        aria-label="Разделы панели управления"
      >
        <Link className={interactiveCardClassName} href="/admin/top" replace scroll={false}>
          <div>
            <h2>HTML-страницы и отчёты</h2>
            <p>Отдельные блоки с HTML-дашбордами, загрузкой, предпросмотром и историей версий.</p>
          </div>
          <span className={styles.dashboardCardLink}>Открыть</span>
        </Link>
      </section>
    );
  }

  return (
    <section className={styles.dashboardGrid} aria-label="Разделы панели управления">
      {canAccessSite ? (
        <Link className={interactiveCardClassName} href="/admin/site" replace scroll={false}>
          <div>
            <h2>Управление сайтом</h2>
            <p>Контент главной страницы, контакты, слайдер, новости, бренды и группа компаний.</p>
          </div>
          <span className={styles.dashboardCardLink}>Открыть</span>
        </Link>
      ) : null}

      {canAccessTopDashboard ? (
        <Link className={interactiveCardClassName} href="/admin/top" replace scroll={false}>
          <div>
            <h2>HTML-страницы и отчёты</h2>
            <p>Отдельные блоки с HTML-дашбордами, загрузкой, предпросмотром и историей версий.</p>
          </div>
          <span className={styles.dashboardCardLink}>Открыть</span>
        </Link>
      ) : null}

      <Link className={interactiveCardClassName} href={wholesaleHref} replace scroll={false}>
        <div>
          <h2>Индивидуальные прайсы</h2>
          <p>Отдельная база товаров для прайсов, индивидуальные цены, публичные ссылки и PDF.</p>
        </div>
        <span className={styles.dashboardCardLink}>Открыть</span>
      </Link>

      <Link className={interactiveCardClassName} href="/admin/clients" replace scroll={false}>
        <div>
          <h2>Клиенты</h2>
          <p>Компании клиентов, личные кабинеты, документы, заявки и чат с менеджером.</p>
        </div>
        <span className={styles.dashboardCardLink}>Открыть</span>
      </Link>

      <Link className={interactiveCardClassName} href="/admin/analogs" replace scroll={false}>
        <div>
          <h2>Аналоги</h2>
          <p>Подбор замены оборудования по модели, артикулу или названию.</p>
        </div>
        <span className={styles.dashboardCardLink}>Открыть</span>
      </Link>
    </section>
  );
}
