import styles from './layout.module.scss';
import CatalogSidebar from '@/widgets/catalog/Sidebar/CatalogSidebar';
import { ReactNode } from 'react';
import Container from '@/shared/ui/Container';

export default function CatalogLayout({ children }: { children: ReactNode }) {
  return (
    <Container>
      <div className={styles.catalogLayout}>
        <aside className={styles.sidebar}>
          <CatalogSidebar />
        </aside>
        <main className={styles.content}>{children}</main>
      </div>
    </Container>
  );
}
