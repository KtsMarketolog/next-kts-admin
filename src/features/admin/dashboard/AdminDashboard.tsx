'use client';

import styles from '@/app/admin/admin.module.scss';

type AdminDashboardProps = {
  canAccessSite: boolean;
  onOpenSiteSettings: () => void;
  onOpenWholesale: () => void;
  onOpenClients: () => void;
};

export function AdminDashboard({ canAccessSite, onOpenSiteSettings, onOpenWholesale, onOpenClients }: AdminDashboardProps) {
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

      <article className={styles.dashboardCard}>
        <div>
          <h2>Клиенты</h2>
          <p>Компании клиентов для будущего личного кабинета, документов, истории заявок и чата.</p>
        </div>
        <button onClick={onOpenClients}>Открыть</button>
      </article>
    </section>
  );
}
