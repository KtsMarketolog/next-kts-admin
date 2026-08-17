'use client';

import type { ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { AnalogFinder } from '@/features/analogs/AnalogFinder';

import styles from './WholesaleManagerDashboard.module.scss';

type ManagerSection = 'prices' | 'analogs';

const SECTIONS: Array<{ value: ManagerSection; label: string; description: string }> = [
  { value: 'prices', label: 'Прайсы', description: 'Индивидуальные прайсы' },
  { value: 'analogs', label: 'Аналоги', description: 'Подбор замены оборудования' },
];

type WholesaleManagerDashboardProps = {
  priceContent: ReactNode;
};

export function WholesaleManagerDashboard({ priceContent }: WholesaleManagerDashboardProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSection: ManagerSection = searchParams.get('view') === 'analogs' ? 'analogs' : 'prices';

  const selectSection = (section: ManagerSection) => {
    const params = new URLSearchParams(searchParams.toString());
    if (section === 'prices') {
      params.delete('view');
    } else {
      params.set('view', section);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <div className={styles.dashboardLayout}>
      <aside className={styles.sidebar} aria-label="Разделы кабинета менеджера">
        <div className={styles.sidebarHeader}>
          <span>Кабинет менеджера</span>
          <strong>Разделы</strong>
        </div>
        <nav className={styles.sideNav}>
          {SECTIONS.map((section) => (
            <button
              className={activeSection === section.value ? styles.sideNavActive : styles.sideNavItem}
              key={section.value}
              type="button"
              onClick={() => selectSection(section.value)}
            >
              <span>{section.label}</span>
              <small>{section.description}</small>
            </button>
          ))}
        </nav>
      </aside>

      <section className={styles.content}>
        {activeSection === 'prices' ? (
          priceContent
        ) : (
          <>
            <div className={styles.contentHeader}>
              <span>Раздел</span>
              <h2>Аналоги</h2>
              <p>Подбор замены оборудования</p>
            </div>
            <AnalogFinder />
          </>
        )}
      </section>
    </div>
  );
}
