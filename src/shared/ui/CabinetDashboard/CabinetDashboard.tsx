'use client';

import type { ReactNode } from 'react';

import styles from './CabinetDashboard.module.scss';

export type CabinetDashboardItem = {
  value: string;
  label: string;
  description: string;
  badge?: ReactNode;
};

type CabinetDashboardProps = {
  activeValue: string;
  ariaLabel: string;
  children: ReactNode;
  headerAside?: ReactNode;
  items: CabinetDashboardItem[];
  onSelect: (value: string) => void;
  sidebarLabel: string;
};

export function CabinetDashboard({
  activeValue,
  ariaLabel,
  children,
  headerAside,
  items,
  onSelect,
  sidebarLabel,
}: CabinetDashboardProps) {
  const activeItem = items.find((item) => item.value === activeValue) ?? items[0];

  return (
    <div className={styles.dashboardLayout}>
      <aside className={styles.sidebar} aria-label={ariaLabel}>
        <div className={styles.sidebarHeader}>
          <span>{sidebarLabel}</span>
          <strong>Разделы</strong>
        </div>
        <nav className={styles.sideNav}>
          {items.map((item) => (
            <button
              className={activeValue === item.value ? styles.sideNavActive : styles.sideNavItem}
              key={item.value}
              type="button"
              onClick={() => onSelect(item.value)}
            >
              <span>
                {item.label}
                {item.badge}
              </span>
              <small>{item.description}</small>
            </button>
          ))}
        </nav>
      </aside>

      <section className={styles.content}>
        <div className={styles.contentHeader}>
          <div>
            <span>Раздел</span>
            <h2>{activeItem.label}</h2>
            <p>{activeItem.description}</p>
          </div>
          {headerAside}
        </div>
        <div className={styles.contentBody}>{children}</div>
      </section>
    </div>
  );
}
