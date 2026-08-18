'use client';

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { CabinetDashboard } from '@/shared/ui/CabinetDashboard/CabinetDashboard';

const SECTIONS = [
  { value: 'prices', label: 'Прайсы', description: 'Индивидуальные прайсы' },
];

type WholesaleManagerDashboardProps = {
  priceContent: ReactNode;
  priceCount: number;
};

export function WholesaleManagerDashboard({ priceContent, priceCount }: WholesaleManagerDashboardProps) {
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
      headerAside={<strong>{priceCount} прайсов</strong>}
      items={SECTIONS}
      onSelect={() => {}}
      sidebarLabel="Кабинет менеджера"
    >
      {priceContent}
    </CabinetDashboard>
  );
}
