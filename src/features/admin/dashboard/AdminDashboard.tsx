'use client';

import styles from '@/app/admin/admin.module.scss';

type AdminDashboardProps = {
  canAccessSite: boolean;
  canAccessTopDashboard: boolean;
  isTopUser: boolean;
  onOpenSiteSettings: () => void;
  onOpenTopDashboard: () => void;
  onOpenWholesale: () => void;
  onOpenClients: () => void;
  onOpenAnalogs: () => void;
};

export function AdminDashboard({
  canAccessSite,
  canAccessTopDashboard,
  isTopUser,
  onOpenSiteSettings,
  onOpenTopDashboard,
  onOpenWholesale,
  onOpenClients,
  onOpenAnalogs,
}: AdminDashboardProps) {
  if (isTopUser) {
    return (
      <section
        className={`${styles.dashboardGrid} ${styles.dashboardGridSingle}`}
        aria-label="Разделы панели управления"
      >
        <article className={styles.dashboardCard}>
          <div>
            <h2>Стратегический обзор</h2>
            <p>Загрузка, предпросмотр, публикация, история версий и откат HTML-дашборда.</p>
          </div>
          <button onClick={onOpenTopDashboard}>Открыть</button>
        </article>
      </section>
    );
  }

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

      {canAccessTopDashboard ? (
        <article className={styles.dashboardCard}>
          <div>
            <h2>Стратегический обзор</h2>
            <p>Загрузка, предпросмотр, публикация, история версий и откат HTML-дашборда.</p>
          </div>
          <button onClick={onOpenTopDashboard}>Открыть</button>
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
          <p>Компании клиентов, личные кабинеты, документы, заявки и чат с менеджером.</p>
        </div>
        <button onClick={onOpenClients}>Открыть</button>
      </article>

      <article className={styles.dashboardCard}>
        <div>
          <h2>Аналоги</h2>
          <p>Подбор замены оборудования по модели, артикулу или названию.</p>
        </div>
        <button onClick={onOpenAnalogs}>Открыть</button>
      </article>
    </section>
  );
}
