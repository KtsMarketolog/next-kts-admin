'use client';

import styles from '@/app/admin/admin.module.scss';

type AdminDashboardProps = {
  canAccessSite: boolean;
  onOpenSiteSettings: () => void;
  onOpenWholesale: () => void;
};

export function AdminDashboard({ canAccessSite, onOpenSiteSettings, onOpenWholesale }: AdminDashboardProps) {
  return (
    <section className={styles.dashboardGrid} aria-label="Разделы панели управления">
      {canAccessSite ? (
        <article className={styles.dashboardCard}>
          <div>
            <h2>Управление сайтом</h2>
            <p>Контент главной страницы, контакты, слайдер, новости, бренды и группа компаний.</p>
          </div>
          <button onClick={onOpenSiteSettings}>Открыть</button>
        </article>
      ) : null}

      <article className={styles.dashboardCard}>
        <div>
          <h2>Индивидуальные прайсы</h2>
          <p>Отдельная база товаров для прайсов, индивидуальные цены, публичные ссылки и PDF.</p>
        </div>
        <button onClick={onOpenWholesale}>Открыть</button>
      </article>
    </section>
  );
}
