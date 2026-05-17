import type { AdminArea } from './adminPanelConfig';
import styles from './admin.module.scss';

type AdminTopbarProps = {
  activeArea: AdminArea;
  pageTitle: string;
  onBackToHome: () => void;
  onLogout: () => Promise<void>;
};

export function AdminTopbar({ activeArea, pageTitle, onBackToHome, onLogout }: AdminTopbarProps) {
  return (
    <div className={styles.topbar}>
      <div>
        <p>Панель управления</p>
        <h1>{pageTitle}</h1>
      </div>
      <div className={styles.topbarActions}>
        {activeArea === 'site' && (
          <button className={styles.secondary} onClick={onBackToHome}>
            Вернуться в панель управления
          </button>
        )}
        <button className={styles.secondary} onClick={onLogout}>
          Выйти
        </button>
      </div>
    </div>
  );
}

