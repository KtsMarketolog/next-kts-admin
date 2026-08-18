'use client';

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import styles from '@/app/admin/admin.module.scss';
import { CabinetDashboard } from '@/shared/ui/CabinetDashboard/CabinetDashboard';

const SECTIONS = [
  { value: 'prices', label: 'Прайсы', description: 'Индивидуальные прайсы' },
];

type WholesaleManagerDashboardProps = {
  onBack: () => void;
  priceContent: ReactNode;
  priceCount: number;
};

export function WholesaleManagerDashboard({ onBack, priceContent, priceCount }: WholesaleManagerDashboardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get('view') === 'analogs') {
      router.replace('/admin/analogs', { scroll: false });
    }
  }, [router, searchParams]);

  return (
    <CabinetDashboard
      activeValue="prices"
      ariaLabel="Разделы кабинета менеджера"
      headerAside={(
        <div className={styles.topbarActions}>
          <button className={styles.secondary} type="button" onClick={onBack}>
            Вернуться в панель управления
          </button>
          <strong className={styles.dashboardHeaderCount}>{priceCount} прайсов</strong>
        </div>
      )}
      items={SECTIONS}
      onSelect={() => {}}
      sidebarLabel="Кабинет менеджера"
    >
      {priceContent}
    </CabinetDashboard>
  );
}
