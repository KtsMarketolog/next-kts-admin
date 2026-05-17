import type { AdminSection } from '@/features/admin/types';

import { SITE_NAV_ITEMS } from './adminPanelConfig';
import styles from './admin.module.scss';

type AdminSiteSidebarProps = {
  activeSection: AdminSection;
  onSwitchSection: (section: AdminSection) => void;
};

export function AdminSiteSidebar({ activeSection, onSwitchSection }: AdminSiteSidebarProps) {
  return (
    <aside className={styles.analyticsSidebar}>
      <div className={styles.analyticsSidebarHeader}>
        <span>Дашборд</span>
        <strong>Разделы</strong>
      </div>
      <nav className={styles.analyticsSideNav} aria-label="Разделы управления сайтом">
        {SITE_NAV_ITEMS.map((item) => (
          <button
            key={item.value}
            className={activeSection === item.value ? styles.analyticsSideNavActive : styles.analyticsSideNavItem}
            type="button"
            onClick={() => onSwitchSection(item.value)}
          >
            <span>{item.label}</span>
            <small>{item.description}</small>
          </button>
        ))}
      </nav>
    </aside>
  );
}

