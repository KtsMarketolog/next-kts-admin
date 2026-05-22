import styles from './layout.module.scss';
import dynamic from 'next/dynamic';
import { ReactNode } from 'react';
import Container from '@/shared/ui/Container';
import { CatalogSidebarSkeleton } from '@/widgets/catalog/Sidebar/CatalogSidebarSkeleton';

const CatalogSidebar = dynamic(() => import('@/widgets/catalog/Sidebar/CatalogSidebar'), {
  loading: () => <CatalogSidebarSkeleton />,
});

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
