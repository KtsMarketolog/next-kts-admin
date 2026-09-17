'use client';

import Link from 'next/link';

import styles from '@/app/admin/admin.module.scss';
import { MANAGER_DASHBOARD_TITLES, type PersonalDashboardAudience } from '@/shared/lib/managerDashboardAudience';

const interactiveCardClassName = `${styles.dashboardCard} ${styles.dashboardCardInteractive}`;

type AdminDashboardProps = {
  canAccessSite: boolean;
  topDashboardMode: 'manage' | 'view' | null;
  managerDashboardMode: 'manage' | 'view' | null;
  managerDashboardAudience?: PersonalDashboardAudience | null;
  isTopAreaOnlyUser: boolean;
  wholesaleHref: '/admin/wholesale/admin' | '/admin/wholesale/manager';
};

export function AdminDashboard({
  canAccessSite,
  topDashboardMode,
  managerDashboardMode,
  managerDashboardAudience = null,
  isTopAreaOnlyUser,
  wholesaleHref,
}: AdminDashboardProps) {
  const isTopDashboardManager = topDashboardMode === 'manage';
  const managerDashboardAudiences: PersonalDashboardAudience[] = managerDashboardMode === 'manage'
    ? ['development', 'support']
    : managerDashboardMode === 'view' && managerDashboardAudience
      ? [managerDashboardAudience]
      : [];
  const managerDashboardCards = managerDashboardAudiences.map((audience) => (
    <Link
      key={audience}
      className={interactiveCardClassName}
      href={`/admin/manager-dashboard?audience=${audience}`}
      replace
      scroll={false}
    >
      <div>
        <h2>{MANAGER_DASHBOARD_TITLES[audience]}</h2>
        <p>{audience === 'development'
          ? managerDashboardMode === 'manage'
            ? 'HTML-дашборды менеджеров развития, личные данные и журнал загрузки.'
            : 'Ваш персональный отчёт с автоматически загруженными данными.'
          : managerDashboardMode === 'manage'
            ? 'Личные и общие дашборды менеджеров сопровождения, данные и журнал загрузки.'
            : 'Ваш личный и общие дашборды менеджеров сопровождения.'}</p>
      </div>
      <span className={styles.dashboardCardLink}>Открыть</span>
    </Link>
  ));

  if (isTopAreaOnlyUser) {
    return (
      <section
        className={`${styles.dashboardGrid} ${managerDashboardCards.length ? '' : styles.dashboardGridSingle}`}
        aria-label="Разделы панели управления"
      >
        <Link className={interactiveCardClassName} href="/admin/top" replace scroll={false}>
          <div>
            <h2>{isTopDashboardManager ? 'HTML-страницы и отчёты' : 'Готовые отчёты'}</h2>
            <p>
              {isTopDashboardManager
                ? 'Управление HTML-дашбордами, данными и опубликованными версиями.'
                : 'Готовые дашборды с актуальными данными для просмотра результатов бизнеса.'}
            </p>
          </div>
          <span className={styles.dashboardCardLink}>Открыть</span>
        </Link>
        {managerDashboardCards}
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

      {topDashboardMode ? (
        <Link className={interactiveCardClassName} href="/admin/top" replace scroll={false}>
          <div>
            <h2>{isTopDashboardManager ? 'HTML-страницы и отчёты' : 'Готовые отчёты'}</h2>
            <p>
              {isTopDashboardManager
                ? 'Отдельные блоки с HTML-дашбордами, загрузкой, предпросмотром и историей версий.'
                : 'Опубликованные дашборды с актуальными данными в защищённом режиме.'}
            </p>
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
      {managerDashboardCards}
    </section>
  );
}
